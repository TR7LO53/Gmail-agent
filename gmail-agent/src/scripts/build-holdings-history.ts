/**
 * Builds src/markets/data/holdings-history.json from SEC EDGAR (Strategy / MicroStrategy,
 * CIK 0001050446). Run by hand: `npm run build-holdings-history`. The app never runs this.
 *
 * - BTC held: 8-K statements of the AGGREGATE holding, dated by the "as of" date in the text.
 * - Shares outstanding: class A + class B from the cover page of the latest 10-Q / 10-K whose
 *   "as of" date is on or before the BTC date (carry-forward, never from the future).
 * - Shares are stored on the post-split scale (10-for-1 split effective 2024-08-08).
 *
 * SEC fair-access policy: every request sends the User-Agent from SEC_USER_AGENT (never hard-coded),
 * one request at a time with a short pause. Raw responses are cached outside the repo.
 */
import "../env.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "../env.js";
import {
  SPLIT_DATE,
  SPLIT_FACTOR,
  archiveUrl,
  findAggregateBtc,
  findCoverShares,
  htmlToText,
  parseCount,
  reportsBtcSales,
  submissionsUrl,
  toPostSplitShares,
  type BtcStatement,
} from "../markets/edgar-parse.js";

const BTC_FIRST_8K_DATE = "2020-08-01";
const PERIODIC_FROM_DATE = "2020-01-01";
const REQUEST_PAUSE_MS = 200;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(HERE, "../markets/data/holdings-history.json");
const CACHE_DIR = path.join(os.tmpdir(), "holdings-edgar-cache");

// ---------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------

let userAgent = "";
let lastRequestAt = 0;

async function fetchCached(url: string): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, createHash("sha1").update(url).digest("hex"));
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");

  const wait = lastRequestAt + REQUEST_PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "*/*" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`EDGAR ${response.status} for ${url}`);
  const body = await response.text();
  fs.writeFileSync(file, body);
  return body;
}

interface Filing {
  form: string;
  filed: string;
  accession: string;
  primaryDocument: string;
  reportDate: string;
}

interface SubmissionColumns {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
  reportDate: string[];
}

function filingsFrom(columns: SubmissionColumns): Filing[] {
  return columns.form.map((form, i) => ({
    form,
    filed: columns.filingDate[i],
    accession: columns.accessionNumber[i],
    primaryDocument: columns.primaryDocument[i],
    reportDate: columns.reportDate[i],
  }));
}

/** Both submissions files: `recent` (≈2021-11 → today) and the older archive file. */
async function listFilings(): Promise<Filing[]> {
  const recent = JSON.parse(
    await fetchCached(submissionsUrl()),
  ) as { filings: { recent: SubmissionColumns; files?: { name: string }[] } };
  const filings = filingsFrom(recent.filings.recent);
  for (const file of recent.filings.files ?? []) {
    const older = JSON.parse(
      await fetchCached(`https://data.sec.gov/submissions/${file.name}`),
    ) as SubmissionColumns;
    filings.push(...filingsFrom(older));
  }
  return filings;
}

function docUrl(filing: Filing, name: string): string {
  return archiveUrl(filing.accession, name);
}

