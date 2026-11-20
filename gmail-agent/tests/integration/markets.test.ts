import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import { createMarketSource } from "../../src/markets/source.js";
import type { DB } from "../../src/memory/db.js";
describe("markets logging integration", () => {
  let db: DB;
  afterEach(() => db?.close());
  it("records failed symbol fetches in Activity logs without storing prices", async () => {
    db = openDb(":memory:");
    const source = createMarketSource({ db, fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
    const result = await source.getCandles("GC=F", "D1");
    expect(result).toMatchObject({ ok: false, error: { symbol: "GC=F", timeframe: "D1", code: "http" } });
    expect(listRecentLogs(db, 5)).toMatchObject([{ source: "markets", level: "error", data: { symbol: "GC=F", timeframe: "D1", httpStatus: 429 } }]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row => row.name);
    expect(tables).not.toContain("market_prices");
  });
});
