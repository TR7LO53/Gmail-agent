import type { Preset, Slot } from "./types";

function usage(preset: Preset): number {
  const value = preset.usage_count ?? 0;
  if (!Number.isFinite(value) || value < 0) throw new RangeError("usage_count must be finite and non-negative.");
  return value;
}

function matches(preset: Preset, query: string): boolean {
  const needle = query.toLocaleLowerCase();
  return [preset.name, ...(preset.aliases ?? [])].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

/** Search by case-insensitive substring in name/aliases; stable ties retain input order. */
export function orderPresetTiles(
  presets: readonly Preset[],
  currentSlot: Slot,
  searchText = "",
): Preset[] {
  const query = searchText.trim();
  const candidates = presets
    .map((preset, index) => ({ preset, index, count: usage(preset) }))
    .filter(({ preset }) => !query || matches(preset, query));

  candidates.sort((left, right) => {
    if (!query) {
      const leftTagged = left.preset.slot_tags?.includes(currentSlot) ?? false;
      const rightTagged = right.preset.slot_tags?.includes(currentSlot) ?? false;
      if (leftTagged !== rightTagged) return leftTagged ? -1 : 1;
    }
    return right.count - left.count || left.index - right.index;
  });
  return candidates.map(({ preset }) => preset);
}
