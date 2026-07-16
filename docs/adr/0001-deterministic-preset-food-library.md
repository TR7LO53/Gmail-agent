# Deterministic preset food library, not LLM-mediated

The rest of the nutrition pipeline is LLM-first: every message is parsed by the LLM, and unmatched foods are searched live against USDA FoodData Central. Presets are the deliberate exception — the whole point of a Preset is to skip a slow, costly, occasionally-wrong external call for foods the user eats often. So Presets are matched by deterministic alias comparison (not LLM judgement), stored in a `food_presets` DB table (not a hardcoded source file, so the bot can write to it), and taught/edited/removed via rigid bot commands with a fixed field order (not free-text the LLM extracts).

**Considered and rejected:**
- *LLM-mediated matching* (feed the preset list to the same LLM parse call that already runs) — more forgiving of phrasing, but reintroduces the per-message LLM round-trip the feature exists to avoid, and is less predictable to debug when a match looks wrong.
- *Hardcoded source file* for storage — matches the user's own "hardcode" framing and needs no schema, but the bot can't write to its own source file at runtime, which rules out teaching new presets by chat.
- *LLM-parsed "teach" command* (paste a nutrition label in free text) — more natural to type, but inconsistent with choosing determinism everywhere else for this feature, and adds a failure mode (misparsed macros) with no confirmation step.
