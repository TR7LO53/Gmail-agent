import { Client, GatewayIntentBits, Partials, Events } from "discord.js";
import type { LLMProvider } from "../llm/provider.js";
import type { DB } from "../memory/db.js";
import type { NutritionProvider, NutritionTotals, NutritionItem } from "../nutrition/provider.js";
import type { Transcriber, AudioInput } from "../llm/transcribe.js";
import { logMeal } from "../agents/nutrition-log.js";
import { todaysTotals, deleteLast } from "../memory/food.js";
import { addPreset, updatePreset, removePreset, listPresets, type FoodPreset } from "../memory/presets.js";
import { startOfLocalDayIso } from "../memory/emails.js";
import { nutritionGoals, type NutritionGoals } from "../config.js";

/**
 * Discord food-logging bot. The gateway wiring is thin; all logic lives in `handleIncoming`, which
 * is pure enough to unit-test with fakes. Routing: an audio attachment → voice path (download +
 * transcribe); otherwise text. Commands (`today`, `undo`) are matched before the food path. Every
 * food message flows through the shared `logMeal` pipeline (translate → Nutritionix → store).
 */

export interface BotDeps {
  llm: LLMProvider;
  nutrition: NutritionProvider;
  db: DB;
  transcribe: Transcriber;
  /** Download a voice attachment. Injectable so tests avoid the network. */
  fetchAudio?: (url: string, name?: string) => Promise<AudioInput>;
}

export interface IncomingInput {
  text?: string;
  audio?: { url: string; contentType?: string; name?: string };
  reply: (message: string) => Promise<void>;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Polish one-liner: kcal + macros (B=białko, W=węglowodany, T=tłuszcz) vs goals. */
function formatTotals(t: NutritionTotals, g: NutritionGoals): string {
  return `Dziś: ${Math.round(t.kcal)}/${g.kcal} kcal · ${round1(t.protein_g)}/${g.protein_g} g B · ${round1(t.carbs_g)}/${g.carbs_g} g W · ${round1(t.fat_g)}/${g.fat_g} g T`;
}

/** One confirmation block per food: original (your) name + weight → matched food + its macros. */
function formatItemLine(it: NutritionItem): string {
  const head = `• ${it.original ?? it.name} — ${it.qty ?? "?"} g`;
  if (it.matched === false) return `${head}\n  ⚠️ nie znaleziono w bazie`;
  return `${head}\n  → ${it.name}\n  ${Math.round(it.kcal)} kcal · ${round1(it.protein_g)} g B · ${round1(it.carbs_g)} g W · ${round1(it.fat_g)} g T`;
}

function formatMealReply(
  items: NutritionItem[],
  meal: NutritionTotals,
  day: NutritionTotals,
  goals: NutritionGoals,
): string {
  return [
    "📝 Zapisałem:",
    "",
    items.map(formatItemLine).join("\n\n"),
    "",
    `Σ Posiłek: ${Math.round(meal.kcal)} kcal · ${round1(meal.protein_g)} g B · ${round1(meal.carbs_g)} g W · ${round1(meal.fat_g)} g T`,
    `📊 ${formatTotals(day, goals)}`,
  ].join("\n");
}

function presetFormatHint(cmd: string): string {
  return `Nie rozpoznałem formatu. Użyj: ${cmd} | nazwa | kcal | białko | węgle | tłuszcz | aliasy (opcjonalnie)`;
}

/** Parses the fixed `name | kcal | protein | carbs | fat | aliases` fields shared by dodaj/edytuj. */
function parsePresetFields(
  fieldsPart: string,
): { name: string; kcal: number; protein_g: number; carbs_g: number; fat_g: number; aliases: string[] } | undefined {
  const [name, kcalStr, proteinStr, carbsStr, fatStr, aliasesStr] = fieldsPart
    .split("|")
    .map((p) => p.trim());
  const kcal = Number(kcalStr);
  const protein_g = Number(proteinStr);
  const carbs_g = Number(carbsStr);
  const fat_g = Number(fatStr);
  if (!name || ![kcal, protein_g, carbs_g, fat_g].every(Number.isFinite)) return undefined;
  const aliases = aliasesStr ? aliasesStr.split(",").map((a) => a.trim()).filter(Boolean) : [];
  return { name, kcal, protein_g, carbs_g, fat_g, aliases };
}

function formatPresetLine(p: FoodPreset): string {
  const aliases = p.aliases.length ? ` (aliasy: ${p.aliases.join(", ")})` : "";
  return `• ${p.name} — ${p.kcal} kcal · ${p.protein_g} g B · ${p.carbs_g} g W · ${p.fat_g} g T${aliases}`;
}

const HELP_TEXT = [
  "📖 Dostępne komendy:",
  "",
  "• dodaj | nazwa | kcal | białko | węgle | tłuszcz | aliasy(opcjonalnie) — dodaje nowy produkt do listy",
  "• edytuj | nazwa | kcal | białko | węgle | tłuszcz | aliasy(opcjonalnie) — nadpisuje istniejący produkt",
  "• usuń | nazwa — usuwa produkt z listy",
  "• lista — pokazuje wszystkie zapisane produkty",
  "• today / dzisiaj — pokazuje dzisiejsze podsumowanie kalorii i makro",
  "• /report / /sumup — to samo co today/dzisiaj",
  "• undo / cofnij — cofa ostatni zapisany posiłek",
  "• help / pomoc — pokazuje tę wiadomość",
].join("\n");

async function defaultFetchAudio(url: string, name?: string): Promise<AudioInput> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`audio download failed: ${res.status}`);
  return { data: Buffer.from(await res.arrayBuffer()), filename: name ?? "audio.ogg" };
}

