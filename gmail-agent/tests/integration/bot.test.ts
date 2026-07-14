import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { handleIncoming, type BotDeps } from "../../src/bot/discord.js";
import { listTodaysFood } from "../../src/memory/food.js";
import { startOfLocalDayIso } from "../../src/memory/emails.js";
import type { LLMProvider } from "../../src/llm/provider.js";
import type { NutritionProvider } from "../../src/nutrition/provider.js";
import type { DB } from "../../src/memory/db.js";

function memDb(): DB {
  return openDb(":memory:");
}

// parseFoodItems reads `{ items }` off the LLM; this fake always parses to one egg (original "jajko").
const parseLLM: LLMProvider = {
  async extract<T>(): Promise<T> {
    return { items: [{ original: "jajko", name: "egg", grams: 100 }] } as T;
  },
};

function fakeNutrition(kcal = 150): NutritionProvider {
  return {
    async lookupItems(items) {
      return {
        items: [
          { original: items[0]?.original, name: "egg, cooked", qty: items[0]?.grams, kcal, protein_g: 12, carbs_g: 1, fat_g: 10, matched: true },
        ],
        totals: { kcal, protein_g: 12, carbs_g: 1, fat_g: 10 },
      };
    },
  };
}

function makeDeps(db: DB, over: Partial<BotDeps> = {}): BotDeps {
  return {
    db,
    llm: parseLLM,
    nutrition: fakeNutrition(),
    transcribe: async () => "throw if used",
    ...over,
  };
}

describe("handleIncoming routing", () => {
  let db: DB;
  let replies: string[];
  const reply = async (m: string) => {
    replies.push(m);
  };

  beforeEach(() => {
    db = memDb();
    replies = [];
  });

  it("text path: logs food and replies with a per-item confirmation", async () => {
    await handleIncoming({ text: "2 jajka", reply }, makeDeps(db));
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(1);
    expect(replies[0]).toContain("Zapisałem");
    expect(replies[0]).toContain("jajko"); // the original (Polish) name is echoed back
    expect(replies[0]).toContain("egg, cooked"); // matched food
    expect(replies[0]).toContain("kcal");
    expect(replies[0]).toContain("Dziś:"); // daily totals line
  });

  it("voice path: downloads + transcribes, then logs", async () => {
    let transcribed = false;
    const deps = makeDeps(db, {
      fetchAudio: async () => ({ data: Buffer.from("x"), filename: "voice.ogg" }),
      transcribe: async () => {
        transcribed = true;
        return "dwa jajka";
      },
    });
    await handleIncoming(
      { audio: { url: "https://cdn.discord/voice.ogg", contentType: "audio/ogg" }, reply },
      deps,
    );
    expect(transcribed).toBe(true);
    const rows = listTodaysFood(db, startOfLocalDayIso());
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("voice");
  });

  it("`today` command reports totals without logging", async () => {
    await handleIncoming({ text: "2 jajka", reply }, makeDeps(db));
    replies.length = 0;
    await handleIncoming({ text: "today", reply }, makeDeps(db));
    expect(replies[0]).toContain("Dziś:");
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(1);
  });

  it("`undo` removes the last meal", async () => {
    await handleIncoming({ text: "2 jajka", reply }, makeDeps(db));
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(1);
    await handleIncoming({ text: "undo", reply }, makeDeps(db));
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(0);
    expect(replies.at(-1)).toContain("Cofnięto");
  });

  it("replies helpfully when the database matches nothing", async () => {
    const deps = makeDeps(db, {
      nutrition: {
        async lookupItems() {
          return { items: [], totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } };
        },
      },
    });
    await handleIncoming({ text: "blablabla", reply }, deps);
    expect(replies[0]).toContain("Nie rozpoznałem");
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(0);
  });
});
