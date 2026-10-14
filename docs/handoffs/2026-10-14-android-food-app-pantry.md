# Handoff — Offline Android food app: design chosen, open questions next

**Repo**: `c:\Users\sebas\OneDrive\Pulpit\Tools\AI\Gmail agent` (nested app at `gmail-agent/`)
**GitHub**: `TR7LO53/Gmail-agent`
**Date**: 2026-10-14
**Next session's purpose**: the user settles the open questions ("blank spots") in issue #13, so the app can then be broken into implementation tickets.

## Where things stand

The user wants the **food-logging part of Ggent** as their own **offline Android app**: calories + macros vs daily goals, with their own list of predefined foods. Parcels and email stay on the desktop.

- **Main ticket**: [#13 Offline Android food app (Capacitor) — Pantry design](https://github.com/TR7LO53/Gmail-agent/issues/13). It holds the goal, the decisions so far, the full list of open questions and what's out of scope. Read it first; it isn't repeated here.
- **Prototype (primary source)**: branch [`prototype/mobile-food-app`](https://github.com/TR7LO53/Gmail-agent/tree/prototype/mobile-food-app), commit `ae589f4`, file `gmail-agent/prototypes/mobile-food-app.prototype.html`. It is one self-contained HTML file that you double-click to open, with three UI variants (`?variant=A|B|C`). **The user picked B ("Pantry": tile grid + number pad).** To view it without switching branches: `git -C "<repo>" show prototype/mobile-food-app:gmail-agent/prototypes/mobile-food-app.prototype.html > <scratchpad>/proto.html`, then open that file.
- **Not on main**: nothing from the prototype was merged. Main only gets this handoff.

## How the decisions were reached (context not in the ticket)

1. The user first asked whether moving the food part to Android was possible. Three options were laid out: PWA, **Capacitor**, React Native/Expo. The user chose **Capacitor**, mainly to get a real installable app while reusing TypeScript.
2. "No internet for the first version" means v1 drops both the AI parsing (`parse-food.ts`) and the USDA Lookup (`nutrition/provider.ts`). Only Presets remain, which matches the deterministic direction already recorded in [ADR 0001](../adr/0001-deterministic-preset-food-library.md).
3. The prototype was seeded with the user's **7 real Presets** read from `gmail-agent/data/gmail-agent.db` (`food_presets` table) and the default goals from `nutritionGoals()` in `gmail-agent/src/config.ts` (2000 kcal / 150 B / 200 W / 70 T).
4. The user looked at A, B and C and chose **B** without asking for parts of the others.

## Things worth knowing for the next session

- **A gap in variant B**: there's no way to edit or delete an existing Preset, only "+ Nowy produkt". Variants A and C had a product list for this. It's in the ticket's open questions, but bring it up early because it affects the layout.
- Reusable logic: `gmail-agent/src/memory/food.ts` (totals, `updateFoodLogWeight` / proportional rescale, manual entry) and `gmail-agent/src/memory/presets.ts`, plus `nutrition/preset-match.ts`. These are currently tied to `node:sqlite` via `DB`. Whether that layer can run on the phone depends on the storage choice (open question).
- Domain vocabulary is in [CONTEXT.md](../../CONTEXT.md) (Preset, Item, Meal, Current Consumption, Last Day Summary…). Keep using it, and add any new terms the session settles (e.g. "Pantry").
- **Unrelated uncommitted work on main**: `gmail-agent/src/ui/public/app.js`, `index.html` and `tests/unit/dashboard-render.test.ts` had changes this session didn't make. Don't commit or discard them without asking the user.
- The user prefers plain language with short examples, and no `cd` in shell commands (use `git -C`, `npm --prefix`).

## Suggested skills

- **`grilling`** (or `mattpocock-skills:grilling`): walk the user through #13's open questions one at a time and get a clear answer for each.
- **`domain-modeling`**: record new terms in `CONTEXT.md`, and write an ADR for decisions that are hard to reverse, such as the storage choice and whether the code lives in this repo or a separate one.
- **`mattpocock-skills:to-tickets`** (once the questions are answered): split #13 into implementation tickets. #13 then needs an `[Updated] ` title prefix when its scope is rewritten (user's global rule).
- **`mattpocock-skills:research`**: if a question needs facts, e.g. the state of Capacitor SQLite plugins or how sideloading/signing works on Windows.
- **`mattpocock-skills:prototype`** again, only if a design question comes back (e.g. where Preset editing goes in the Pantry layout).
