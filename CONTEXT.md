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
