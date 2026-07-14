# Stage 6 Implementation Guide — Food logging via Discord (voice + text)

> **Update — Stage 6.1 (2026-07-02):** Nutritionix went paid, so the nutrition source is now
> **USDA FoodData Central** (free key). USDA has no natural-language endpoint, so the flow is:
> LLM parses the meal (any language) into `{ food name (English), grams }`, then USDA is queried
> per food and its per-100 g nutrients are scaled by grams. This replaced the separate PL→EN
> translate step. Env var is now **`USDA_API_KEY`** (not `NUTRITIONIX_*`). Details in the
> **SETUP-Discord-Nutritionix.md** guide (Part A) — everything else below still applies.

**Date:** 2026-07-02
**Builds on:** Stages 1–5 (parcels, inbox, dashboard, launcher)
**Status:** ✅ Complete — **120/120** unit+integration tests passing · 0 TypeScript errors
**New runtime dep:** `discord.js`. Nutritionix via `fetch`; transcription + translation reuse `openai`.

---

## 1. What this adds

Log what you eat by messaging Ggent on **Discord** — typed **or as a voice note**, **in Polish**. Ggent transcribes voice, translates PL→English (Nutritionix is English-only), looks up calories + macros, stores them, **replies** with your running daily totals vs goals, and shows the same on the **dashboard**.

**Message flow (one place: `handleIncoming`):**
```
Discord msg → audio attachment? ─yes→ download → Whisper transcribe (PL)
                               └─no→ text (PL)
        → translate PL→EN (OpenAI) → Nutritionix → store (keep PL + EN) → reply (PL) + dashboard
        (commands `today` / `undo` handled before the food path)
```

---

## 2. What I built

### New files
| File | Purpose |
|---|---|
| `src/nutrition/provider.ts` | `NutritionProvider` seam + `nutritionixProvider` (natural-language endpoint) + `mapNutritionixFoods`. |
| `src/memory/food.ts` | `food_log` table access: `logFoodItems`, `listTodaysFood`, `todaysTotals`, `deleteLast`. |
| `src/llm/translate.ts` | `translateFoodToEnglish` (reuses the LLM `extract` seam). |
| `src/llm/transcribe.ts` | `openaiTranscriber` (Whisper, `language: pl`) behind a `Transcriber` type. |
| `src/agents/nutrition-log.ts` | `logMeal(text, source, deps)` — the shared translate→analyze→store pipeline. |
| `src/bot/discord.ts` | `handleIncoming` (testable routing) + `startBot` (discord.js wiring). |
| `src/bot/run.ts` | Standalone `npm run bot` entry. |

### Changed
- `src/memory/db.ts` — additive `food_log` table.
- `src/config.ts` — `nutritionGoals()` (env-driven daily targets).
- `src/ui/app.ts` — `GET /api/food` (`{ entries, totals, goals }`); `src/ui/sse.ts` — signature keys on food so eating pushes a live update.
- `src/ui/public/*` — **Today's nutrition** dashboard section: kcal + protein/carbs/fat **progress meters vs goals** (single accent hue, amber when over, values shown as text — per the dataviz guidance) + item list.
- `src/cli.ts` — `food "<meal>"` (log) and `food today` (report).
- `src/start.ts` — the one-click launcher now also starts the bot (skips cleanly if no token).
- `package.json` — `discord.js` + `bot` script; `.env.example` documented.

### Design rules kept
Provider **seams** (nutrition/translate/transcribe all injectable & faked in tests); dashboard stays a **pure viewer** (bot writes the DB, web reads); additive `node:sqlite` table; secrets only in `.env`; read-only Gmail untouched.

---

## 3. What YOU provide (one-time)

1. **Discord bot** — Developer Portal → New Application → **Bot** → copy **token**; enable **Message Content Intent**; invite it to a server or DM it. Copy **your** user id (enable Developer Mode → right-click your name → Copy User ID).
2. **USDA FoodData Central** — free key at https://fdc.nal.usda.gov/api-key-signup.html (emailed instantly).
3. Add to **`.env`** (see `.env.example`):
   ```
   DISCORD_BOT_TOKEN=...
   DISCORD_ALLOWED_USER_ID=...
   USDA_API_KEY=...
   NUTRITION_GOAL_KCAL=2000
   NUTRITION_GOAL_PROTEIN_G=150
   NUTRITION_GOAL_CARBS_G=200
   NUTRITION_GOAL_FAT_G=70
   ```
   `OPENAI_API_KEY` (already set) powers translation + voice transcription.

---

## 4. Testing

### Automated
```powershell
npm run typecheck     # 0 errors
npm test              # 120 passed
```
New coverage: `food.test.ts`, `nutrition.test.ts`, `config.test.ts` (goals), `nutrition-log.test.ts` (PL→EN reaches API, original kept, graceful failures), `bot.test.ts` (text vs voice routing, `today`/`undo`, unrecognised food), `ui.test.ts` (`/api/food`).

### Manual / live
1. **CLI first (no Discord):** put your `USDA_API_KEY` in `.env`, then
   `npm run try -- food "2 jajka i tost"` → it translates, logs, and `npm run try -- food today` + the dashboard show macros.
2. **Discord text (PL):** DM the bot `pierś z kurczaka 200g i ryż` → reply with totals; dashboard updates live.
3. **Discord voice (PL):** send a voice note → transcribed, translated, logged, reply arrives.
4. **One click:** the desktop **Ggent** button starts the bot too (console shows "Discord bot online as …"). Chat commands: `today`, `undo` (`dzisiaj`, `cofnij` also work).

> Windows note: `npm run try -- food today` works; the older `--today` flag can be swallowed by npm's arg passing, so use the `food today` form (or run `npx tsx src/cli.ts food --today`).

---

## 5. Notes / boundaries
- Accuracy comes from Nutritionix; Ggent stores exactly what it returns. Voice adds a transcription step whose quality depends on the recording.
- Only your `DISCORD_ALLOWED_USER_ID` can log (others are ignored).
- Deferred from earlier stages still open: parcel `estimated_delivery` column + decisions CSV export.
