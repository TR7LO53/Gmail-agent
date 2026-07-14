import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openaiProvider } from "../../src/llm/provider.js";
import { openDb } from "../../src/memory/db.js";
import { getLastChecked } from "../../src/memory/meta.js";
import { runHeartbeatTick } from "../../src/core/heartbeat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.resolve(__dirname, "../../data/token.json");

const SKIP_E2E = !process.env.OPENAI_API_KEY || !existsSync(TOKEN_PATH);

describe("Heartbeat E2E (real OpenAI + real inbox)", () => {
  it.skipIf(SKIP_E2E)(
    "a single tick completes and records last_checked",
    async () => {
      const db = openDb(":memory:");

      const result = await runHeartbeatTick({ llm: openaiProvider, db }, { maxEmails: 10 });

      expect(result.success).toBe(true);
      expect(getLastChecked(db)).toBeTruthy();

      console.log(`E2E heartbeat classifier: ${JSON.stringify(result.data?.classifier)}`);
      console.log(`E2E heartbeat tracker:    ${JSON.stringify(result.data?.tracker)}`);
      if (result.data?.summary) console.log(`E2E summary: ${result.data.summary}`);
    },
    120000,
  );
});
