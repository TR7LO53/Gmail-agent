# Yahoo chart fixtures

Unmodified responses from Yahoo's public chart endpoint, used by `tests/unit/markets-yahoo.test.ts`. No redactions. Retrieved 2026-11-20 (UTC) with `User-Agent: Mozilla/5.0`.

| File | Symbol | Interval | Range | Granularity returned | Source URL |
|---|---|---|---|---|---|
| `mstr-1d-5d.json` | MSTR | 1d | 5d | 1d (5 bars) | `https://query1.finance.yahoo.com/v8/finance/chart/MSTR?range=5d&interval=1d` |
| `btc-usd-1d-range-max-downgraded.json` | BTC-USD | 1d | max | **1mo** (147 bars) | `https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=max&interval=1d` |

The second file records why `yahoo.ts` never asks for `range=max` with `1d` or `1wk`: Yahoo silently returns monthly bars instead.

Older tests in this folder's neighbours still use explicitly constructed synthetic payloads; do not label synthetic samples as recordings. When adding a recording, add a row above with the retrieval date, symbol, interval, range and full URL.
