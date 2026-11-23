import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openaiModel, openaiProvider } from "../../src/llm/provider.js";

const { parse, clientOptions } = vi.hoisted(() => ({
  parse: vi.fn(),
  clientOptions: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    beta = { chat: { completions: { parse } } };
    constructor(options: unknown) {
      clientOptions(options);
    }
  },
}));

afterEach(() => vi.unstubAllEnvs());

describe("OpenAI model selection", () => {
  it.each([
    [undefined, "gpt-6-luna"],
    ["", "gpt-6-luna"],
    ["   ", "gpt-6-luna"],
    [" configured-model ", "configured-model"],
  ])("uses OPENAI_MODEL=%s", (value, expected) => {
    vi.stubEnv("OPENAI_MODEL", value);
    expect(openaiModel()).toBe(expected);
  });

  it("passes the model and per-call retry override to the SDK", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-key");
    vi.stubEnv("OPENAI_MODEL", "configured-model");
    parse.mockResolvedValue({ choices: [{ message: { parsed: { summary: "Done" } } }] });
    const schema = z.object({ summary: z.string() });

    await openaiProvider.extract(schema, "system", "user");
    expect(clientOptions).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 3 }));
    expect(parse.mock.lastCall?.[0]).toMatchObject({ model: "configured-model" });
    expect(parse.mock.lastCall?.[1]?.maxRetries).toBeUndefined();

    await openaiProvider.extract(schema, "system", "user", { model: "explicit-model", maxRetries: 0 });
    expect(parse).toHaveBeenLastCalledWith(expect.objectContaining({ model: "explicit-model" }), { maxRetries: 0 });
  });
});
