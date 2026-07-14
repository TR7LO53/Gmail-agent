import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import type { FoodQuery } from "../nutrition/provider.js";

/**
 * Turn a free-text meal (any language, e.g. Polish) into structured items for the USDA search:
 * a simple English food name + a portion in grams. This also absorbs the old translate step —
 * Polish in, English food names out. USDA gives per-100 g nutrients, so we need grams per item;
 * explicit weights are used as-is, vague amounts get a typical-serving estimate.
 */
const ParsedFoodSchema = z.object({
  items: z.array(
    z.object({
      original: z.string(),
      name: z.string(),
      grams: z.number(),
    }),
  ),
});

const SYSTEM = `You convert a meal description (in any language, often Polish) into structured food items for the USDA FoodData Central database.
For each distinct food, output:
- original: the food exactly as the user named it, in THEIR language (e.g. "pierś z kurczaka", "ryż"). This is echoed back so the user can confirm you understood.
- name: a simple, SINGULAR, ENGLISH food name good for a food-database search. Prefer the common READY-TO-EAT / COOKED form unless the text clearly says raw, because people log what they ate. Examples: "pierś z kurczaka" -> "chicken breast, cooked", "ryż" -> "white rice, cooked", "jajko" -> "egg, cooked", "tost" -> "bread, toasted".
- grams: the total weight of that food in grams. If the text states a weight or count, convert it (e.g. "2 eggs" -> 100, "200g rice" -> 200); otherwise estimate a typical serving.
Return one entry per food. Ignore non-food text.`;

export async function parseFoodItems(text: string, deps: { llm: LLMProvider }): Promise<FoodQuery[]> {
  const parsed = await deps.llm.extract(ParsedFoodSchema, SYSTEM, text);
  return parsed.items
    .filter((i) => i.name.trim() && i.grams > 0)
    .map((i) => ({
      original: (i.original ?? "").trim() || i.name.trim(),
      name: i.name.trim(),
      grams: Math.round(i.grams),
    }));
}
