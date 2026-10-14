import type { Slot } from "./types";

export interface SlotBoundaries {
  lunchStart?: number;
  dinnerStart?: number;
}

export const DEFAULT_SLOT_BOUNDARIES: Readonly<Required<SlotBoundaries>> = Object.freeze({ lunchStart: 660, dinnerStart: 1020 });

function validMinute(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 1439) {
    throw new RangeError(`${name} must be an integer from 0 to 1439.`);
  }
}

/** Resolve a local clock minute (0–1439) to breakfast, lunch, or dinner. */
export function slotForMinute(minute: number, boundaries: SlotBoundaries = {}): Slot {
  validMinute(minute, "minute");
  const lunchStart = boundaries.lunchStart ?? DEFAULT_SLOT_BOUNDARIES.lunchStart;
  const dinnerStart = boundaries.dinnerStart ?? DEFAULT_SLOT_BOUNDARIES.dinnerStart;
  validMinute(lunchStart, "lunchStart");
  validMinute(dinnerStart, "dinnerStart");
  if (lunchStart >= dinnerStart) throw new RangeError("lunchStart must be before dinnerStart.");
  if (minute < lunchStart) return "breakfast";
  if (minute < dinnerStart) return "lunch";
  return "dinner";
}
