# Gmail agent (Ggent)

A personal assistant that watches Gmail for parcels and, separately, logs what the user eats via a Discord bot — surfacing both on a local web dashboard.

## Language

### Nutrition tracking

**Preset**:
A food the user eats regularly, remembered with its own fixed macros (per 100g) so logging it doesn't require a live database lookup. Matched by exact alias, not by AI judgement.
_Avoid_: Favorite, saved food, custom food

**Alias**:
An alternate phrasing (often Polish, often several per Preset) that identifies a Preset when it appears in a logged message.

**Lookup**:
A live nutrition-database search (USDA FoodData Central) used for any food that doesn't match a Preset. The original, and still the only, source of macros before Presets existed.

**Provenance**:
Whether a logged item's macros came from a Preset or from a Lookup. Recorded per item so it's possible to see how much logging is actually being served from the user's own data vs. hitting the external API.

**Meal**:
Everything logged from a single message, grouped under one timestamp. A Meal is made of one or more Items.

**Item**:
One distinct food within a Meal (e.g. "2 eggs" is one Item; "2 eggs and toast" is a Meal with two Items). Each Item is resolved independently — some may come from a Preset, others from a Lookup, within the same Meal.

**Manual Entry**:
A food_log row created directly through the dashboard's food-management tab instead of the bot pipeline. On save, the food name is matched against Presets exactly as elsewhere; a match reuses that Preset's macros, no match creates a new Preset from the typed values. Always ends up with Provenance "preset".
_Avoid_: Manual log, hand-entered food

**Current Consumption**:
Today's food_log rows, shown and editable in the dashboard. Editing changes only the weight; macros are recomputed from the matching Preset (or, if none exists, scaled proportionally from the row's own stored macros).

**Last Day Summary**:
Read-only total macros for yesterday — the most recently completed calendar day, distinct from Current Consumption (today).

**Last Week Average**:
Read-only average of daily total macros over the last 7 calendar days, including today.

### Markets

**Holdings Snapshot**:
A dated Strategy treasury observation: BTC held and Basic Shares Outstanding (actual class A + class B common shares, not diluted), tagged automatic or manual. It applies from 00:00 UTC of its date; at any moment, use the latest Snapshot dated on or before that UTC day. A manual Snapshot replaces an automatic one for the same date, and an automatic save never replaces a manual one. The history starts in August 2020 and comes from SEC EDGAR (8-K "as of" BTC statements, 10-Q / 10-K cover pages for shares), stored on the post-split share scale.

**Strategy Premium**:
`(MSTR close × basic shares) ÷ (BTC held × BTC close) − 1`, shown as a percentage (`50` means +50%; a change between two points is a difference in percentage points), using the Snapshot in effect at the candle. Debt and preferred shares are excluded. Candles before the first Snapshot have no value.

### Android food app

**Pantry**:
The main logging screen of the offline Android app: a search box over one grid of Preset tiles. Tapping a tile opens a number pad for grams. Logging only ever happens one Preset at a time.

**Slot**:
A time-of-day window taken from the phone's clock — Śniadanie (before 11:00), Obiad (11:00–17:00), Kolacja (after 17:00). Boundaries are user-editable. A Slot only changes tile order; it is not stored on log entries.
_Avoid_: Meal (already means one bot message's worth of Items), Set, Zestaw

**Slot tag**:
A mark on a Preset saying it belongs to one or more Slots. During that Slot, tagged Presets come first in the Pantry grid (each group ordered by usage), with no headings.
