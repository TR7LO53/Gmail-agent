# Scoped write access for food data in the dashboard

The web dashboard (`src/ui/app.ts`) was built as a pure viewer — its doc comment states it "only ever READS the DB — no writes." We're adding a food-management tab with full CRUD on `food_log` and `food_presets`, which breaks that invariant for the first time.

We scoped the break to food data only. `parcels`, `decisions`, `emails`, `observations`, and `logs` stay read-only in the dashboard: those rows are written by agents alongside reasoning trails (`agent_reasoning`, `outcome`), and a manual edit could silently invalidate that trail without any record of why. Food data has no such trail to protect. Parcel management was raised as a possible future tab but deliberately deferred, not folded into this change.

No new auth was added to guard the new write endpoints — the server already binds to `127.0.0.1` only, with no auth anywhere else in the app.

## Amendment (2026-10-16): AI News settings

The dashboard may also write the AI News settings: the sender list (`news_senders`) and the interests text (one `meta` row). These are the user's own configuration, not agent output, so the reasoning above does not apply to them. `news_summaries` stays read-only in the dashboard, since the news agent writes it. Like food edits, every settings write is logged to `logs` with source `manual-edit`.

## Amendment (2026-11-20): Holdings Snapshots

The Markets tab may write manual Holdings Snapshots (Strategy's BTC held and shares outstanding on a date). Automatic Snapshots are read from SEC EDGAR filings and can be misread; the manual form is the user's correction path, so it must be writable. Market prices are never stored at all — they are fetched from Yahoo Finance on demand — so there is nothing else on that tab to write.

Markets storage may write Strategy Holdings Snapshots (`holdings_snapshots`). A manual write replaces the Snapshot for that date and is logged to `logs` with source `manual-edit` (values before and after); an automatic write never replaces a manual Snapshot. An automatic reading that fails the sanity check (BTC held lower than the latest Snapshot, or more than 10% higher) is not saved: it is kept as a pending warning in `meta` (`markets_holdings_warning`) and logged as a `markets` warning. The one-time history seed, loaded by `openDb` only into an empty table, writes to `holdings_snapshots` alone. This permission covers `holdings_snapshots` and that warning row; other agent data stays outside the dashboard's write scope.
