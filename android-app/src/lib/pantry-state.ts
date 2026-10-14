import { slotForMinute } from "../core/slot";
import { sumMacrosInRange } from "../core/totals";
import type { Macros, Slot } from "../core/types";
import type { FoodRepository, StoredEntry, StoredPreset } from "../data/food-repository";

export const GOALS: Macros = { kcal: 2000, protein_g: 150, carbs_g: 200, fat_g: 70 };
export interface DayWindow { start: string; end: string }
export function localDayWindow(now: Date): DayWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
export function currentSlot(now: Date): Slot { return slotForMinute(now.getHours() * 60 + now.getMinutes()); }
export class PantryState {
  presets: StoredPreset[] = []; entries: StoredEntry[] = []; now: Date; error = "";
  constructor(private readonly repository: FoodRepository, private readonly clock: () => Date = () => new Date()) { this.now = clock(); }
  get totals(): Macros { const w = localDayWindow(this.now); return sumMacrosInRange(this.entries, w.start, w.end); }
  get slot(): Slot { return currentSlot(this.now); }
  async refresh(): Promise<void> {
    this.now = this.clock(); const w = localDayWindow(this.now);
    try { [this.presets, this.entries] = await Promise.all([this.repository.listPresets(), this.repository.listEntries(w.start, w.end)]); this.error = ""; }
    catch { this.error = "Nie udało się odczytać danych. Spróbuj ponownie."; throw new Error(this.error); }
  }
  async add(id: number, grams: number): Promise<void> { await this.repository.add(id, grams); await this.refresh(); }
  async update(id: number, grams: number): Promise<void> { await this.repository.updateWeight(id, grams); await this.refresh(); }
  async remove(id: number): Promise<void> { await this.repository.delete(id); await this.refresh(); }
}
