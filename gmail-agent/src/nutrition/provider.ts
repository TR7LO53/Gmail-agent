/**
 * Nutrition data seam — talks to an external nutrition database. Swap this file to change providers.
 * Default: USDA FoodData Central (free, data.gov key). USDA has no natural-language endpoint, so the
 * meal is parsed into `{ name, grams }` items upstream (see src/agents/parse-food.ts); this provider
 * searches each food and scales its per-100 g nutrients by the item's grams.
 */

export interface FoodQuery {
  /** The food as the user named it, in their language (e.g. "pierś z kurczaka"). For confirmation. */
  original: string;
  /** A simple English food name to search for, e.g. "egg", "white bread". */
  name: string;
  /** Portion size in grams (explicit if the user gave a weight, otherwise an estimate). */
  grams: number;
}

export interface NutritionItem {
  /** The user's original (e.g. Polish) name for this food, echoed back for confirmation. */
  original?: string;
  /** The matched database food name (or the search term if nothing matched). */
  name: string;
  qty?: number;
  unit?: string;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  /** false when no database match was found (macros are 0). */
  matched?: boolean;
}

export interface NutritionTotals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface NutritionResult {
  items: NutritionItem[];
  totals: NutritionTotals;
}

export interface NutritionProvider {
  lookupItems(items: FoodQuery[]): Promise<NutritionResult>;
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

export function sumTotals(items: NutritionItem[]): NutritionTotals {
  return items.reduce<NutritionTotals>(
    (acc, it) => ({
      kcal: acc.kcal + it.kcal,
      protein_g: round1(acc.protein_g + it.protein_g),
      carbs_g: round1(acc.carbs_g + it.carbs_g),
      fat_g: round1(acc.fat_g + it.fat_g),
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );
}

// --- USDA FoodData Central --------------------------------------------------

interface UsdaNutrient {
  nutrientNumber?: string;
  nutrientName?: string;
  unitName?: string;
  value?: number;
}
interface UsdaFood {
  description?: string;
  dataType?: string;
  foodNutrients?: UsdaNutrient[];
}

/** USDA nutrient numbers (values are per 100 g for the generic data types we query). */
const N = { ENERGY_KCAL: "208", PROTEIN: "203", FAT: "204", CARBS: "205" };

function per100(food: UsdaFood, number: string): number {
  const hit = food.foodNutrients?.find((n) => n.nutrientNumber === number);
  return Number(hit?.value) || 0;
}

function energyPer100(food: UsdaFood): number {
  // kcal directly, or Atwater kcal (Foundation foods use 957/958).
  const kcal = per100(food, "208") || per100(food, "958") || per100(food, "957");
  if (kcal) return kcal;
  const namedKcal = food.foodNutrients?.find(
    (n) => (n.nutrientName ?? "").toLowerCase().includes("energy") && n.unitName === "KCAL",
  );
  if (namedKcal) return Number(namedKcal.value) || 0;
  // Only kilojoules present → convert to kcal.
  const kj =
    per100(food, "268") ||
    Number(
      food.foodNutrients?.find(
        (n) => (n.nutrientName ?? "").toLowerCase().includes("energy") && n.unitName === "kJ",
      )?.value,
    ) ||
    0;
  return kj ? Math.round(kj / 4.184) : 0;
}

// Processed / atypical forms that are usually NOT what someone means by a plain food name.
const DOWNRANK = [
  "breaded", "battered", "fried", "nugget", "tender", "powder", "dehydrated", "dried",
  "canned", "infant", "baby food", "sauce", "gravy", "snack", "paste", "concentrate",
  "fast food", "restaurant", "with ",
];
const DATATYPE_SCORE: Record<string, number> = { "SR Legacy": 3, "Survey (FNDDS)": 2, Foundation: 1 };

/** Higher = better match. Prefers generic data types and plain descriptions over processed forms. */
function matchScore(food: UsdaFood): number {
  const desc = (food.description ?? "").toLowerCase();
  let s = DATATYPE_SCORE[food.dataType ?? ""] ?? 0;
  for (const w of DOWNRANK) if (desc.includes(w)) s -= 4;
  s -= Math.min(desc.split(",").length - 1, 6) * 0.2; // prefer plainer (fewer-qualifier) names
  return s;
}

/**
 * Pick the most usable + most representative match instead of blindly taking result #0. USDA's top
 * relevance hit is often a sparse sample with no energy (that's how "chicken breast" came back as
 * 0 kcal) or an atypical processed form (breaded tenders). So: require energy + protein, then rank
 * by matchScore. Falls back to any-energy result, then #0.
 */
export function pickBest(foods: UsdaFood[]): UsdaFood | undefined {
  if (foods.length === 0) return undefined;
  const eligible = foods.filter((f) => energyPer100(f) > 0 && per100(f, N.PROTEIN) > 0);
  const pool = eligible.length ? eligible : foods.filter((f) => energyPer100(f) > 0);
  if (pool.length === 0) return foods[0];
  return pool.reduce((best, f) => (matchScore(f) > matchScore(best) ? f : best), pool[0]);
}

/** Pure per-100 g → grams scaling, or an unmatched (zeroed) item when `food` is undefined. */
export function mapUsdaFood(food: UsdaFood | undefined, query: FoodQuery): NutritionItem {
  if (!food) {
    return {
      original: query.original,
      name: query.name,
      qty: query.grams,
      unit: "g",
      kcal: 0,
      protein_g: 0,
      carbs_g: 0,
      fat_g: 0,
      matched: false,
    };
  }
  const factor = query.grams / 100;
  return {
    original: query.original,
    name: food.description ? food.description.toLowerCase() : query.name,
    qty: query.grams,
    unit: "g",
    kcal: Math.round(energyPer100(food) * factor),
    protein_g: round1(per100(food, N.PROTEIN) * factor),
    carbs_g: round1(per100(food, N.CARBS) * factor),
    fat_g: round1(per100(food, N.FAT) * factor),
    matched: true,
  };
}

async function searchFoods(name: string, apiKey: string): Promise<UsdaFood[]> {
  // POST endpoint: dataType is a JSON array, which avoids URL-encoding issues with spaces/parens.
  // Fetch several candidates so pickBest can skip sparse/energy-less hits.
  const res = await fetch(
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: name,
        pageSize: 10,
        dataType: ["Foundation", "SR Legacy", "Survey (FNDDS)"],
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`USDA ${res.status}: ${body.slice(0, 160)}`);
  }
  const data = (await res.json()) as { foods?: UsdaFood[] };
  return data.foods ?? [];
}

export const usdaProvider: NutritionProvider = {
  async lookupItems(items: FoodQuery[]): Promise<NutritionResult> {
    const apiKey = (process.env.USDA_API_KEY ?? "").trim().replace(/^["']|["']$/g, "").trim();
    if (!apiKey) {
      throw new Error(
        "USDA_API_KEY is not set. Add a line `USDA_API_KEY=<key>` to gmail-agent/.env (free key at fdc.nal.usda.gov/api-key-signup.html), then restart Ggent.",
      );
    }

    const mapped: NutritionItem[] = [];
    for (const item of items) {
      // Always emit one item per input (matched or not) so the caller can confirm every food.
      mapped.push(mapUsdaFood(pickBest(await searchFoods(item.name, apiKey)), item));
    }
    return { items: mapped, totals: sumTotals(mapped) };
  },
};
