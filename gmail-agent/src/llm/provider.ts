import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

interface ExtractOptions {
  model?: string;
  maxRetries?: number;
}

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
    opts?: ExtractOptions,
  ): Promise<T>;
}

let _client: OpenAI | undefined;

export function openaiModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-6-luna";
}

class MissingOpenAIKeyError extends Error {}

const unavailableModelCodes = new Set(["model_not_found", "model_deprecated"]);
const providerFailureCodes = new Set(["invalid_api_key", "insufficient_quota", "rate_limit_exceeded"]);
const providerFailureStatuses = new Set([401, 403, 404, 408, 429]);

function isUnavailableModel(error: InstanceType<typeof OpenAI.APIError>): boolean {
  return unavailableModelCodes.has(error.code ?? "") ||
    (/\bmodel\b/i.test(error.message) && /not found|does not exist|deprecated/i.test(error.message));
}

export function isOpenAIProviderFailure(error: unknown): boolean {
  return error instanceof MissingOpenAIKeyError || error instanceof OpenAI.APIConnectionError ||
    (error instanceof OpenAI.APIError && (
      providerFailureStatuses.has(error.status ?? 0) ||
      isUnavailableModel(error) ||
      providerFailureCodes.has(error.code ?? "")
    ));
}

export function formatOpenAIError(error: unknown, model: string, modelEnv: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof OpenAI.APIError)) return message;

  const details = [error.status, error.code].filter(Boolean).join(" ");
  const description = details ? `OpenAI (${details}): ${message}` : message;
  return isUnavailableModel(error)
    ? `${description} Model ${model} is unavailable. Change ${modelEnv} in .env.`
    : description;
}

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey?.trim()) throw new MissingOpenAIKeyError("OPENAI_API_KEY is not set. Add it to your .env file.");
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
    opts?: ExtractOptions,
  ): Promise<T> {
    const model = opts?.model ?? openaiModel();
    const client = getClient();

    const response = await client.beta.chat.completions.parse({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: zodResponseFormat(schema, "result"),
    }, opts?.maxRetries === undefined ? undefined : { maxRetries: opts.maxRetries });

    const parsed = response.choices[0]?.message?.parsed;
    if (parsed === null || parsed === undefined) {
      throw new Error("OpenAI returned an empty or refused response.");
    }
    return parsed as T;
  },
};
