import { copySettings, validateSettings, type AppSettings } from "../core/settings";
import type { SqlConnection } from "./schema";

export class SettingsRepository {
  constructor(private readonly db: SqlConnection) {}

  async get(): Promise<AppSettings> {
    const row = (await this.db.query<any>("SELECT * FROM app_settings WHERE id=1"))[0];
    if (!row) throw new Error("Brak ustawień aplikacji w bazie danych.");
    return validateSettings({
      goals: { kcal: Number(row.goal_kcal), protein_g: Number(row.goal_protein_g), carbs_g: Number(row.goal_carbs_g), fat_g: Number(row.goal_fat_g) },
      boundaries: { lunchStart: Number(row.lunch_start), dinnerStart: Number(row.dinner_start) },
    });
  }

  async save(value: AppSettings): Promise<AppSettings> {
    const settings = validateSettings(value);
    const { goals, boundaries } = settings;
    const result = await this.db.run("UPDATE app_settings SET goal_kcal=?,goal_protein_g=?,goal_carbs_g=?,goal_fat_g=?,lunch_start=?,dinner_start=? WHERE id=1", [goals.kcal, goals.protein_g, goals.carbs_g, goals.fat_g, boundaries.lunchStart, boundaries.dinnerStart]);
    if (result.changes !== 1) throw new Error("Nie udało się zapisać ustawień.");
    return copySettings(settings);
  }
}
