import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveUrl, findAggregateBtc, findCoverShares, htmlToText, submissionsUrl } from "../../src/markets/edgar-parse.js";
import {
  CHECK_INTERVAL_MS,
  refreshHoldingsFromSec,
  sharesOnDate,
  type HoldingsReaderResult,
} from "../../src/markets/holdings-reader.js";
import { openDb, type DB } from "../../src/memory/db.js";
import {
  getPendingHoldingsWarning,
  listHoldingsSnapshots,
  saveHoldingsSnapshot,
} from "../../src/memory/holdings.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import { setMeta } from "../../src/memory/meta.js";

// Recorded EDGAR responses, see tests/fixtures/markets/sec/README.md.
const FIXTURES = new URL("../fixtures/markets/sec/", import.meta.url);
const readFixture = (name: string): string => fs.readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf8");

const SUBMISSIONS = readFixture("submissions-CIK0001050446.json");
const EIGHT_K_NOV_16 = readFixture("8k-0001193125-26-462151-mstr-20261116.htm");
const EIGHT_K_NOV_09 = readFixture("8k-0001193125-26-452693-mstr-20261109.htm");
const TEN_Q = readFixture("10q-0001050446-26-000060-mstr-20260930.htm");

const URL_SUBMISSIONS = submissionsUrl();
const URL_8K_NOV_16 = archiveUrl("0001193125-26-462151", "mstr-20261116.htm");
const URL_8K_NOV_09 = archiveUrl("0001193125-26-452693", "mstr-20261109.htm");
const URL_10Q = archiveUrl("0001050446-26-000060", "mstr-20260930.htm");

const URL_8K_AUG_10 = archiveUrl("0001193125-26-341297", "mstr-20260810.htm");
const URL_8K_AUG_17 = archiveUrl("0001193125-26-353240", "mstr-20260817.htm");
const EIGHT_K_AUG_17 = readFixture("8k-0001193125-26-353240-mstr-20260817.htm");

const USER_AGENT = "test-agent test@example.invalid";
const NOW = new Date("2026-11-20T15:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

interface Call {
  url: string;
  userAgent: string | undefined;
}

/** Fake EDGAR: URL → body; an unknown URL answers 404 so an unexpected request shows up at once. */
function fakeSec(overrides: Record<string, string | Response> = {}) {
  const responses: Record<string, string | Response> = {
    [URL_SUBMISSIONS]: SUBMISSIONS,
    [URL_8K_NOV_16]: EIGHT_K_NOV_16,
    [URL_8K_NOV_09]: EIGHT_K_NOV_09,
    [URL_10Q]: TEN_Q,
    ...overrides,
  };
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: (init?.headers as Record<string, string> | undefined)?.["User-Agent"] });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const body = responses[url];
      if (body === undefined) return new Response("", { status: 404 });
      return body instanceof Response ? body.clone() : new Response(body, { status: 200 });
    } finally {
      inFlight -= 1;
    }
  });
  return { fetchImpl, calls, urls: () => calls.map((call) => call.url), maxInFlight: () => maxInFlight };
}

function augustSec(through: string, overrides: Record<string, string> = {}) {
  const submissions = JSON.parse(SUBMISSIONS) as { filings: { recent: Record<string, string[]> } };
  const recent = submissions.filings.recent;
  const withinRange = recent.filingDate.map((date) => date <= through);
  for (const [key, values] of Object.entries(recent)) {
    recent[key] = values.filter((_, index) => withinRange[index]);
  }
  return fakeSec({
    [URL_SUBMISSIONS]: JSON.stringify(submissions),
    [archiveUrl("0001193125-26-329565", "mstr-20260803.htm")]: readFixture("8k-0001193125-26-329565-mstr-20260803.htm"),
    [URL_8K_AUG_10]: readFixture("8k-0001193125-26-341297-mstr-20260810.htm"),
    [URL_8K_AUG_17]: EIGHT_K_AUG_17,
    [archiveUrl("0001050446-26-000044", "mstr-20260630.htm")]: readFixture("10q-0001050446-26-000044-mstr-20260630.htm"),
    ...overrides,
  });
}

