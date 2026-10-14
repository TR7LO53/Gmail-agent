import { slotForMinute } from "../core/slot";
import { copySettings, DEFAULT_SETTINGS, validateSettings, type AppSettings } from "../core/settings";
import { sumMacrosInRange } from "../core/totals";
import type { Macros, Slot } from "../core/types";
import type { FoodRepository, StoredEntry, StoredPreset } from "../data/food-repository";
import type { SettingsRepository } from "../data/settings-repository";

export const GOALS: Readonly<Macros> = DEFAULT_SETTINGS.goals;
export interface DayWindow { start: string; end: string }
export function localDayWindow(now: Date): DayWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
export function currentSlot(now: Date, boundaries: AppSettings["boundaries"] = DEFAULT_SETTINGS.boundaries): Slot { return slotForMinute(now.getHours() * 60 + now.getMinutes(), boundaries); }
export class PantryState {
  presets: StoredPreset[] = []; entries: StoredEntry[] = []; now: Date; error = ""; settings: AppSettings = copySettings(DEFAULT_SETTINGS);
  constructor(private readonly repository: FoodRepository, private readonly clock: () => Date = () => new Date(), private readonly settingsRepository?: SettingsRepository) { this.now = clock(); }
  get totals(): Macros { const w = localDayWindow(this.now); return sumMacrosInRange(this.entries, w.start, w.end); }
  get goals(): Macros { return this.settings.goals; }
  get slot(): Slot { return currentSlot(this.now, this.settings.boundaries); }
  async loadSettings(): Promise<void> { if (this.settingsRepository) this.settings = await this.settingsRepository.get(); }
  async saveSettings(value: AppSettings): Promise<void> {
    const checked = validateSettings(value);
    if (!this.settingsRepository) throw new Error("Zapis ustawień jest niedostępny.");
    const saved = await this.settingsRepository.save(checked);
    this.settings = copySettings(saved);
    this.now = this.clock();
  }
  async refresh(): Promise<void> {
    this.now = this.clock(); const w = localDayWindow(this.now);
    try { [this.presets, this.entries] = await Promise.all([this.repository.listPresets(), this.repository.listEntries(w.start, w.end)]); this.error = ""; }
    catch { this.error = "Nie udało się odczytać danych. Spróbuj ponownie."; throw new Error(this.error); }
  }
  async add(id: number, grams: number): Promise<void> { await this.repository.add(id, grams); await this.refresh(); }
  async update(id: number, grams: number): Promise<void> { await this.repository.updateWeight(id, grams); await this.refresh(); }
  async remove(id: number): Promise<void> { await this.repository.delete(id); await this.refresh(); }
}
