import { readEnv } from "../env.js";
import type { DB } from "../memory/db.js";
import { createMarketsActivityLogger } from "./activity.js";
import { refreshHoldingsFromSec } from "./holdings-reader.js";
import type { MarketsDeps } from "./service.js";
import { createPriceSource } from "./source.js";

/**
 * The real Markets dependencies (Yahoo prices, SEC reader). Only the entry points import this, so
 * `createApp` and the tests never reach the network or load `.env`.
 */
export function createMarketsDeps(db: DB): MarketsDeps {
  return {
    priceSource: createPriceSource({ fetchImpl: fetch, logger: createMarketsActivityLogger(db) }),
    refreshHoldings: () => refreshHoldingsFromSec({ db, fetchImpl: fetch, userAgent: readEnv("SEC_USER_AGENT") }),
  };
}