describe("automatic holdings reader (SEC EDGAR)", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(":memory:");
    // The seed ends at 2026-11-15 (850,849 BTC). Dropping that row leaves 2026-11-08 as the newest
    // automatic snapshot, so the 8-K filed 2026-11-16 holds the one new reading.
    db.prepare("DELETE FROM holdings_snapshots WHERE date = '2026-11-15'").run();
  });
  afterEach(() => db.close());

  const run = (sec: ReturnType<typeof fakeSec>, extra: { now?: Date; userAgent?: string | undefined } = {}) =>
    refreshHoldingsFromSec({
      db,
      fetchImpl: sec.fetchImpl,
      userAgent: "userAgent" in extra ? extra.userAgent : USER_AGENT,
      now: () => extra.now ?? NOW,
      pauseMs: 0,
    });
  const snapshot = (date: string) => listHoldingsSnapshots(db).find((row) => row.date === date);
  const logsAt = (level: string) => listRecentLogs(db, 100).filter((log) => log.level === level);

  describe("reading the filings", () => {
    it("reads BTC held and the as-of date from the 8-K table", () => {
      expect(findAggregateBtc(htmlToText(EIGHT_K_NOV_16))).toEqual(
        expect.arrayContaining([expect.objectContaining({ as_of: "2026-11-15", btc_held: 850849 })]),
      );
      expect(findAggregateBtc(htmlToText(EIGHT_K_NOV_09))).toEqual(
        expect.arrayContaining([expect.objectContaining({ as_of: "2026-11-08", btc_held: 850364 })]),
      );
    });

    it("reads class A + class B shares from the 10-Q cover page", () => {
      const cover = findCoverShares(htmlToText(TEN_Q));
      expect(cover).toMatchObject({ as_of: "2026-10-25", class_a: 402714357, class_b: 19640250 });
      expect((cover?.class_a ?? 0) + (cover?.class_b ?? 0)).toBe(422354607);
    });

    it("carries shares forward from the latest cover page on or before the date, never a later one", () => {
      const covers = [
        { as_of: "2026-07-25", class_a: 300, class_b: 20 },
        { as_of: "2026-10-25", class_a: 402714357, class_b: 19640250 },
      ];
      expect(sharesOnDate(covers, "2026-11-15")?.as_of).toBe("2026-10-25");
      expect(sharesOnDate(covers, "2026-10-25")?.as_of).toBe("2026-10-25");
      expect(sharesOnDate(covers, "2026-10-24")?.as_of).toBe("2026-07-25");
      expect(sharesOnDate(covers, "2026-07-24")).toBeUndefined();
    });
  });

  describe("a full pass", () => {
    it("saves the new reading with BTC from the 8-K and shares from the cover page", async () => {
      const sec = fakeSec();
      const result = await run(sec);

      expect(result).toEqual({ status: "updated", saved: ["2026-11-15"], skippedManual: [] });
      expect(snapshot("2026-11-15")).toMatchObject({
        btc_held: 850849,
        shares_outstanding: 422354607,
        source: "automatic",
      });
      expect(sec.urls()).toEqual([URL_SUBMISSIONS, URL_8K_NOV_09, URL_8K_NOV_16, URL_10Q]);
      expect(logsAt("info").map((log) => log.message)).toContain("SEC holdings: saved 2026-11-15.");
    });

    it("reports up to date, without downloading the 10-Q, when nothing is newer", async () => {
      db.prepare("INSERT OR REPLACE INTO holdings_snapshots (date, btc_held, shares_outstanding, source, created_at) VALUES ('2026-11-15', 850849, 422354607, 'automatic', '2026-11-16T00:00:00.000Z')").run();
      const before = listHoldingsSnapshots(db);
      const sec = fakeSec();

      expect(await run(sec)).toEqual({ status: "up_to_date" });
      expect(sec.urls()).not.toContain(URL_10Q);
      expect(listHoldingsSnapshots(db)).toEqual(before);
    });

    it("remembers the cover page so the 10-Q is downloaded only once", async () => {
      await run(fakeSec());
      db.prepare("DELETE FROM holdings_snapshots WHERE date = '2026-11-15'").run();
      const second = fakeSec();

      const result = await run(second, { now: new Date(NOW.getTime() + CHECK_INTERVAL_MS + HOUR_MS) });

      expect(result).toMatchObject({ status: "updated", saved: ["2026-11-15"] });
      expect(second.urls()).not.toContain(URL_10Q);
      expect(snapshot("2026-11-15")?.shares_outstanding).toBe(422354607);
    });

    it("sends the given User-Agent on every request and never overlaps requests", async () => {
      const sec = fakeSec();
      await run(sec);

      expect(sec.calls.length).toBeGreaterThan(1);
      expect(sec.calls.every((call) => call.userAgent === USER_AGENT)).toBe(true);
      expect(sec.maxInFlight()).toBe(1);
    });

    it("keeps the User-Agent out of the logs", async () => {
      await run(fakeSec());
      await run(fakeSec({ [URL_SUBMISSIONS]: new Response("", { status: 403 }) }), {
        now: new Date(NOW.getTime() + CHECK_INTERVAL_MS + HOUR_MS),
      });

      const text = JSON.stringify(listRecentLogs(db, 100));
      expect(text).not.toContain("test-agent");
      expect(text).not.toContain("example.invalid");
    });
  });

  describe("BTC sales", () => {
    const augustNow = new Date("2026-08-24T15:00:00.000Z");
    const acceptedDrops = () =>
      logsAt("info").filter((log) => log.source === "markets" && log.message.startsWith("Accepted BTC decrease"));

    beforeEach(() => {
      db.prepare("DELETE FROM holdings_snapshots WHERE date > ?").run("2026-08-02");
    });

    it("saves and logs a real sale with the shares from the preceding cover page", async () => {
      const result = await run(augustSec("2026-08-10"), { now: augustNow });

      expect(result).toEqual({ status: "updated", saved: ["2026-08-09"], skippedManual: [] });
      expect(snapshot("2026-08-09")).toMatchObject({
        btc_held: 840447,
        shares_outstanding: 384225751,
        source: "automatic",
      });
      expect(acceptedDrops()).toEqual([
        expect.objectContaining({
          message: "Accepted BTC decrease for 2026-08-09: 842138 BTC → 840447 BTC.",
          data: { date: "2026-08-09", previous_btc_held: 842138, btc_held: 840447 },
        }),
      ]);
      expect(getPendingHoldingsWarning(db)).toBeUndefined();
    });

    it("continues from a real sale to the next reading in the same pass", async () => {
      const result = await run(augustSec("2026-08-17"), { now: augustNow });

      expect(result).toEqual({ status: "updated", saved: ["2026-08-09", "2026-08-16"], skippedManual: [] });
      expect(snapshot("2026-08-09")?.btc_held).toBe(840447);
      expect(snapshot("2026-08-16")?.btc_held).toBe(840447);
      expect(acceptedDrops()).toEqual([expect.objectContaining({ data: expect.objectContaining({ date: "2026-08-09" }) })]);
    });

    it("clears an old rejection when the next pass confirms the sale", async () => {
      expect(saveHoldingsSnapshot(db, {
        date: "2026-08-09",
        btc_held: 840447,
        shares_outstanding: 384225751,
        source: "automatic",
      }).status).toBe("rejected");
      setMeta(db, "markets_sec_last_check", augustNow.toISOString());
      expect(getPendingHoldingsWarning(db)).toMatchObject({ date: "2026-08-09", reason: "btc_decreased" });
      expect(snapshot("2026-08-09")).toBeUndefined();

      const result = await run(augustSec("2026-08-10"), {
        now: new Date(augustNow.getTime() + CHECK_INTERVAL_MS + HOUR_MS),
      });

      expect(result).toEqual({ status: "updated", saved: ["2026-08-09"], skippedManual: [] });
      expect(snapshot("2026-08-09")?.btc_held).toBe(840447);
      expect(getPendingHoldingsWarning(db)).toBeUndefined();
      expect(acceptedDrops()).toHaveLength(1);
    });

    it("uses the main filing's sale signal with the holdings in Exhibit 99", async () => {
      const accession = "0001193125-26-341297";
      const exhibit = "ex99-1.htm";
      const result = await run(augustSec("2026-08-10", {
        [URL_8K_AUG_10]: "<p>BTC Sold</p>",
        [archiveUrl(accession, "index.json")]: JSON.stringify({ directory: { item: [{ name: exhibit }] } }),
        [archiveUrl(accession, exhibit)]: "<p>As of August 9, 2026, Strategy held 840,447 BTC.</p>",
      }), { now: augustNow });

      expect(result).toEqual({ status: "updated", saved: ["2026-08-09"], skippedManual: [] });
      expect(snapshot("2026-08-09")?.btc_held).toBe(840447);
      expect(acceptedDrops()).toHaveLength(1);
    });

    it("stops at a subsequent drop without a sale even when a later reading could be saved", async () => {
      const result = await run(augustSec("2026-08-24", {
        [URL_8K_AUG_17]: EIGHT_K_AUG_17.replaceAll("840,447", "840,446"),
        [archiveUrl("0001193125-26-361845", "mstr-20260824.htm")]:
          "<p>As of August 23, 2026, Strategy held 840,448 BTC.</p>",
      }), { now: augustNow });

      const warning = { date: "2026-08-16", reason: "btc_decreased", btc_held: 840446, previous_btc_held: 840447 };
      expect(result).toMatchObject({ status: "updated", saved: ["2026-08-09"], rejected: warning });
      expect(getPendingHoldingsWarning(db)).toMatchObject(warning);
      expect(snapshot("2026-08-09")?.btc_held).toBe(840447);
      expect(snapshot("2026-08-16")).toBeUndefined();
      expect(snapshot("2026-08-23")).toBeUndefined();
      expect(acceptedDrops()).toHaveLength(1);
    });
  });

  describe("throttle", () => {
    it("runs at most once every 6 hours", async () => {
      const first = fakeSec();
      await run(first);
      const second = fakeSec();

      const early = await run(second, { now: new Date(NOW.getTime() + CHECK_INTERVAL_MS - 60_000) });
      expect(early).toEqual({ status: "throttled", lastCheck: NOW.toISOString() });
      expect(second.fetchImpl).not.toHaveBeenCalled();

      const late = await run(second, { now: new Date(NOW.getTime() + CHECK_INTERVAL_MS + 60_000) });
      expect(late.status).not.toBe("throttled");
      expect(second.fetchImpl).toHaveBeenCalled();
    });

    it("counts a failed pass too, so a broken connection is not retried on every tab open", async () => {
      const failing = fakeSec({ [URL_SUBMISSIONS]: new Response("", { status: 503 }) });
      expect((await run(failing)).status).toBe("failed");

      const again = fakeSec();
      expect((await run(again, { now: new Date(NOW.getTime() + HOUR_MS) })).status).toBe("throttled");
      expect(again.fetchImpl).not.toHaveBeenCalled();
    });

    it("starts only one pass when two callers arrive together", async () => {
      const sec = fakeSec();
      const [a, b] = await Promise.all([run(sec), run(sec)]);

      expect([a.status, b.status].sort()).toEqual(["throttled", "updated"]);
      expect(sec.urls().filter((url) => url === URL_SUBMISSIONS)).toHaveLength(1);
    });
  });

  describe("no User-Agent", () => {
    it.each([undefined, "", "   "])("makes no request and logs one warning (%j)", async (userAgent) => {
      const sec = fakeSec();
      const before = listHoldingsSnapshots(db);

      expect(await run(sec, { userAgent })).toEqual({ status: "no_user_agent" });
      expect(sec.fetchImpl).not.toHaveBeenCalled();
      expect(logsAt("warn")).toHaveLength(1);
      expect(logsAt("warn")[0]).toMatchObject({ source: "markets" });
      expect(logsAt("warn")[0].message).toContain("SEC_USER_AGENT");
      expect(listHoldingsSnapshots(db)).toEqual(before);
    });
  });

  describe("failures write nothing", () => {
    const expectFailed = (result: HoldingsReaderResult, category: string) => {
      expect(result).toMatchObject({ status: "failed", category });
      expect(logsAt("error")).toHaveLength(1);
      expect(logsAt("error")[0]).toMatchObject({ source: "markets", data: expect.objectContaining({ category }) });
    };

    it("a holdings table that cannot be parsed is a failed pass", async () => {
      const before = listHoldingsSnapshots(db);
      const broken = EIGHT_K_NOV_16.replace(/850,849/g, "n/a");
      expect(broken).not.toBe(EIGHT_K_NOV_16);

      expectFailed(await run(fakeSec({ [URL_8K_NOV_16]: broken })), "parse");
      expect(listHoldingsSnapshots(db)).toEqual(before);
    });

    it("an unreadable cover page is a failed pass", async () => {
      const before = listHoldingsSnapshots(db);

      expectFailed(await run(fakeSec({ [URL_10Q]: EIGHT_K_NOV_16 })), "parse");
      expect(listHoldingsSnapshots(db)).toEqual(before);
    });

    it("a cover page dated after the reading is never carried backwards", async () => {
      const before = listHoldingsSnapshots(db);
      const later = TEN_Q.replace(/October&#160;25, 2026/g, "November 20, 2026");
      expect(later).not.toBe(TEN_Q);

      const olderTenQ = archiveUrl("0001050446-26-000044", "mstr-20260630.htm");
      const sec = fakeSec({ [URL_10Q]: later, [olderTenQ]: EIGHT_K_NOV_16 });

      // The newest cover is dated after the reading, so the reader asks for the previous 10-Q
      // instead of using the later one; that one is unreadable here.
      expectFailed(await run(sec), "parse");
      expect(sec.urls()).toContain(olderTenQ);
      expect(listHoldingsSnapshots(db)).toEqual(before);
    });

    it.each([403, 429])("HTTP %i from the submissions list is a failed pass, not an exception", async (status) => {
      const before = listHoldingsSnapshots(db);

      expectFailed(await run(fakeSec({ [URL_SUBMISSIONS]: new Response("", { status }) })), "http");
      expect(listHoldingsSnapshots(db)).toEqual(before);
      expect(logsAt("error")[0].data).toMatchObject({ status });
    });

    it("a submissions list that is not JSON is a protocol failure", async () => {
      expectFailed(await run(fakeSec({ [URL_SUBMISSIONS]: "<html>blocked</html>" })), "protocol");
    });

    it("a body that times out while it is read is a timeout failure", async () => {
      const slow = {
        ok: true,
        status: 200,
        text: async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
      } as unknown as Response;
      const fetchImpl = vi.fn(async () => slow);
      const result = await refreshHoldingsFromSec({ db, fetchImpl, userAgent: USER_AGENT, now: () => NOW, pauseMs: 0 });

      expectFailed(result, "timeout");
    });

    it("a network error is a transport failure", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      const result = await refreshHoldingsFromSec({ db, fetchImpl, userAgent: USER_AGENT, now: () => NOW, pauseMs: 0 });

      expectFailed(result, "transport");
    });

    it("a timeout is its own category", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      });
      const result = await refreshHoldingsFromSec({ db, fetchImpl, userAgent: USER_AGENT, now: () => NOW, pauseMs: 0 });

      expectFailed(result, "timeout");
    });
  });

  describe("sanity check and manual snapshots", () => {
    it("an implausible jump is rejected and leaves the pending warning", async () => {
      db.prepare("UPDATE holdings_snapshots SET btc_held = 700000 WHERE date = '2026-11-08'").run();

      const result = await run(fakeSec());

      expect(result).toMatchObject({
        status: "updated",
        saved: [],
        rejected: { reason: "btc_increased_too_much", date: "2026-11-15", btc_held: 850849, previous_btc_held: 700000 },
      });
      expect(getPendingHoldingsWarning(db)).toMatchObject({ reason: "btc_increased_too_much", date: "2026-11-15" });
      expect(snapshot("2026-11-15")).toBeUndefined();
    });

    it("does not overwrite a manual snapshot for the same date", async () => {
      saveHoldingsSnapshot(db, { date: "2026-11-15", btc_held: 851000, shares_outstanding: 423000000, source: "manual" });

      const result = await run(fakeSec());

      expect(result).toEqual({ status: "updated", saved: [], skippedManual: ["2026-11-15"] });
      expect(snapshot("2026-11-15")).toMatchObject({ btc_held: 851000, shares_outstanding: 423000000, source: "manual" });
    });
  });
});
