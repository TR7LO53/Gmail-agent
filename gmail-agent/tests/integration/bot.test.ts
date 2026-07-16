import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../src/memory/db.js";
import { handleIncoming, type BotDeps } from "../../src/bot/discord.js";
import { listTodaysFood } from "../../src/memory/food.js";
import { addPreset, findPresetByName } from "../../src/memory/presets.js";
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

  it("`/report` produces the same reply content as `today`", async () => {
    await handleIncoming({ text: "2 jajka", reply }, makeDeps(db));
    replies.length = 0;
    await handleIncoming({ text: "today", reply }, makeDeps(db));
    const todayReply = replies[0];
    replies.length = 0;
    await handleIncoming({ text: "/report", reply }, makeDeps(db));
    expect(replies[0]).toBe(todayReply);
  });

  it("`/sumup` produces the same reply content as `dzisiaj`", async () => {
    await handleIncoming({ text: "2 jajka", reply }, makeDeps(db));
    replies.length = 0;
    await handleIncoming({ text: "dzisiaj", reply }, makeDeps(db));
    const dzisiajReply = replies[0];
    replies.length = 0;
    await handleIncoming({ text: "/sumup", reply }, makeDeps(db));
    expect(replies[0]).toBe(dzisiajReply);
  });

  it("`help` lists every bot command", async () => {
    await handleIncoming({ text: "help", reply }, makeDeps(db));
    for (const cmd of [
      "dodaj",
      "edytuj",
      "usuń",
      "lista",
      "today",
      "dzisiaj",
      "undo",
      "cofnij",
      "help",
      "pomoc",
      "/report",
      "/sumup",
    ]) {
      expect(replies[0]).toContain(cmd);
    }
  });

  it("`pomoc` produces the same reply as `help`", async () => {
    await handleIncoming({ text: "help", reply }, makeDeps(db));
    const helpReply = replies[0];
    replies.length = 0;
    await handleIncoming({ text: "pomoc", reply }, makeDeps(db));
    expect(replies[0]).toBe(helpReply);
  });

  it("`undo` removes the last meal", async () => {
    await handleIncoming({ text: "2 jajka", reply }, makeDeps(db));
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(1);
    await handleIncoming({ text: "undo", reply }, makeDeps(db));
    expect(listTodaysFood(db, startOfLocalDayIso())).toHaveLength(0);
    expect(replies.at(-1)).toContain("Cofnięto");
  });

  it("`dodaj` adds a preset and replies with a Polish confirmation", async () => {
    await handleIncoming(
      { text: "dodaj | pierś z kurczaka | 165 | 31 | 0 | 3.6 | kurczak, chicken breast", reply },
      makeDeps(db),
    );
    const saved = findPresetByName(db, "pierś z kurczaka");
    expect(saved?.kcal).toBe(165);
    expect(saved?.aliases).toEqual(["kurczak", "chicken breast"]);
    expect(replies[0]).toContain("Dodałem");
    expect(replies[0]).toContain("pierś z kurczaka");
  });

  it("`dodaj` with a missing macro replies with an error and saves nothing", async () => {
    await handleIncoming(
      { text: "dodaj | pierś z kurczaka | 165 | 31 | 0", reply },
      makeDeps(db),
    );
    expect(findPresetByName(db, "pierś z kurczaka")).toBeUndefined();
    expect(replies[0]).not.toContain("Dodałem");
    expect(replies[0]).toContain("dodaj | nazwa | kcal | białko | węgle | tłuszcz");
  });

  it("`dodaj` with a name that already exists replies with an error and leaves it unchanged", async () => {
    await handleIncoming(
      { text: "dodaj | jajko | 155 | 13 | 1.1 | 11", reply },
      makeDeps(db),
    );
    replies.length = 0;
    await handleIncoming(
      { text: "dodaj | jajko | 200 | 20 | 2 | 15", reply },
      makeDeps(db),
    );
    expect(findPresetByName(db, "jajko")?.kcal).toBe(155);
    expect(replies[0]).not.toContain("Dodałem");
    expect(replies[0]).toContain("jajko");
  });

  it("`dodaj` allows a similarly-named but distinct preset", async () => {
    await handleIncoming(
      { text: "dodaj | pierś z kurczaka | 165 | 31 | 0 | 3.6", reply },
      makeDeps(db),
    );
    replies.length = 0;
    await handleIncoming(
      { text: "dodaj | pierś z kurczaka smażona | 220 | 28 | 5 | 11", reply },
      makeDeps(db),
    );
    expect(replies[0]).toContain("Dodałem");
    expect(findPresetByName(db, "pierś z kurczaka smażona")?.kcal).toBe(220);
    expect(findPresetByName(db, "pierś z kurczaka")?.kcal).toBe(165);
  });

  it("`lista` replies with every stored preset", async () => {
    addPreset(db, { name: "jajko", kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
    addPreset(db, {
      name: "pierś z kurczaka",
      kcal: 165,
      protein_g: 31,
      carbs_g: 0,
      fat_g: 3.6,
      aliases: ["kurczak"],
    });
    await handleIncoming({ text: "lista", reply }, makeDeps(db));
    expect(replies[0]).toContain("jajko");
    expect(replies[0]).toContain("pierś z kurczaka");
    expect(replies[0]).toContain("kurczak");
  });

  it("`lista` replies with a clear message when nothing is saved yet", async () => {
    await handleIncoming({ text: "lista", reply }, makeDeps(db));
    expect(replies[0]).toContain("Nie masz jeszcze");
  });

  it("`edytuj` overwrites an existing preset's macros and aliases", async () => {
    addPreset(db, { name: "jajko", kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
    await handleIncoming(
      { text: "edytuj | jajko | 160 | 14 | 1 | 11.5 | egg", reply },
      makeDeps(db),
    );
    const updated = findPresetByName(db, "jajko");
    expect(updated?.kcal).toBe(160);
    expect(updated?.aliases).toEqual(["egg"]);
    expect(replies[0]).toContain("Zaktualizowałem");
    expect(replies[0]).toContain("jajko");
  });

  it("`edytuj` on an unknown name replies with an error and changes nothing", async () => {
    await handleIncoming(
      { text: "edytuj | nieznane | 100 | 1 | 1 | 1", reply },
      makeDeps(db),
    );
    expect(findPresetByName(db, "nieznane")).toBeUndefined();
    expect(replies[0]).not.toContain("Zaktualizowałem");
    expect(replies[0]).toContain("nieznane");
  });

  it("`usuń` removes an existing preset", async () => {
    addPreset(db, { name: "jajko", kcal: 155, protein_g: 13, carbs_g: 1.1, fat_g: 11 });
    await handleIncoming({ text: "usuń | jajko", reply }, makeDeps(db));
    expect(findPresetByName(db, "jajko")).toBeUndefined();
    expect(replies[0]).toContain("Usunąłem");
    expect(replies[0]).toContain("jajko");
  });

  it("`usuń` on an unknown name replies with an error and changes nothing", async () => {
    await handleIncoming({ text: "usuń | nieznane", reply }, makeDeps(db));
    expect(replies[0]).not.toContain("Usunąłem");
    expect(replies[0]).toContain("nieznane");
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
