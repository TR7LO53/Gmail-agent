import type { Slot } from "./types";

export interface SlotBoundaries {
  lunchStart?: number;
  dinnerStart?: number;
}

const DEFAULT_LUNCH_START = 660;
const DEFAULT_DINNER_START = 1020;

function validMinute(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 1439) {
    throw new RangeError(`${name} must be an integer from 0 to 1439.`);
  }
}

/** Resolve a local clock minute (0–1439) to breakfast, lunch, or dinner. */
export function slotForMinute(minute: number, boundaries: SlotBoundaries = {}): Slot {
  validMinute(minute, "minute");
  const lunchStart = boundaries.lunchStart ?? DEFAULT_LUNCH_START;
  const dinnerStart = boundaries.dinnerStart ?? DEFAULT_DINNER_START;
  validMinute(lunchStart, "lunchStart");
  validMinute(dinnerStart, "dinnerStart");
  if (lunchStart >= dinnerStart) throw new RangeError("lunchStart must be before dinnerStart.");
  if (minute < lunchStart) return "breakfast";
  if (minute < dinnerStart) return "lunch";
  return "dinner";
}