async function logAndReply(
  text: string,
  source: "text" | "voice",
  input: IncomingInput,
  deps: BotDeps,
): Promise<void> {
  const r = await logMeal(text, source, { llm: deps.llm, nutrition: deps.nutrition, db: deps.db });
  if (!r.success || !r.data) {
    await input.reply(`Nie rozpoznałem jedzenia w tej wiadomości. ${r.recovery ?? ""}`.trim());
    return;
  }
  await input.reply(formatMealReply(r.data.items, r.data.mealTotals, r.data.dayTotals, r.data.goals));
}

export async function handleIncoming(input: IncomingInput, deps: BotDeps): Promise<void> {
  // Voice path: download + transcribe, then the shared food pipeline.
  if (input.audio) {
    try {
      const audio = await (deps.fetchAudio ?? defaultFetchAudio)(input.audio.url, input.audio.name);
      const transcript = await deps.transcribe(audio);
      if (!transcript.trim()) {
        await input.reply("Nie rozpoznałem mowy w tej wiadomości głosowej.");
        return;
      }
      await logAndReply(transcript, "voice", input, deps);
    } catch {
      await input.reply("Nie udało się przetworzyć wiadomości głosowej. Spróbuj ponownie.");
    }
    return;
  }

  const raw = (input.text ?? "").trim();
  if (!raw) return;
  const lower = raw.toLowerCase();

  if (lower === "help" || lower === "pomoc") {
    await input.reply(HELP_TEXT);
    return;
  }

  if (lower === "today" || lower === "dzisiaj" || lower === "/report" || lower === "/sumup") {
    await input.reply(formatTotals(todaysTotals(deps.db, startOfLocalDayIso()), nutritionGoals()));
    return;
  }

  if (lower === "undo" || lower === "cofnij") {
    const removed = deleteLast(deps.db);
    const totals = formatTotals(todaysTotals(deps.db, startOfLocalDayIso()), nutritionGoals());
    await input.reply(removed > 0 ? `Cofnięto ostatni wpis. ${totals}` : "Brak wpisów do cofnięcia.");
    return;
  }

  if (lower === "lista") {
    const presets = listPresets(deps.db);
    if (presets.length === 0) {
      await input.reply("Nie masz jeszcze żadnych zapisanych produktów.");
      return;
    }
    await input.reply(["📋 Twoje produkty:", "", presets.map(formatPresetLine).join("\n")].join("\n"));
    return;
  }

  if (lower.startsWith("dodaj")) {
    const fields = parsePresetFields(raw.slice(raw.indexOf("|") + 1));
    if (!fields) {
      await input.reply(presetFormatHint("dodaj"));
      return;
    }
    try {
      addPreset(deps.db, fields);
    } catch {
      await input.reply(`Produkt "${fields.name}" już istnieje. Użyj edytuj, żeby go zaktualizować.`);
      return;
    }
    await input.reply(`Dodałem "${fields.name}" do listy produktów.`);
    return;
  }

  if (lower.startsWith("edytuj")) {
    const fields = parsePresetFields(raw.slice(raw.indexOf("|") + 1));
    if (!fields) {
      await input.reply(presetFormatHint("edytuj"));
      return;
    }
    try {
      updatePreset(deps.db, fields);
    } catch {
      await input.reply(`Nie znalazłem produktu "${fields.name}" na liście.`);
      return;
    }
    await input.reply(`Zaktualizowałem "${fields.name}".`);
    return;
  }

  if (lower.startsWith("usuń")) {
    const name = raw.slice(raw.indexOf("|") + 1).trim();
    if (!removePreset(deps.db, name)) {
      await input.reply(`Nie znalazłem produktu "${name}" na liście.`);
      return;
    }
    await input.reply(`Usunąłem "${name}" z listy produktów.`);
    return;
  }

  await logAndReply(raw, "text", input, deps);
}

/** Wire discord.js to `handleIncoming`. Returns the client, or undefined if no token is configured. */
export function startBot(deps: BotDeps): Client | undefined {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log("Discord bot: DISCORD_BOT_TOKEN not set — skipping bot.");
    return undefined;
  }
  const allowed = process.env.DISCORD_ALLOWED_USER_ID;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // required to receive DMs
  });

  client.once(Events.ClientReady, (c) => console.log(`Discord bot online as ${c.user.tag}`));

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (allowed && message.author.id !== allowed) return;

    const audio = message.attachments.find(
      (a) =>
        (a.contentType ?? "").startsWith("audio") || /\.(ogg|oga|mp3|m4a|wav|webm)$/i.test(a.name ?? ""),
    );

    try {
      await handleIncoming(
        {
          text: message.content,
          audio: audio
            ? { url: audio.url, contentType: audio.contentType ?? undefined, name: audio.name }
            : undefined,
          reply: async (msg) => {
            await message.reply(msg);
          },
        },
        deps,
      );
    } catch (err) {
      console.error("Bot handler error:", err instanceof Error ? err.message : err);
    }
  });

  void client.login(token);
  return client;
}
