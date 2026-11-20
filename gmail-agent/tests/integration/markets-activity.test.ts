import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { listRecentLogs } from "../../src/memory/logs.js";
import { createMarketsActivityLogger } from "../../src/markets/activity.js";
import { createPriceSource } from "../../src/markets/source.js";
import type { DB } from "../../src/memory/db.js";

describe("markets activity integration", () => {
  let db: DB | undefined;
  afterEach(() => db?.close());
  it("persists a failed market request to the existing logs table", async () => {
    db = openDb(":memory:");
    const source = createPriceSource({
      fetchImpl: async () => new Response("", { status: 502 }),
      logger: createMarketsActivityLogger(db),
    });
    await source.getCandles("MSTR", "D1");
    expect(listRecentLogs(db, 5)[0]).toMatchObject({
      source: "markets", level: "error", message: expect.stringContaining("MSTR D1"),
      data: { symbol: "MSTR", operation: "D1", category: "http" },
    });
  });
});
