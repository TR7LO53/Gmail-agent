# Yahoo chart fixtures

Unmodified responses from Yahoo's public chart endpoint, used by `tests/unit/markets-yahoo.test.ts`. No redactions. Retrieved 2026-11-20 (UTC) with `User-Agent: Mozilla/5.0`.

| File | Symbol | Interval | Range | Granularity returned | Source URL |
|---|---|---|---|---|---|
| `mstr-1d-5d.json` | MSTR | 1d | 5d | 1d (5 bars) | `https://query1.finance.yahoo.com/v8/finance/chart/MSTR?range=5d&interval=1d` |
| `btc-usd-1d-range-max-downgraded.json` | BTC-USD | 1d | max | **1mo** (147 bars) | `https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=max&interval=1d` |
| `btc-usd-1h-1d.json` | BTC-USD | 1h | 1d | 1h (16 bars, last one a latest-trade point at 14:15) | `https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=1d&interval=1h` |
| `gc-f-1d-2mo.json` | GC=F | 1d | 2mo | 1d (45 bars; November opens 3890.0 on 2026-11-02) | `https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?range=2mo&interval=1d` |

Why these exist:

- `btc-usd-1d-range-max-downgraded.json`: `yahoo.ts` never asks for `range=max` with `1d`, because Yahoo silently returns monthly bars instead.
- `btc-usd-1h-1d.json`: Yahoo appends a latest-trade point inside the current hour, which `foldHourlyLatestTrade` merges into that hour's bar.
- `gc-f-1d-2mo.json`: W1 and MN are built from daily bars. On 2026-11-20 Yahoo's own `1mo` bar for GC=F opened at that day's 3633.8, not at November's 3890.0.

Older tests in this folder's neighbours still use explicitly constructed synthetic payloads; do not label synthetic samples as recordings. When adding a recording, add a row above with the retrieval date, symbol, interval, range and full URL.
