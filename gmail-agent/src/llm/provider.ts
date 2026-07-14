import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

export interface LLMProvider {
  /**
   * Run one structured extraction. `opts.model` overrides the default model for this call —
   * the seam that lets the Stage 3 Tracker use a deeper model than the Classifier without a
   * second provider. Implementers may ignore it (the test fakes do).
   */
  extract<T>(
    schema: z.ZodType<T>,
    system: string,
    user: string,
    opts?: { model?: string },
  ): Promise<T>;
}

let _client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Add it to your .env file.");
    // Retry transient connection blips (the tracker was failing with "Connection error").
    _client = new OpenAI({ apiKey, maxRetries: 3, timeout: 30000 });
  }
  return _client;
}

/** The default (real) LLM provider backed by OpenAI. */
export const openaiProvider: LLMProvider = {
  async extract<T>(
    schema: z.ZodType<T>,
    system: string,
    user: string,
    opts?: { model?: string },
  ): Promise<T> {
    const model = opts?.model ?? process.env.OPENAI_MODEL ?? "gpt-4.1-nano";
    const client = getClient();

    const response = await client.beta.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: zodResponseFormat(schema, "result"),
    });

    const parsed = response.choices[0]?.message?.parsed;
    if (parsed === null || parsed === undefined) {
      throw new Error("OpenAI returned an empty or refused response.");
    }
    return parsed as T;
  },
};
