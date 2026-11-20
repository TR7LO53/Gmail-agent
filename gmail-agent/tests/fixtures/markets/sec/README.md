# SEC EDGAR fixtures (Strategy, CIK 0001050446)

Real, **unmodified** responses from SEC EDGAR, used by `tests/unit/holdings-reader.test.ts`. No redactions, no shortening, no hand-made JSON. They were fetched on 2026-11-20 by `npm run build-holdings-history` (one request per file, `User-Agent` from `SEC_USER_AGENT`) and copied byte for byte from that script's cache (`%TEMP%\holdings-edgar-cache`). The retrieval times below are local time in Poland (CET, UTC+1).

`.gitattributes` marks this folder `-text`, so Git does not change line endings and the files stay byte for byte as EDGAR sent them.

| File | Source URL | Retrieved (CET) | What it holds | Used for |
|---|---|---|---|---|
| `submissions-CIK0001050446.json` | `https://data.sec.gov/submissions/CIK0001050446.json` | 2026-11-20 16:19 | Filing list (`filings.recent`, 1000 filings, newest 8-K filed 2026-11-16, newest 10-Q filed 2026-11-02) | Which 8-Ks and 10-Qs exist |
| `8k-0001193125-26-462151-mstr-20261116.htm` | `https://www.sec.gov/Archives/edgar/data/1050446/000119312526462151/mstr-20261116.htm` | 2026-11-20 16:21 | 8-K filed 2026-11-16; weekly table "as of 2026-11-15", aggregate BTC holdings 850,849 | Reading BTC + date; the new reading in a full run |
| `8k-0001193125-26-452693-mstr-20261109.htm` | `https://www.sec.gov/Archives/edgar/data/1050446/000119312526452693/mstr-20261109.htm` | 2026-11-20 16:21 | 8-K filed 2026-11-09; "as of 2026-11-08", aggregate BTC holdings 850,364 | The reading that is already stored (not newer) |
| `10q-0001050446-26-000060-mstr-20260930.htm` | `https://www.sec.gov/Archives/edgar/data/1050446/000105044626000060/mstr-20260930.htm` | 2026-11-20 16:19 | 10-Q filed 2026-11-02; cover page "as of 2026-10-25": 402,714,357 class A + 19,640,250 class B shares | Shares outstanding, carry-forward |

Notes:

- The XBRL `dei` route for share counts returns 404 for this company, so the reader takes shares from the 10-Q / 10-K cover page only (see `src/markets/data/README.md`).
- Tests that need a broken input change the body in test code (for example `body.replace(...)`); they never edit the files here.
- When adding a recording, add a row with the retrieval date and time, the full URL and the test that uses it.
