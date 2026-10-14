import { describe, expect, it } from "vitest";
import { lastSevenDaysTotals, sumMacrosInRange, type TimestampedMacros } from "./totals";

const row = (ts: string, kcal: number, protein_g = 0.05): TimestampedMacros => ({
  ts, kcal, protein_g, carbs_g: 0.05, fat_g: 0.05,
});

describe("totals", () => {
  it("sums saved macros over [start, end), rounding after aggregation", () => {
    const rows = [
      row("2026-01-01T00:00:00Z", 1.4, 0.06),
      row("2026-01-01T23:59:59Z", 1.4, 0.06),
      row("2026-01-02T00:00:00+00:00", 100, 4),
      row("2025-12-31T23:59:59Z", 50),
    ];
    expect(sumMacrosInRange(rows, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")).toEqual({
      kcal: 3, protein_g: 0.1, carbs_g: 0.1, fat_g: 0.1,
    });
    expect(sumMacrosInRange([], "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")).toEqual({
      kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
    });
    expect(() => sumMacrosInRange([row("invalid", 1)], "2026-01-01", "2026-01-02")).toThrow(RangeError);
  });

  it("returns seven local calendar days, inclusive of today, without mutating now", () => {
    const now = new Date(2026, 2, 29, 12, 0);
    const original = now.getTime();
    const rows = [
      row("2026-03-23T00:00:00", 10),
      row("2026-03-29T11:00:00", 4),
      row("2026-03-30T00:00:00", 100),
      row("2026-03-22T23:59:59", 50),
    ];
    const days = lastSevenDaysTotals(rows, now);
    expect(days).toHaveLength(7);
    expect(days.map((day) => day.date)).toEqual([
      "2026-03-23", "2026-03-24", "2026-03-25", "2026-03-26", "2026-03-27", "2026-03-28", "2026-03-29",
    ]);
    expect(days[0]).toMatchObject({ kcal: 10 });
    expect(days[1]).toMatchObject({ kcal: 0 });
    expect(days[6]).toMatchObject({ kcal: 4 });
    expect(now.getTime()).toBe(original);
    expect(() => lastSevenDaysTotals([row("nonsense", 1)], now)).toThrow(RangeError);
  });

  it("handles year and month transitions using calendar dates", () => {
    const days = lastSevenDaysTotals([], new Date(2026, 0, 2, 15));
    expect(days.map((day) => day.date)).toEqual([
      "2025-12-27", "2025-12-28", "2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02",
    ]);
  });

  it("groups UTC offset timestamps by local date across both DST transitions", () => {
    const priorTz = process.env.TZ;
    process.env.TZ = "Europe/Warsaw";
    try {
      const spring = lastSevenDaysTotals([
        row("2026-03-28T22:59:59.999Z", 10),
        row("2026-03-28T23:00:00.000Z", 20),
        row("2026-03-29T21:59:59.999Z", 30),
        row("2026-03-29T22:00:00.000Z", 99),
      ], new Date("2026-03-29T10:00:00Z"));
      expect(spring[5]).toMatchObject({ date: "2026-03-28", kcal: 10 });
      expect(spring[6]).toMatchObject({ date: "2026-03-29", kcal: 50 });
      const autumn = lastSevenDaysTotals([
        row("2026-10-24T21:59:59.999Z", 10),
        row("2026-10-24T22:00:00.000Z", 20),
        row("2026-10-25T22:59:59.999Z", 30),
        row("2026-10-25T23:00:00.000Z", 99),
      ], new Date("2026-10-25T10:00:00Z"));
      expect(autumn[5]).toMatchObject({ date: "2026-10-24", kcal: 10 });
      expect(autumn[6]).toMatchObject({ date: "2026-10-25", kcal: 50 });
    } finally { if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz; }
  });
});
