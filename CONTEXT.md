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
