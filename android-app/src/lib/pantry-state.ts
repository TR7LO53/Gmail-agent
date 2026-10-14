import { slotForMinute } from "../core/slot";
import { copySettings, DEFAULT_SETTINGS, validateSettings, type AppSettings } from "../core/settings";
import { lastSevenDaysTotals, sumMacrosInRange } from "../core/totals";
import type { DayTotals, Macros, Slot } from "../core/types";
import type { FoodRepository, StoredEntry, StoredPreset } from "../data/food-repository";
import type { FoodBackup } from "../core/backup";
import type { SettingsRepository } from "../data/settings-repository";
import { lastSevenDaysWindow, localDayWindow } from "./history";

export const GOALS: Readonly<Macros> = DEFAULT_SETTINGS.goals;
export { localDayWindow } from "./history";
export type { DayWindow } from "./history";

export function currentSlot(now: Date, boundaries: AppSettings["boundaries"] = DEFAULT_SETTINGS.boundaries): Slot {
  return slotForMinute(now.getHours() * 60 + now.getMinutes(), boundaries);
}

export class PantryState {
  presets: StoredPreset[] = [];
  entries: StoredEntry[] = [];
  weekEntries: StoredEntry[] = [];
  historyTotals: DayTotals[] = [];
  now: Date;
  error = "";
  settings: AppSettings = copySettings(DEFAULT_SETTINGS);
  private refreshSequence = 0;

  constructor(private readonly repository: FoodRepository, private readonly clock: () => Date = () => new Date(), private readonly settingsRepository?: SettingsRepository) {
    this.now = clock();
  }

  get totals(): Macros {
    const window = localDayWindow(this.now);
    return sumMacrosInRange(this.entries, window.start, window.end);
  }

  get goals(): Macros { return this.settings.goals; }
  get slot(): Slot { return currentSlot(this.now, this.settings.boundaries); }

  async loadSettings(): Promise<void> {
    if (this.settingsRepository) this.settings = await this.settingsRepository.get();
  }

  async saveSettings(value: AppSettings): Promise<void> {
    const checked = validateSettings(value);
    if (!this.settingsRepository) throw new Error("Zapis ustawień jest niedostępny.");
    const saved = await this.settingsRepository.save(checked);
    this.settings = copySettings(saved);
    this.now = this.clock();
  }

  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    const now = this.clock();
    const week = lastSevenDaysWindow(now);
    const today = localDayWindow(now);
    try {
      const [presets, weekEntries] = await Promise.all([
        this.repository.listPresets(),
        this.repository.listEntries(week.start, week.end),
      ]);
      if (sequence !== this.refreshSequence) return;
      const todayStart = Date.parse(today.start), todayEnd = Date.parse(today.end);
      const entries = weekEntries.filter((entry) => {
        const time = Date.parse(entry.ts);
        return Number.isFinite(time) && time >= todayStart && time < todayEnd;
      });
      const historyTotals = lastSevenDaysTotals(weekEntries, now);
      this.presets = presets;
      this.weekEntries = weekEntries;
      this.entries = entries;
      this.historyTotals = historyTotals;
      this.now = now;
      this.error = "";
    } catch {
      if (sequence === this.refreshSequence) {
        this.error = "Nie udało się odczytać danych. Spróbuj ponownie.";
        throw new Error(this.error);
      }
    }
  }

  async add(id: number, grams: number): Promise<void> { await this.repository.add(id, grams); await this.refresh(); }
  async update(id: number, grams: number): Promise<void> { await this.repository.updateWeight(id, grams); await this.refresh(); }
  async remove(id: number): Promise<void> { await this.repository.delete(id); await this.refresh(); }
  async exportBackup(): Promise<FoodBackup> { return this.repository.exportBackup(); }
  async importBackup(backup: FoodBackup): Promise<{ addedPresets: number; skippedPresets: number; addedEntries: number }> {
    return this.repository.importBackup(backup);
  }
}
