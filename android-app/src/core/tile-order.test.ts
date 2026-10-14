import { describe, expect, it } from "vitest";
import { orderPresetTiles } from "./tile-order";
import type { Preset } from "./types";

const item = (id: string, usage_count: number, slot_tags?: Preset["slot_tags"], name = id, aliases?: string[]): Preset => ({
  id, name, kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1, usage_count, slot_tags, aliases,
});

describe("tile ordering", () => {
  it("groups current-slot tags first, sorts by usage and keeps stable ties without mutating input", () => {
    const presets = [
      item("untagged-high", 8), item("tagged-low", 2, ["breakfast"]),
      item("tagged-high", 5, ["breakfast", "lunch"]), item("tie", 5, ["breakfast"]), item("missing-count", 0),
    ];
    const original = [...presets];
    expect(orderPresetTiles(presets, "breakfast").map((preset) => preset.id)).toEqual([
      "tagged-high", "tie", "tagged-low", "untagged-high", "missing-count",
    ]);
    expect(presets).toEqual(original);
  });

  it("searches name and aliases by trimmed, case-insensitive substring, without slot priority", () => {
    const presets = [
      item("tagged", 1, ["lunch"], "Owsianka"), item("alias-match", 7, [], "Miska", ["płatki owsiane"]),
      item("other", 99, ["lunch"], "Ryż"),
    ];
    expect(orderPresetTiles(presets, "lunch", "  PŁATKI  ").map((preset) => preset.id)).toEqual(["alias-match"]);
    expect(orderPresetTiles(presets, "lunch", " OW ").map((preset) => preset.id)).toEqual(["alias-match", "tagged"]);
    expect(orderPresetTiles(presets, "lunch", "   ").map((preset) => preset.id)).toEqual(["other", "tagged", "alias-match"]);
    expect(orderPresetTiles(presets, "lunch", "missing")).toEqual([]);
  });
});
