import OpenAI, { toFile } from "openai";

/**
 * Speech-to-text seam. Kept separate from the structured-extraction provider so it can be injected
 * and faked in tests. Default: OpenAI Whisper, hinted to Polish.
 */
export interface AudioInput {
  data: Buffer;
  filename: string;
}

export type Transcriber = (audio: AudioInput) => Promise<string>;

let _client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Add it to your .env file.");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export const openaiTranscriber: Transcriber = async ({ data, filename }) => {
  const client = getClient();
  const file = await toFile(data, filename);
  const res = await client.audio.transcriptions.create({
    file,
    model: process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1",
    language: "pl",
  });
  return (res.text ?? "").trim();
};
