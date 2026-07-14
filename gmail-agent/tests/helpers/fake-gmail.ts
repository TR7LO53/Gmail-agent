import { vi } from "vitest";
import type { GmailClient } from "../../src/gmail/client";

/** base64url-encode a string the way Gmail returns body/attachment data. */
export function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

type AnyFn = (...args: any[]) => any;

export interface FakeHandlers {
  messagesList?: AnyFn;
  messagesGet?: AnyFn;
  threadsGet?: AnyFn;
  labelsList?: AnyFn;
}

/**
 * Build a minimal fake that looks like the bits of gmail_v1.Gmail our tools use.
 * Each handler receives the params object and should return `{ data: ... }`.
 */
export function makeFakeGmail(handlers: FakeHandlers): GmailClient {
  const fake = {
    users: {
      messages: {
        list: vi.fn(handlers.messagesList ?? (async () => ({ data: {} }))),
        get: vi.fn(handlers.messagesGet ?? (async () => ({ data: {} }))),
      },
      threads: {
        get: vi.fn(handlers.threadsGet ?? (async () => ({ data: {} }))),
      },
      labels: {
        list: vi.fn(handlers.labelsList ?? (async () => ({ data: {} }))),
      },
    },
  };
  return fake as unknown as GmailClient;
}
