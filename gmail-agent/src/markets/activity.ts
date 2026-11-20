import { logEvent } from "../memory/logs.js";
import type { DB } from "../memory/db.js";
import type { MarketLogger } from "./types.js";

/** Adapts source failures to the already-open database used by the application. */
export function createMarketsActivityLogger(db: DB): MarketLogger {
  return (error) => logEvent(db, {
    source: "markets",
    level: "error",
    message: `${error.symbol} ${error.operation}: ${error.message}`,
    data: { symbol: error.symbol, operation: error.operation, category: error.category },
  });
}
