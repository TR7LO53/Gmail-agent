import type { DayTotals, Macros } from "./types";

export interface TimestampedMacros extends Macros {
  ts: string;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseTimestamp(timestamp: string): number {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new RangeError(`Invalid timestamp: ${timestamp}`);
  return value;
}

function sum(entries: readonly TimestampedMacros[]): Macros {
  const total = entries.reduce(
    (acc, entry) => {
      for (const key of ["kcal", "protein_g", "carbs_g", "fat_g"] as const) {
        if (!Number.isFinite(entry[key])) throw new RangeError(`${key} must be finite.`);
        acc[key] += entry[key];
      }
      return acc;
    },
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
  return {
    kcal: Math.round(total.kcal),
    protein_g: round1(total.protein_g),
    carbs_g: round1(total.carbs_g),
    fat_g: round1(total.fat_g),
  };
}

/** Sum stored entry macros for the half-open instant window [start, end). */
export function sumMacrosInRange(
  entries: readonly TimestampedMacros[],
  start: Date | string,
  end: Date | string,
): Macros {
  const startMs = typeof start === "string" ? parseTimestamp(start) : start.getTime();
  const endMs = typeof end === "string" ? parseTimestamp(end) : end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new RangeError("Range boundaries must be valid and end must not precede start.");
  }
  const included = entries.filter((entry) => {
    const time = parseTimestamp(entry.ts);
    return time >= startMs && time < endMs;
  });
  return sum(included);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Daily totals for the seven local calendar dates ending with now's date. */
export function lastSevenDaysTotals(entries: readonly TimestampedMacros[], now: Date): DayTotals[] {
  const reference = new Date(now.getTime());
  if (!Number.isFinite(reference.getTime())) throw new RangeError("now must be a valid Date.");
  const today = localMidnight(reference);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  const dayStarts = Array.from({ length: 8 }, (_, index) =>
    new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
  const indexed = entries.map((entry) => ({ entry, time: parseTimestamp(entry.ts) }));

  return Array.from({ length: 7 }, (_, index) => {
    const dayStart = dayStarts[index];
    const nextStart = dayStarts[index + 1];
    const daily = indexed
      .filter(({ time }) => time >= dayStart.getTime() && time < nextStart.getTime())
      .map(({ entry }) => entry);
    return { date: localDateKey(dayStart), ...sum(daily) };
  });
}
