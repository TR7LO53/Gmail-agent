import { describe, expect, it } from "vitest";
import { slotForMinute } from "./slot";
import { SLOT_LABELS } from "./types";

describe("Slot", () => {
  it("uses the default 11:00 and 17:00 boundaries", () => {
    expect(slotForMinute(0)).toBe("breakfast");
    expect(slotForMinute(659)).toBe("breakfast");
    expect(slotForMinute(660)).toBe("lunch");
    expect(slotForMinute(1019)).toBe("lunch");
    expect(slotForMinute(1020)).toBe("dinner");
    expect(slotForMinute(1439)).toBe("dinner");
    expect(SLOT_LABELS).toEqual({ breakfast: "Śniadanie", lunch: "Obiad", dinner: "Kolacja" });
  });

  it("accepts custom boundaries and rejects invalid minutes or ordering", () => {
    const custom = { lunchStart: 570, dinnerStart: 1095 };
    expect(slotForMinute(569, custom)).toBe("breakfast");
    expect(slotForMinute(570, custom)).toBe("lunch");
    expect(slotForMinute(1094, custom)).toBe("lunch");
    expect(slotForMinute(1095, custom)).toBe("dinner");
    expect(() => slotForMinute(1440)).toThrow(RangeError);
    expect(() => slotForMinute(1.5)).toThrow(RangeError);
    expect(() => slotForMinute(10, { lunchStart: 1100, dinnerStart: 1000 })).toThrow(RangeError);
  });
});
