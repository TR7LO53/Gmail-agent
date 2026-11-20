import type { DB } from "../memory/db.js";
import {
  getLatestAutomaticHoldingsSnapshot,
  isRealDate,
  saveHoldingsSnapshot,
  type HoldingsWarning,
} from "../memory/holdings.js";
import { logEvent } from "../memory/logs.js";
import { getMeta, setMeta } from "../memory/meta.js";
import {
  archiveUrl,
  findAggregateBtc,
  findCoverShares,
  htmlToText,
  submissionsUrl,
  toPostSplitShares,
  type CoverShares,
} from "./edgar-parse.js";
import type { FetchImpl } from "./yahoo.js";

/**
 * Automatic Holdings Snapshot reader for Strategy (CIK 0001050446), straight from SEC EDGAR.
 *
 * Sources:
 *  - BTC held: the 8-K weekly statement ("Aggregate BTC Holdings"). The snapshot date is the
 *    statement's "as of" date, not the filing date (the 8-K filed Monday describes the Sunday before).
 *  - Shares outstanding: class A + class B from the cover page of the latest 10-Q / 10-K (basic,
 *    not diluted). The XBRL `dei` route (`EntityCommonStockSharesOutstanding`) returns 404 for this
 *    company, so the cover page text is read instead, exactly as the history builder does.
 *
 * Carry-forward rule: a snapshot takes the shares of the latest cover page whose "as of" date is on
 * or before the snapshot's BTC date — never a later one (see `sharesOnDate`). Share counts dated
 * before the 2024-08-08 split are scaled by the parser; a new split would need `toPostSplitShares`
 * extended, otherwise Strategy Premium would be off.
 *
 * SEC fair access: the User-Agent comes from the caller (SEC_USER_AGENT, never hard-coded and never
 * logged), requests go one at a time with a short pause, and a pass runs at most once every 6 hours.
 * The "last check" time is stored before the first request, so two tabs opened together start one
 * pass, and a failed pass (or a missing User-Agent) is not retried on every tab open.
 *
 * A failed pass writes no snapshot: every document is fetched and parsed, every reading validated,
 * and only then saved. Failures are logged to Activity and returned, never thrown. Only readings
 * newer than the latest automatic snapshot are saved, and a rejected reading (the sanity check from
 * `saveHoldingsSnapshot`) stops the pass so its warning is not cleared by a later save.
 *
 * Known gap: if Strategy changes the table heading, the "Aggregate BTC Holdings" marker disappears
 * and such an 8-K is skipped quietly like any other 8-K. The "holdings are stale" warning (14 days)
 * is the safety net for that.
 */

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type SecErrorCategory = "http" | "timeout" | "transport" | "protocol" | "parse" | "internal";

export class SecError extends Error {
  constructor(
    readonly category: SecErrorCategory,
    message: string,
    readonly details: { url?: string; status?: number } = {},
  ) {
    super(message);
    this.name = "SecError";
  }
}

export interface HoldingsReaderOptions {
  db: DB;
  /** Required: the app passes `fetch`, tests pass a fake, so a test can never reach the network. */
  fetchImpl: FetchImpl;
  /** Required: the app passes `readEnv("SEC_USER_AGENT")`. Empty or undefined → no request is made. */
  userAgent: string | undefined;
  now?: () => Date;
  /** Pause between two requests; the default keeps well below SEC's 10 requests per second. */
  pauseMs?: number;
}

export type HoldingsReaderResult =
  | { status: "throttled"; lastCheck: string }
  | { status: "no_user_agent" }
  | { status: "failed"; category: SecErrorCategory; message: string }
  | { status: "up_to_date" }
  | { status: "updated"; saved: string[]; skippedManual: string[]; rejected?: HoldingsWarning };

export type CoverReading = Omit<CoverShares, "excerpt">;

const LAST_CHECK_KEY = "markets_sec_last_check";
const COVER_CACHE_KEY = "markets_sec_cover";
const FIRST_RUN_LOOKBACK_DAYS = 30;
const MAX_EIGHT_KS = 20;
const MAX_COVER_FILINGS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TABLE_MARKER = /Aggregate\s+BTC\s+Holdings/i;

/** The latest cover page dated on or before `date`; a later cover page is never used. */
export function sharesOnDate(covers: readonly CoverReading[], date: string): CoverReading | undefined {
  let best: CoverReading | undefined;
  for (const cover of covers) {
    if (cover.as_of <= date && (!best || cover.as_of > best.as_of)) best = cover;
  }
  return best;
}

interface Filing {
  form: string;
  filed: string;
  accession: string;
  primaryDocument: string;
}