/** Text of the main document plus (only if needed) its Exhibit 99 press releases. */
async function loadEightK(filing: Filing): Promise<{ text: string; parts: string[] }> {
  const main = htmlToText(await fetchCached(docUrl(filing, filing.primaryDocument)));
  const parts = [filing.primaryDocument];
  // Earnings 8-Ks only point at their press release (Exhibit 99.1), so exhibits are read for
  // every filing whose main document has no aggregate statement.
  if (findAggregateBtc(main).length > 0) return { text: main, parts };
  const index = JSON.parse(await fetchCached(docUrl(filing, "index.json"))) as {
    directory: { item: { name: string }[] };
  };
  let text = main;
  for (const item of index.directory.item) {
    if (!/ex-?99.*\.htm$/i.test(item.name)) continue;
    text += " " + htmlToText(await fetchCached(docUrl(filing, item.name)));
    parts.push(item.name);
  }
  return { text, parts };
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

interface BtcRow {
  date: string;
  btc_held: number;
  form: string;
  accession: string;
  filed: string;
  /** The filing contains a "BTC Sold" table, so a lower holding than before is explained. */
  sales?: boolean;
}

interface SharesRow {
  as_of: string;
  class_a: number;
  class_b: number;
  form: string;
  accession: string;
}

/**
 * Two early 8-Ks state the holding as a purchase total, not as "holds". Both were read by hand:
 * the first purchase (2020-08-11) is the whole holding, and the 2020-09-15 filing says "To date, the
 * Company has purchased a total of N bitcoins" about the purchase completed on 2020-09-14 (no
 * sales had been made). Only these two accessions may be read this way.
 */
const PURCHASE_TOTAL_AS_HOLDING: Record<string, { as_of: string; pattern: RegExp }> = {
  "0001193125-20-215604": {
    as_of: "2020-08-11",
    pattern: /has purchased (\d{1,3}(?:,\d{3})+|\d+) bitcoins/i,
  },
  "0001193125-20-245835": {
    as_of: "2020-09-14",
    pattern: /has purchased a total of (\d{1,3}(?:,\d{3})+|\d+) bitcoins/i,
  },
};

export interface SnapshotRecord {
  date: string;
  btc_held: number;
  shares_outstanding: number;
  btc_source: { form: string; accession: string; filed: string; sold?: true };
  shares_source: {
    form: string;
    accession: string;
    as_of: string;
    class_a: number;
    class_b: number;
    split_factor: number;
  };
}

/** One BTC row per "as of" date (latest filing wins), sorted by date; reports conflicts. */
export function mergeBtcRows(all: BtcRow[]): { rows: BtcRow[]; conflicts: string[] } {
  const byDate = new Map<string, BtcRow[]>();
  for (const row of all) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  const rows: BtcRow[] = [];
  const conflicts: string[] = [];
  for (const [date, list] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...list].sort((a, b) => a.filed.localeCompare(b.filed));
    const values = new Set(ordered.map((r) => r.btc_held));
    if (values.size > 1) {
      conflicts.push(
        `${date}: ${ordered.map((r) => `${r.btc_held} (${r.accession}, filed ${r.filed})`).join(" vs ")}`,
      );
    }
    rows.push(ordered[ordered.length - 1]);
  }
  return { rows, conflicts };
}

/** Joins BTC rows with the latest share count dated on or before each BTC date. */
export function joinSnapshots(rows: BtcRow[], shares: SharesRow[]): SnapshotRecord[] {
  const sorted = [...shares].sort((a, b) => a.as_of.localeCompare(b.as_of));
  const snapshots: SnapshotRecord[] = [];
  for (const row of rows) {
    const eligible = sorted.filter((s) => s.as_of <= row.date);
    const source = eligible[eligible.length - 1];
    if (!source) throw new Error(`No share count on or before ${row.date}`);
    const { value, factor } = toPostSplitShares(source.class_a + source.class_b, source.as_of);
    snapshots.push({
      date: row.date,
      btc_held: row.btc_held,
      shares_outstanding: value,
      btc_source: {
        form: row.form,
        accession: row.accession,
        filed: row.filed,
        ...(row.sales ? { sold: true as const } : {}),
      },
      shares_source: {
        form: source.form,
        accession: source.accession,
        as_of: source.as_of,
        class_a: source.class_a,
        class_b: source.class_b,
        split_factor: factor,
      },
    });
  }
  return snapshots;
}

