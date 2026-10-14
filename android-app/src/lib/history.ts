import type { DayTotals } from "../core/types";
import type { StoredEntry } from "../data/food-repository";

export interface DayWindow { start: string; end: string }

export function localDayWindow(now: Date): DayWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function lastSevenDaysWindow(now: Date): DayWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function localDateWindow(dateKey: string): DayWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new RangeError(`Invalid local date: ${dateKey}`);
  const [, year, month, day] = match;
  const start = new Date(Number(year), Number(month) - 1, Number(day));
  if (start.getFullYear() !== Number(year) || start.getMonth() !== Number(month) - 1 || start.getDate() !== Number(day)) {
    throw new RangeError(`Invalid local date: ${dateKey}`);
  }
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function entriesForLocalDate(entries: readonly StoredEntry[], dateKey: string): StoredEntry[] {
  const window = localDateWindow(dateKey);
  const start = Date.parse(window.start), end = Date.parse(window.end);
  return entries.filter((entry) => {
    const time = Date.parse(entry.ts);
    return Number.isFinite(time) && time >= start && time < end;
  });
}

export function chartScale(days: readonly DayTotals[], goal: number): number {
  const highest = Math.max(0, goal, ...days.map((day) => day.kcal));
  return Math.max(1, highest * 1.15);
}

export function localDateLabel(dateKey: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "numeric" }): string {
  const window = localDateWindow(dateKey);
  return new Date(window.start).toLocaleDateString("pl-PL", options);
}
