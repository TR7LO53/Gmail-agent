# Strategy holdings history (`holdings-history.json`)

Seed for the `holdings_snapshots` table (ticket #35). `openDb` loads it **once**, when the table has no
rows at all; after that the table is the source of truth and this file is never read again.

## Where it comes from

SEC EDGAR, Strategy / MicroStrategy, CIK `0001050446`. Built on **2026-11-20** with:

```
npm --prefix gmail-agent run build-holdings-history
```

The script (`src/scripts/build-holdings-history.ts`) is run by hand; the app never runs it. It needs the
environment variable `SEC_USER_AGENT` (app name + contact, required by SEC fair-access rules) and stops
without any request when it is missing. Requests go out one at a time with a 200 ms pause; raw responses
are cached in `<tmp>/holdings-edgar-cache`, outside the repo. The script refuses to write the file when it
finds a problem (a cover page it cannot read, a BTC drop that no filing explains, a first row outside
August 2020).

Both submissions files are read: `CIK0001050446.json` (about 2021-11 → today) **and**
`CIK0001050446-submissions-001.json` (1998 → 2021-11). Without the second one 2020–2021 is missing.

## Rules

- **BTC held** — 8-Ks filed since 2020-08-01 that state the *aggregate* holding: sentences ("held an
  aggregate of approximately X bitcoins", "holds approximately X bitcoins", "X bitcoins held by …"), the
  weekly "BTC Update" table (4th number: *Aggregate BTC Holdings*; the quarter-end filings have one such
  line per period), and earnings releases ("X bitcoin holdings … as of <date>", "digital assets were
  comprised of approximately X bitcoins"). Exhibit 99 press releases are read when the main document has
  no statement. The row date is the **"as of" date** in the text, not the filing date. One row per date
  (latest filing wins; there were no conflicting numbers).
- **Purchases are not holdings.** Exception, read by hand: `0001193125-20-215604` (2020-08-11, "has
  purchased 21,454 bitcoins" — the first purchase, so the whole holding; the 2020-09-15 filing confirms it:
  21,454 + 16,796 = 38,250) and `0001193125-20-245835` ("To date, the Company has purchased a total of
  38,250 bitcoins", about the purchase completed 2020-09-14; no sales yet).
- **Shares outstanding** — class A + class B from the cover page of every 10-Q / 10-K since 2020-01-01
  ("As of <date>, the registrant had X and Y shares of class A common stock and class B common stock
  outstanding"). Basic shares, not diluted, not FDSO/ADSO. XBRL has no such number (`dei` gives 404), so the
  cover page is the only source. All 28 reports were read.
- **Carry-forward** — a BTC row uses the latest share count dated on or before its own date, never a later
  one. The row records that count's own date and accession (`shares_source`).
- **Split** — 10-for-1, effective **2024-08-08** (first split-adjusted trading day). Share counts dated
  before that are multiplied by 10 (`split_factor` in each row), so they match the split-adjusted MSTR
  prices from Yahoo. The 10-Q filed 2024-08-06 reports 17,468,045 + 1,964,025 shares "as of July 25, 2024":
  that is a pre-split count, so it is ×10 (194,320,700) — consistent with the post-split 10-Q of
  2024-10-31.
- **BTC drops** — the history is not strictly increasing: Strategy *sold* bitcoin in mid-2026. Five rows
  are lower than the one before; each comes from a filing with a "BTC Sold" table and carries
  `btc_source.sold: true`: 2026-05-31, 2026-06-30, 2026-07-05, 2026-08-02, 2026-08-09. The script accepts a
  drop only in that case. (The ticket said "BTC never decreases"; that does not hold in the filed data.
  The seed test allows a drop only where `btc_source.sold` is set.)
- **Raw numbers stay here.** Only `date`, `btc_held`, `shares_outstanding` go to the table
  (`source = 'automatic'`).

## Checked by hand against the filings

| Row | BTC | Shares | Source filings | Result |
| --- | --- | --- | --- | --- |
| 2020-08-11 (first) | 21,454 | (7,650,993 + 2,035,184) × 10 = 96,861,770 | 8-K `0001193125-20-215604` (press release: "purchased 21,454 bitcoins"); 10-Q `0001564590-20-033897` (as of 2020-07-20) | matches |
| 2020-09-14 | 38,250 | same count carried forward | 8-K `0001193125-20-245835` | matches |
| 2022-06-28 (mid-2022) | 129,699 | (9,333,523 + 1,964,025) × 10 = 112,975,480 | 8-K `0001193125-22-184423` ("held an aggregate of approximately 129,699 bitcoins" as of June 28, 2022); 10-Q `0001564590-22-017437` (as of 2022-04-26) | matches |
| 2024-06-20 (before split) | 226,331 | (15,773,406 + 1,964,025) × 10 = 177,374,310 | 8-K `0001193125-24-164014`; 10-Q `0000950170-24-051230` (as of 2024-04-24) | matches |
| 2024-09-12 (after split) | 244,800 | (17,468,045 + 1,964,025) × 10 = 194,320,700 | 8-K `0001193125-24-218462`; 10-Q `0000950170-24-091778` (as of 2024-07-25) | matches; ratio after/before = 1.10, same scale |
| 2026-11-15 (newest) | 850,849 | 402,714,357 + 19,640,250 = 422,354,607 | 8-K `0001193125-26-462151` (weekly table, as of November 15, 2026); 10-Q `0001050446-26-000060` (as of 2026-10-25) | matches |

## Known gaps and skipped filings

- The history only has dates that an 8-K states. Between statements the table holds the last value, so the
  premium line uses an older BTC figure in the gaps. Gaps longer than 60 days (no 8-K states a holding):
  2020-09-14 → 2020-12-04, 2021-05-18 → 2021-08-23, 2021-09-12 → 2021-11-29, 2022-01-31 → 2022-04-04,
  2022-04-04 → 2022-06-28, 2022-06-28 → 2022-09-19, 2022-09-19 → 2022-12-27, 2022-12-27 → 2023-03-23,
  2023-04-04 → 2023-06-27, 2023-06-27 → 2023-09-24, 2023-09-24 → 2023-11-29. Strategy bought bitcoin in
  some of these periods (for example the December 2020 purchases) but announced it in press releases that
  were not filed as an 8-K; the ticket asks for 8-K statements only, so they are not guessed.
- 239 8-Ks were read since 2020-08-01; 149 gave a holding, 90 did not. The 90 are offerings, ATM/dividend
  notices, governance items, earnings releases without an "as of" holding, and similar. Accession numbers
  below; `*` marks filings that mention bitcoin but state no aggregate holding. I looked at a sample by
  hand (policy notice, notes offerings, "existing approximately 92,079 bitcoins will be held by
  MacroStrategy", collateral releases, ATM tables without a holdings line) and ran a text scan over all of
  them for holdings wording; the scan found only statements already in the history or ones I added a
  pattern for. Not every one of the 90 was read in full:

  2020-09-14 0001193125-20-244732*; 2020-12-09 0001193125-20-313349*; 2020-12-11 0001193125-20-315971*; 2021-01-28 0001193125-21-020760*; 2021-02-17 0001193125-21-045792*; 2021-02-19 0001193125-21-048555*; 2021-04-12 0001193125-21-112475*; 2021-06-02 0001193125-21-179845; 2021-06-07 0001193125-21-183788*; 2021-06-08 0001193125-21-185538*; 2021-06-14 0001193125-21-189600*; 2021-11-03 0001193125-21-318432; 2022-02-01 0001193125-22-024607*; 2022-03-29 0001193125-22-087494*; 2022-06-01 0001193125-22-165191; 2022-09-01 0001193125-22-235480; 2022-09-09 0001193125-22-242015; 2023-01-18 0001193125-23-009591; 2023-02-02 0001193125-23-022753*; 2023-03-02 0001193125-23-057314; 2023-04-04 0001193125-23-090347; 2023-05-01 0001193125-23-130703; 2023-05-30 0001193125-23-156662; 2023-07-07 0001193125-23-183313; 2023-08-01 0001193125-23-200633; 2024-03-06 0001193125-24-060026*; 2024-03-11 0001193125-24-064321*; 2024-03-15 0001193125-24-068621*; 2024-03-19 0001193125-24-070793*; 2024-05-24 0001193125-24-147023; 2024-06-03 0001193125-24-152373; 2024-06-14 0001193125-24-161184*; 2024-06-20 0001193125-24-164009*; 2024-07-05 0001193125-24-175343; 2024-07-11 0001193125-24-177515*; 2024-09-18 0001193125-24-221085*; 2024-09-20 0001193125-24-222462*; 2024-10-30 0000950170-24-118951*; 2024-10-30 0001193125-24-247543; 2024-11-20 0001193125-24-262151*; 2024-11-21 0001193125-24-263404*; 2024-12-20 0001193125-24-283170*; 2025-01-03 0001193125-25-001543*; 2025-01-23 0001193125-25-011455; 2025-01-24 0001193125-25-011819; 2025-01-31 0001193125-25-017726*; 2025-02-05 0000950170-25-014455*; 2025-02-05 0001193125-25-020868; 2025-02-20 0001193125-25-030144*; 2025-02-24 0001193125-25-032800*; 2025-03-18 0001193125-25-056203*; 2025-03-21 0001193125-25-059786*; 2025-03-25 0001193125-25-062523; 2025-05-01 0001193125-25-109959; 2025-05-22 0001193125-25-124568*; 2025-06-02 0001193125-25-133461*; 2025-06-06 0001193125-25-136301*; 2025-06-10 0001193125-25-138477; 2025-06-16 0001193125-25-141411; 2025-06-23 0000950170-25-088731*; 2025-07-01 0001193125-25-153997; 2025-07-07 0001193125-25-155918*; 2025-07-21 0001193125-25-161916*; 2025-07-23 0001193125-25-163041; 2025-07-25 0001193125-25-164852*; 2025-07-31 0001193125-25-170550*; 2025-08-11 0001193125-25-177517; 2025-08-28 0001193125-25-190363; 2025-09-02 0001193125-25-193487*; 2025-09-30 0001193125-25-225038*; 2025-10-01 0001193125-25-225904*; 2025-11-03 0001193125-25-262819*; 2025-11-04 0001193125-25-263914; 2025-11-07 0001193125-25-271105*; 2025-11-13 0001193125-25-280178; 2026-01-02 0001193125-26-000264*; 2026-02-02 0001193125-26-033573*; 2026-03-23 0001193125-26-118810; 2026-04-01 0001193125-26-135765*; 2026-05-01 0001193125-26-199155*; 2026-05-15 0001193125-26-225361*; 2026-06-08 0001193125-26-261038; 2026-06-10 0001193125-26-265108; 2026-06-15 0001193125-26-270366*; 2026-09-01 0001193125-26-377583*; 2026-09-25 0001193125-26-401636; 2026-10-01 0001193125-26-409863*; 2026-10-16 0001193125-26-423400*; 2026-10-28 0001193125-26-435451; 2026-10-29 0001193125-26-437776*.

- Amended filings (`/A`) are not used; the only one since 2020 is an 8-K/A filed 2026-07-31
  (`0001050446-26-000036`).
- Rows at the very end follow the newest weekly 8-K at build time; the automatic reader (#36) keeps the
  table current after that.