interface Reading {
  date: string;
  btc_held: number;
}

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseSubmissions(body: string): Filing[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new SecError("protocol", "SEC submissions list is not valid JSON.", { url: submissionsUrl() });
  }
  const filings = (payload as { filings?: { recent?: Record<string, unknown> } } | null)?.filings;
  const recent = filings?.recent;
  const form = recent?.form;
  const filed = recent?.filingDate;
  const accession = recent?.accessionNumber;
  const primary = recent?.primaryDocument;
  if (!isStringArray(form) || !isStringArray(filed) || !isStringArray(accession) || !isStringArray(primary)) {
    throw new SecError("protocol", "SEC submissions list has an unexpected shape.", { url: submissionsUrl() });
  }
  if (filed.length !== form.length || accession.length !== form.length || primary.length !== form.length) {
    throw new SecError("protocol", "SEC submissions list columns differ in length.", { url: submissionsUrl() });
  }
  return form.map((name, i) => ({ form: name, filed: filed[i], accession: accession[i], primaryDocument: primary[i] }));
}

function parseExhibitNames(body: string, url: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new SecError("protocol", "SEC filing index is not valid JSON.", { url });
  }
  const items = (payload as { directory?: { item?: unknown } } | null)?.directory?.item;
  if (!Array.isArray(items)) throw new SecError("protocol", "SEC filing index has an unexpected shape.", { url });
  return items
    .map((item) => (item as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string" && /ex-?99.*\.htm$/i.test(name));
}

function parseCachedCover(value: string | undefined): (CoverReading & { accession: string }) | undefined {
  if (!value) return undefined;
  try {
    const cover = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof cover.accession === "string" &&
      typeof cover.as_of === "string" &&
      typeof cover.class_a === "number" &&
      typeof cover.class_b === "number"
    ) {
      return { accession: cover.accession, as_of: cover.as_of, class_a: cover.class_a, class_b: cover.class_b };
    }
  } catch {
    /* A damaged cache entry is the same as no entry. */
  }
  return undefined;
}

function assertValidReading(date: string, btcHeld: number, shares: number): void {
  if (!isRealDate(date)) throw new SecError("parse", `SEC statement has an invalid date: ${date}.`);
  if (!Number.isFinite(btcHeld) || btcHeld <= 0) {
    throw new SecError("parse", `SEC statement for ${date} has an invalid BTC count.`);
  }
  if (!Number.isSafeInteger(shares) || shares <= 0) {
    throw new SecError("parse", `Share count for ${date} is not a positive whole number.`);
  }
}

/**
 * Reads new weekly BTC holdings from SEC EDGAR and saves them as automatic Holdings Snapshots.
 * Never throws; see the module comment for the rules.
 */
