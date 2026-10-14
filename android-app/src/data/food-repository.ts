import { createFoodLogSnapshot, rescaleFoodLogEntry } from "../core/macros";
import type { FoodLogEntry, Preset, Slot } from "../core/types";
import type { SqlConnection } from "./schema";

export interface StoredPreset extends Preset { id: number; usage_count: number }
export interface StoredEntry extends FoodLogEntry { id: number; preset_id: number; source: string; provenance: string }
const macros = ["kcal", "protein_g", "carbs_g", "fat_g"] as const;

function finite(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Nieprawidłowa wartość pola ${field}`);
  return number;
}
function parseArray<T>(raw: unknown, field: string, validate: (v: unknown) => v is T): T[] {
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw ?? "[]")); } catch { throw new Error(`Nieprawidłowe dane pola ${field}`); }
  if (!Array.isArray(parsed) || !parsed.every(validate)) throw new Error(`Nieprawidłowe dane pola ${field}`);
  return parsed;
}
const validSlot = (v: unknown): v is Slot => v === "breakfast" || v === "lunch" || v === "dinner";

export class FoodRepository {
  private mutation = Promise.resolve();
  constructor(private readonly db: SqlConnection, private readonly now: () => Date = () => new Date()) {}

  async listPresets(): Promise<StoredPreset[]> {
    const rows = await this.db.query<any>(`SELECT p.*, COALESCE(u.count, 0) AS usage_count
      FROM food_presets p LEFT JOIN (SELECT preset_id, COUNT(*) count FROM food_log WHERE preset_id IS NOT NULL GROUP BY preset_id) u ON u.preset_id=p.id ORDER BY p.id ASC`);
    return rows.map((r) => {
      if (!Number.isInteger(Number(r.id)) || typeof r.name !== "string") throw new Error("Nieprawidłowy zapis produktu");
      const aliases = parseArray(r.aliases, "aliases", (x): x is string => typeof x === "string");
      const slots = parseArray(r.slots, "slots", validSlot);
      const preset: StoredPreset = { id: Number(r.id), name: r.name, aliases, slot_tags: slots, usage_count: finite(r.usage_count, "usage_count"), kcal: finite(r.kcal, "kcal"), protein_g: finite(r.protein_g, "protein_g"), carbs_g: finite(r.carbs_g, "carbs_g"), fat_g: finite(r.fat_g, "fat_g") };
      if (r.piece_weight_g != null) { preset.piece_weight_g = Number(r.piece_weight_g); if (!Number.isFinite(preset.piece_weight_g) || preset.piece_weight_g <= 0) throw new Error("Nieprawidłowa waga sztuki"); }
      return preset;
    });
  }

  async insertPreset(preset: Omit<Preset, "id" | "usage_count">): Promise<number> {
    const result = await this.db.run("INSERT INTO food_presets(name,aliases,kcal,protein_g,carbs_g,fat_g,piece_weight_g,slots) VALUES(?,?,?,?,?,?,?,?)", [preset.name, JSON.stringify(preset.aliases ?? []), ...macros.map((key) => preset[key]), preset.piece_weight_g ?? null, JSON.stringify(preset.slot_tags ?? [])]);
    if (!result.lastId) throw new Error("Nie udało się zapisać produktu");
    return result.lastId;
  }

  async listEntries(startIso: string, endIso: string): Promise<StoredEntry[]> {
    return this.db.query<StoredEntry>("SELECT * FROM food_log WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC", [startIso, endIso]);
  }
  async getEntry(id: number): Promise<StoredEntry | undefined> {
    return (await this.db.query<StoredEntry>("SELECT * FROM food_log WHERE id=?", [id]))[0];
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(action, action);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }
  add(presetId: number, grams: number): Promise<StoredEntry> { return this.serialize(async () => {
    const preset = (await this.db.query<any>("SELECT * FROM food_presets WHERE id=?", [presetId]))[0];
    if (!preset) throw new Error("Nie znaleziono produktu");
    const entryPreset: Preset = { id: presetId, name: preset.name, ...Object.fromEntries(macros.map((key) => [key, finite(preset[key], key)])) } as Preset;
    const snapshot = createFoodLogSnapshot(entryPreset, grams); const ts = this.now().toISOString();
    const result = await this.db.run("INSERT INTO food_log(ts,source,name,qty,unit,kcal,protein_g,carbs_g,fat_g,provenance,preset_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [ts,"manual",preset.name,snapshot.qty,snapshot.unit,snapshot.kcal,snapshot.protein_g,snapshot.carbs_g,snapshot.fat_g,"preset",presetId]);
    if (!result.lastId) throw new Error("Nie udało się zapisać wpisu");
    return (await this.getEntry(result.lastId))!;
  }); }
  updateWeight(id: number, grams: number): Promise<StoredEntry> { return this.serialize(async () => {
    const existing = await this.getEntry(id); if (!existing) throw new Error("Nie znaleziono wpisu");
    const scaled = rescaleFoodLogEntry(existing, grams);
    const result = await this.db.run("UPDATE food_log SET qty=?,kcal=?,protein_g=?,carbs_g=?,fat_g=? WHERE id=?", [scaled.qty,scaled.kcal,scaled.protein_g,scaled.carbs_g,scaled.fat_g,id]);
    if (result.changes !== 1) throw new Error("Nie udało się zaktualizować wpisu");
    return (await this.getEntry(id))!;
  }); }
  delete(id: number): Promise<void> { return this.serialize(async () => { const result = await this.db.run("DELETE FROM food_log WHERE id=?", [id]); if (result.changes !== 1) throw new Error("Nie znaleziono wpisu"); }); }
}