async function main(): Promise<void> {
  const agent = readEnv("SEC_USER_AGENT");
  if (!agent) {
    console.error("SEC_USER_AGENT is not set. SEC requires a User-Agent with an app name and contact.");
    console.error("Set it in the environment or in gmail-agent/.env, e.g. SEC_USER_AGENT=Ggent you@example.com");
    process.exit(1);
  }
  userAgent = agent;

  const filings = await listFilings();
  const eightKs = filings
    .filter((f) => f.form === "8-K" && f.filed >= BTC_FIRST_8K_DATE)
    .sort((a, b) => a.filed.localeCompare(b.filed) || a.accession.localeCompare(b.accession));
  const periodic = filings
    .filter((f) => (f.form === "10-Q" || f.form === "10-K") && f.filed >= PERIODIC_FROM_DATE)
    .sort((a, b) => a.filed.localeCompare(b.filed));

  console.log(
    `Filings listed: ${filings.length}; 8-K since ${BTC_FIRST_8K_DATE}: ${eightKs.length}; 10-Q/10-K since ${PERIODIC_FROM_DATE}: ${periodic.length}`,
  );

  // Shares from cover pages.
  const shares: SharesRow[] = [];
  const problems: string[] = [];
  for (const filing of periodic) {
    const text = htmlToText(await fetchCached(docUrl(filing, filing.primaryDocument)));
    const cover = findCoverShares(text);
    if (!cover) {
      problems.push(`${filing.form} ${filing.filed} ${filing.accession}: no class A + class B cover sentence found`);
      continue;
    }
    shares.push({ ...cover, form: filing.form, accession: filing.accession });
  }

  // BTC held from 8-Ks.
  const statements: BtcRow[] = [];
  const skipped: string[] = [];
  let matched = 0;
  for (const filing of eightKs) {
    const { text, parts } = await loadEightK(filing);
    const found = findAggregateBtc(text);
    const exception = PURCHASE_TOTAL_AS_HOLDING[filing.accession];
    if (found.length === 0 && exception) {
      const m = exception.pattern.exec(text);
      if (m) found.push({ as_of: exception.as_of, btc_held: parseCount(m[1]), excerpt: m[0] });
    }
    if (found.length === 0) {
      const mentions = /bitcoin|\bBTC\b/i.test(text) ? " (mentions bitcoin)" : "";
      skipped.push(`${filing.filed} ${filing.accession} ${parts.join("+")}${mentions}`);
      continue;
    }
    matched += 1;
    for (const s of found) {
      statements.push({
        date: s.as_of,
        btc_held: s.btc_held,
        form: "8-K",
        accession: filing.accession,
        filed: filing.filed,
        sales: reportsBtcSales(text),
      });
    }
  }

  const { rows, conflicts } = mergeBtcRows(statements);

  // A drop between consecutive rows is only accepted when the filing itself reports BTC sales;
  // any other drop is a data problem, not something to patch over.
  const decreases: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].btc_held < rows[i - 1].btc_held && rows[i].sales) {
      decreases.push(
        `${rows[i - 1].date} ${rows[i - 1].btc_held} -> ${rows[i].date} ${rows[i].btc_held} (${rows[i].accession}, filing has a "BTC Sold" table)`,
      );
    } else if (rows[i].btc_held < rows[i - 1].btc_held) {
      problems.push(
        `BTC decreased: ${rows[i - 1].date} ${rows[i - 1].btc_held} (${rows[i - 1].accession}) -> ${rows[i].date} ${rows[i].btc_held} (${rows[i].accession})`,
      );
    }
  }
  if (!rows[0] || !rows[0].date.startsWith("2020-08")) {
    problems.push(`First BTC row is not in August 2020: ${rows[0]?.date ?? "none"}`);
  }

  console.log(`8-K matched: ${matched}; skipped: ${skipped.length}; BTC dates: ${rows.length}`);
  console.log(`Share counts read: ${shares.length}/${periodic.length}`);
  console.log("\nSkipped 8-Ks (no aggregate BTC statement found):");
  for (const line of skipped) console.log(`  ${line}`);
  console.log(`\nConflicts (same "as of" date, different numbers; latest filing used): ${conflicts.length}`);
  for (const line of conflicts) console.log(`  ${line}`);
  console.log(`\nDecreases explained by filed BTC sales: ${decreases.length}`);
  for (const line of decreases) console.log(`  ${line}`);
  console.log(`\nProblems: ${problems.length}`);
  for (const line of problems) console.log(`  ${line}`);

  if (problems.length > 0) {
    console.error("\nNot writing the seed: fix or explain the problems above first.");
    process.exit(2);
  }

  const snapshots = joinSnapshots(rows, shares);
  const output = {
    metadata: {
      built_at: new Date().toISOString(),
      source: "SEC EDGAR, CIK 0001050446 (Strategy / MicroStrategy)",
      method:
        "BTC held from 8-K 'as of' statements; shares = class A + class B from latest 10-Q/10-K cover page on or before the BTC date (carry-forward)",
      split: `${SPLIT_FACTOR}-for-1, effective ${SPLIT_DATE}; share counts dated before that are multiplied by ${SPLIT_FACTOR}`,
      script: "src/scripts/build-holdings-history.ts",
    },
    snapshots,
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(
    `\nWrote ${snapshots.length} snapshots (${snapshots[0].date} .. ${snapshots[snapshots.length - 1].date}) to ${OUTPUT_PATH}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
