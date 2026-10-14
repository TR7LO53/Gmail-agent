// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FoodRepository } from "../src/data/food-repository";
import { prepareSchema } from "../src/data/schema";
import { openNodeSqlite } from "./helpers/sqlite-node";
import App from "../src/App.svelte";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("../src/data/sqlite", () => ({ openFoodDatabase: async () => (globalThis as any).__settingsTestDb }));

let directory: string;
let db: ReturnType<typeof openNodeSqlite>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ggent-settings-ui-"));
  db = openNodeSqlite(join(directory, "food.db"));
  (globalThis as any).__settingsTestDb = db;
  await prepareSchema(db);
  const food = new FoodRepository(db);
  const id = await food.insertPreset({ name: "Porridge", kcal: 500, protein_g: 10, carbs_g: 50, fat_g: 5, slot_tags: ["lunch"] });
  await food.add(id, 100);
});
afterEach(async () => { cleanup(); delete (globalThis as any).__settingsTestDb; await db.close(); await rm(directory, { recursive: true, force: true }); });

describe("settings screen", () => {
  it("saves goals and refreshes the mounted Pantry header immediately", async () => {
    render(App);
    await screen.findByText("Porridge");
    await fireEvent.click(screen.getByRole("button", { name: "Ustawienia" }));
    await fireEvent.input(screen.getByLabelText(/Energia/), { target: { value: "2200" } });
    await fireEvent.input(screen.getByLabelText(/Białko/), { target: { value: "155,5" } });
    await fireEvent.input(screen.getByLabelText(/Węglowodany/), { target: { value: "210" } });
    await fireEvent.input(screen.getByLabelText(/Tłuszcz/), { target: { value: "75" } });
    await fireEvent.input(screen.getByLabelText("Początek obiadu"), { target: { value: "10:00" } });
    await fireEvent.input(screen.getByLabelText("Początek kolacji"), { target: { value: "17:30" } });
    await fireEvent.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(screen.getByText("1700 kcal")).toBeTruthy());
    expect(screen.getByText("B").parentElement?.textContent).toContain("145.5 g");
    expect(await new (await import("../src/data/settings-repository")).SettingsRepository(db).get()).toEqual({ goals: { kcal: 2200, protein_g: 155.5, carbs_g: 210, fat_g: 75 }, boundaries: { lunchStart: 600, dinnerStart: 1050 } });
    expect(screen.getByRole("button", { name: "Otwórz dzisiejsze wpisy" })).toBeTruthy();
  });

  it("discards an unsaved draft when cancelled", async () => {
    render(App);
    await screen.findByText("Porridge");
    await fireEvent.click(screen.getByRole("button", { name: "Ustawienia" }));
    await fireEvent.input(screen.getByLabelText(/Energia/), { target: { value: "2400" } });
    await fireEvent.click(screen.getByRole("button", { name: "‹ Pantry" }));
    await fireEvent.click(screen.getByRole("button", { name: "Ustawienia" }));
    expect((screen.getByLabelText(/Energia/) as HTMLInputElement).value).toBe("2000");
  });

  it("keeps the draft and active goal after a database error, then allows retry", async () => {
    render(App);
    await screen.findByText("Porridge");
    await fireEvent.click(screen.getByRole("button", { name: "Ustawienia" }));
    await fireEvent.input(screen.getByLabelText(/Energia/), { target: { value: "2400" } });
    await db.run("CREATE TRIGGER fail_settings BEFORE UPDATE ON app_settings BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await fireEvent.click(screen.getByRole("button", { name: "Zapisz" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByLabelText(/Energia/) as HTMLInputElement).value).toBe("2400");
    await db.run("DROP TRIGGER fail_settings");
    await fireEvent.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(screen.getByText("1900 kcal")).toBeTruthy());
  });
});
