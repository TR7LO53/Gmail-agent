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

**Instrument**:
Something actually traded with its own price, all in USD: Bitcoin, Strategy (MSTR), Cameco (CCJ, NYSE listing), gold, silver. Charted as candles.

**Derived Series**:
A value calculated from Instruments rather than traded itself — the Gold/Silver Ratio and the Strategy Premium. Charted as a line built from closing values, never as candles, because combining highs and lows from different moments would invent prices that never existed.
_Avoid_: Indicator (suggests something drawn over a price chart)

**Gold/Silver Ratio**:
How many ounces of silver one ounce of gold buys: gold price ÷ silver price.

**Timeframe**:
How much time one candle covers: H1, H4, D1, W1 or MN (XTB naming). Chosen with buttons; how far back the chart shows is a separate thing, controlled by scrolling and zooming.
_Avoid_: Interval (ambiguous — could mean candle size or visible range), Range

**Watchlist**:
The list on the left of the markets screen: every Instrument and Derived Series with its current value and today's change (percentage points for the Strategy Premium). Clicking an entry puts it into the selected Chart Slot.

**Chart Slot**:
One of the four places in the 2×2 chart grid. Exactly one Slot is selected at any time. Each Slot has its own Timeframe, can be maximized to full screen, and may show the same entry as another Slot (e.g. Bitcoin on H1 next to Bitcoin on W1).
_Avoid_: Slot alone (already means a meal time window in the Android app), Panel, Tile

**Live Candle**:
The newest candle of the chosen Timeframe, still forming. Updated every 5 minutes until its period closes.

**Strategy Premium**:
How far Strategy's (MSTR) market value sits above or below the value of the Bitcoin it holds, as a percentage: `(MSTR close × basic shares) ÷ (BTC held × BTC close) − 1`. Positive is a premium, negative is a discount; `50` means +50%, and a change between two points is a difference in percentage points. Uses the Holdings Snapshot in effect at the candle; candles before the first Snapshot have no value. Debt and preferred shares are deliberately left out.
_Avoid_: mNAV (Strategy's own mNAV is enterprise-value based and differs), NAV premium

**Holdings Snapshot**:
A dated record of how much BTC Strategy holds and its Basic Shares Outstanding (actual class A + class B common shares, not diluted), marked as automatic (read from SEC EDGAR filings) or manual (typed in by the user). It applies from 00:00 UTC of its date; at any moment, use the latest Snapshot dated on or before that UTC day. A manual Snapshot always beats an automatic one for the same date; an automatic reading that shows BTC falling, or rising more than 10% at once, is held back as a warning instead of saved. The history starts in August 2020 and comes from SEC EDGAR (8-K "as of" BTC statements, 10-Q / 10-K cover pages for shares), stored on the post-split share scale. After the seed, new automatic Snapshots are added by the SEC EDGAR reader, at most once every 6 hours.

### Android food app

**Pantry**:
The main logging screen of the offline Android app: a search box over one grid of Preset tiles. Tapping a tile opens a number pad for grams. Logging only ever happens one Preset at a time.

**Slot**:
A time-of-day window taken from the phone's clock — Śniadanie (before 11:00), Obiad (11:00–17:00), Kolacja (after 17:00). Boundaries are user-editable. A Slot only changes tile order; it is not stored on log entries.
_Avoid_: Meal (already means one bot message's worth of Items), Set, Zestaw

**Slot tag**:
A mark on a Preset saying it belongs to one or more Slots. During that Slot, tagged Presets come first in the Pantry grid (each group ordered by usage), with no headings.
