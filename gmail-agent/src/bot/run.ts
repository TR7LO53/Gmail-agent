import { logEnvStatus, hasEnv } from "../env.js";
import { openDb } from "../memory/db.js";
import { openaiProvider } from "../llm/provider.js";
import { usdaProvider } from "../nutrition/provider.js";
import { openaiTranscriber } from "../llm/transcribe.js";
import { startBot } from "./discord.js";

/** Standalone Discord bot entry (`npm run bot`). The launcher (start.ts) also starts it. */
logEnvStatus(["DISCORD_BOT_TOKEN", "DISCORD_ALLOWED_USER_ID", "USDA_API_KEY", "OPENAI_API_KEY"]);
if (!hasEnv("USDA_API_KEY")) {
  console.warn("WARNING: USDA_API_KEY is missing — food logging will fail until it's set in .env.");
}

const db = openDb();
const client = startBot({
  llm: openaiProvider,
  nutrition: usdaProvider,
  db,
  transcribe: openaiTranscriber,
});

if (!client) {
  console.log("Nothing to run without DISCORD_BOT_TOKEN. Add it to .env, then `npm run bot`.");
  process.exit(0);
}

process.on("SIGINT", () => {
  void client.destroy();
  process.exit(0);
});