export async function refreshHoldingsFromSec(options: HoldingsReaderOptions): Promise<HoldingsReaderResult> {
  const { db, fetchImpl, userAgent } = options;
  const now = (options.now ?? (() => new Date()))();
  const pauseMs = options.pauseMs ?? 200;

  const lastCheck = getMeta(db, LAST_CHECK_KEY);
  const lastCheckMs = lastCheck ? Date.parse(lastCheck) : Number.NaN;
  const sinceLast = now.getTime() - lastCheckMs;
  if (lastCheck && sinceLast >= 0 && sinceLast < CHECK_INTERVAL_MS) return { status: "throttled", lastCheck };
  // Before the first await: a second caller in the same process now sees the throttle.
  setMeta(db, LAST_CHECK_KEY, now.toISOString());

  if (!userAgent || !userAgent.trim()) {
    logEvent(db, {
      source: "markets",
      level: "warn",
      message: "SEC_USER_AGENT is not set; Strategy holdings are not updated automatically.",
    });
    return { status: "no_user_agent" };
  }

  let requests = 0;
  async function getText(url: string): Promise<string> {
    if (requests > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    requests += 1;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": userAgent as string, Accept: "*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new SecError("timeout", `SEC request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`, { url });
      }
      throw new SecError("transport", `SEC request failed: ${error instanceof Error ? error.message : "unknown error"}.`, { url });
    }
    if (!response.ok) {
      throw new SecError("http", `SEC answered HTTP ${response.status}.`, { url, status: response.status });
    }
    try {
      return await response.text();
    } catch (error) {
      if (isTimeout(error)) throw new SecError("timeout", `SEC response timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`, { url });
      throw new SecError("transport", `SEC response could not be read: ${error instanceof Error ? error.message : "unknown error"}.`, { url });
    }
  }

  try {
    const latestAutomatic = getLatestAutomaticHoldingsSnapshot(db);
    const cutoff =
      latestAutomatic?.date ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);

    const filings = parseSubmissions(await getText(submissionsUrl()));
    let eightKs = filings
      .filter((f) => f.form === "8-K" && f.filed >= cutoff && f.primaryDocument)
      .sort((a, b) => a.filed.localeCompare(b.filed) || a.accession.localeCompare(b.accession));
    if (eightKs.length > MAX_EIGHT_KS) {
      logEvent(db, {
        source: "markets",
        message: `SEC holdings: ${eightKs.length} new 8-K filings; reading only the newest ${MAX_EIGHT_KS}.`,
      });
      eightKs = eightKs.slice(-MAX_EIGHT_KS);
    }

    // One reading per "as of" date; the later filing wins.
    const readings = new Map<string, Reading>();
    for (const filing of eightKs) {
      const mainUrl = archiveUrl(filing.accession, filing.primaryDocument);
      let text = htmlToText(await getText(mainUrl));
      let found = findAggregateBtc(text);
      // A holdings table that yields no reading means the layout changed: fail, don't skip.
      const tableWithoutReading = () => {
        throw new SecError("parse", `8-K ${filing.accession} has a holdings table but no reading could be parsed.`, { url: mainUrl });
      };
      if (found.length === 0 && TABLE_MARKER.test(text)) tableWithoutReading();
      if (found.length === 0) {
        // Earnings 8-Ks only point at their press release (Exhibit 99.1).
        const indexUrl = archiveUrl(filing.accession, "index.json");
        for (const name of parseExhibitNames(await getText(indexUrl), indexUrl)) {
          text += " " + htmlToText(await getText(archiveUrl(filing.accession, name)));
        }
        found = findAggregateBtc(text);
        if (found.length === 0 && TABLE_MARKER.test(text)) tableWithoutReading();
      }
      if (found.length === 0) continue; // Offerings, governance and similar: no holdings statement, not an error.
      for (const statement of found) {
        readings.set(statement.as_of, { date: statement.as_of, btc_held: statement.btc_held });
      }
    }

    const fresh = [...readings.values()]
      .filter((reading) => !latestAutomatic || reading.date > latestAutomatic.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (fresh.length === 0) return { status: "up_to_date" };

    // Shares: newest cover pages first, until one is dated on or before the earliest new reading.
    const periodic = filings
      .filter((f) => f.form === "10-Q" || f.form === "10-K")
      .sort((a, b) => b.filed.localeCompare(a.filed) || b.accession.localeCompare(a.accession))
      .slice(0, MAX_COVER_FILINGS);
    const covers: CoverReading[] = [];
    for (const [i, filing] of periodic.entries()) {
      const cached = i === 0 ? parseCachedCover(getMeta(db, COVER_CACHE_KEY)) : undefined;
      let cover: CoverReading;
      if (cached && cached.accession === filing.accession) {
        cover = cached;
      } else {
        const url = archiveUrl(filing.accession, filing.primaryDocument);
        const parsed: CoverShares | undefined = findCoverShares(htmlToText(await getText(url)));
        if (!parsed) {
          throw new SecError("parse", `${filing.form} ${filing.accession} has no readable class A + class B cover page.`, { url });
        }
        cover = { as_of: parsed.as_of, class_a: parsed.class_a, class_b: parsed.class_b };
        if (i === 0) {
          setMeta(db, COVER_CACHE_KEY, JSON.stringify({ accession: filing.accession, ...cover }));
        }
      }
      covers.push(cover);
      if (cover.as_of <= fresh[0].date) break;
    }

    // Validate everything before saving anything: a bad row must not leave a half-written pass.
    const rows = fresh.map((reading) => {
      const cover = sharesOnDate(covers, reading.date);
      if (!cover) throw new SecError("parse", `No cover page with share counts dated on or before ${reading.date}.`);
      const shares = toPostSplitShares(cover.class_a + cover.class_b, cover.as_of).value;
      assertValidReading(reading.date, reading.btc_held, shares);
      return { date: reading.date, btc_held: reading.btc_held, shares_outstanding: shares };
    });

    const saved: string[] = [];
    const skippedManual: string[] = [];
    let rejected: HoldingsWarning | undefined;
    for (const row of rows) {
      const result = saveHoldingsSnapshot(db, { ...row, source: "automatic" });
      if (result.status === "saved") saved.push(row.date);
      else if (result.status === "skipped_manual") skippedManual.push(row.date);
      else {
        // A later successful save would clear the warning before anyone saw it.
        rejected = result.warning;
        break;
      }
    }
    if (saved.length > 0) {
      logEvent(db, {
        source: "markets",
        message: `SEC holdings: saved ${saved.join(", ")}.`,
        data: { saved, skippedManual },
      });
    }
    return { status: "updated", saved, skippedManual, ...(rejected ? { rejected } : {}) };
  } catch (error) {
    const failure =
      error instanceof SecError
        ? error
        : new SecError("internal", `Unexpected error: ${error instanceof Error ? error.message : "unknown error"}.`);
    try {
      logEvent(db, {
        source: "markets",
        level: "error",
        message: `SEC holdings update failed (${failure.category}): ${failure.message}`,
        data: { category: failure.category, ...failure.details },
      });
    } catch {
      /* Logging trouble must not turn a returned failure into a thrown one. */
    }
    return { status: "failed", category: failure.category, message: failure.message };
  }
}
