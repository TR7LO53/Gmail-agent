import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getGmailClient } from "../../src/gmail/client";
import { gmailListLabels } from "../../src/tools/gmail-labels";
import { gmailSearch } from "../../src/tools/gmail-search";
import { gmailRead } from "../../src/tools/gmail-read";

/**
 * Real-mailbox checks. These run ONLY if data/token.json exists (i.e. after `npm run auth`),
 * otherwise the whole suite is skipped so normal CI/test runs stay green.
 *
 * Optionally set E2E_TEST_SENDER to a real sender you receive mail from to exercise search/read.
 */
const tokenExists = fs.existsSync(path.join(process.cwd(), "data", "token.json"));
const describeIf = tokenExists ? describe : describe.skip;

describeIf("gmail e2e (real account)", () => {
  beforeAll(async () => {
    await getGmailClient(); // fails fast if auth is broken
  });

  it("lists real labels", async () => {
    const res = await gmailListLabels({});
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data!.labels)).toBe(true);
    expect(res.data!.labels.length).toBeGreaterThan(0);
  });

  it("searches and reads a real thread (no base64 in output)", async () => {
    const sender = process.env.E2E_TEST_SENDER;
    const res = await gmailSearch(sender ? { from: sender, maxResults: 3 } : { maxResults: 3 });
    expect(res.success).toBe(true);

    const first = res.data!.messages[0];
    if (!first) return; // empty mailbox / no match — nothing more to assert

    const read = await gmailRead({ id: first.id, detail: "full" });
    expect(read.success).toBe(true);
    expect(read.data!.messageCount).toBeGreaterThanOrEqual(1);

    // Attachments must be references, never raw base64 bytes.
    for (const m of read.data!.messages) {
      for (const att of m.attachments) {
        expect(att.ref).toMatch(/^gmail:\/\/message\//);
        expect(att).not.toHaveProperty("data");
      }
    }
  });
});
