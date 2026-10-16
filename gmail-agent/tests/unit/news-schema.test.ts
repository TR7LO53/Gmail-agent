import { describe, expect, it } from "vitest";
import { NewsResultSchema } from "../../src/agents/news.js";

describe("NewsResultSchema", () => {
  const good = { is_issue: true, bullets: ["One", "Two", "Three"], score: 7, reason: "Useful news." };
  it("accepts the structured news response", () => {
    expect(NewsResultSchema.parse(good)).toEqual(good);
  });

  it.each([
    { ...good, bullets: ["One", "Two"] },
    { ...good, bullets: [...good.bullets, "Four", "Five", "Six"] },
    { ...good, bullets: ["One", "", "Three"] },
    { ...good, score: 0 },
    { ...good, score: 11 },
    { ...good, score: 2.5 },
    { ...good, reason: " " },
  ])("rejects invalid fields: %o", (value) => {
    expect(NewsResultSchema.safeParse(value).success).toBe(false);
  });
});
