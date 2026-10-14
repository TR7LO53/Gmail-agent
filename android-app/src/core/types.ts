export interface Macros {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

/** Preset macros are stored per 100 g. */
export interface Preset extends Macros {
  id: string | number;
  name: string;
  aliases?: readonly string[];
  piece_weight_g?: number;
  slot_tags?: readonly Slot[];
  usage_count?: number;
  from_ggent?: boolean;
}

/** An immutable arithmetic snapshot; metadata can be added by the persistence layer. */
export interface FoodLogSnapshot extends Macros {
  qty: number;
  unit: "g";
}

export interface FoodLogEntry extends FoodLogSnapshot {
  id?: string | number;
  ts: string;
  name: string;
  preset_id?: string | number | null;
  [metadata: string]: unknown;
}

export type Slot = "breakfast" | "lunch" | "dinner";

export const SLOT_LABELS: Readonly<Record<Slot, string>> = {
  breakfast: "Śniadanie",
  lunch: "Obiad",
  dinner: "Kolacja",
};

export interface DayTotals extends Macros {
  date: string;
}
