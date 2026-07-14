import { describe, it, expect, vi } from "vitest";
import { gmailRead } from "../../src/tools/gmail-read";
import { makeFakeGmail, b64url } from "../helpers/fake-gmail";

function threadFixture() {
  return {
    data: {
      id: "t1",
      messages: [
        {
          id: "m1",
          threadId: "t1",
          snippet: "Order confirmed",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "shop@example.com" },
              { name: "Subject", value: "Order #123" },
              { name: "Date", value: "Sun, 28 Jun 2026 09:00:00 +0000" },
            ],
            body: { data: b64url("Your order #123 was confirmed.") },
          },
        },
        {
          id: "m2",
          threadId: "t1",
          snippet: "Shipped via DHL 00340123",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: "noreply@dhl.com" },
              { name: "Subject", value: "Shipped" },
              { name: "Date", value: "Mon, 29 Jun 2026 10:00:00 +0000" },
            ],
            parts: [
              { mimeType: "text/plain", body: { data: b64url("Tracking 00340123") } },
              { mimeType: "application/pdf", filename: "label.pdf", body: { attachmentId: "a1", size: 99 } },
            ],
          },
        },
      ],
    },
  };
}

describe("gmailRead (integration, fake Gmail)", () => {
  it("resolves a MESSAGE id to its thread and returns the whole conversation", async () => {
    const messagesGet = vi.fn(async () => ({ data: { threadId: "t1" } })); // minimal resolve
    const threadsGet = vi.fn(async () => threadFixture());
    const gmail = makeFakeGmail({ messagesGet, threadsGet });

    const res = await gmailRead({ id: "m1", detail: "full" }, { gmail });

    expect(res.success).toBe(true);
    expect(res.data!.threadId).toBe("t1");
    expect(res.data!.messageCount).toBe(2);
    expect(res.data!.messages[0].body).toMatch(/order #123 was confirmed/i);
    // attachments come back as references, no base64
    const att = res.data!.messages[1].attachments[0];
    expect(att.ref).toBe("gmail://message/m2/attachment/a1");
    // attachments must never carry raw base64 bytes
    expect(att).not.toHaveProperty("data");
    const attachmentsJson = JSON.stringify(res.data!.messages.map((m) => m.attachments));
    expect(attachmentsJson).not.toMatch(/"data"|base64/i);
    // it resolved via messages.get then loaded the thread
    expect(messagesGet).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", format: "minimal" }));
    expect(threadsGet).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });

  it("loads directly when given a THREAD id (message lookup fails)", async () => {
    const messagesGet = vi.fn(async () => {
      throw Object.assign(new Error("Not Found"), { code: 404 });
    });
    const threadsGet = vi.fn(async () => threadFixture());
    const gmail = makeFakeGmail({ messagesGet, threadsGet });

    const res = await gmailRead({ id: "t1" }, { gmail });

    expect(res.success).toBe(true);
    expect(threadsGet).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });

  it("summary detail omits bodies but keeps attachments and hints", async () => {
    const gmail = makeFakeGmail({
      messagesGet: async () => ({ data: { threadId: "t1" } }),
      threadsGet: async () => threadFixture(),
    });
    const res = await gmailRead({ id: "m1", detail: "summary" }, { gmail });

    expect(res.data!.messages[0].body).toBeUndefined();
    expect(res.next_action).toMatch(/detail="full"/);
  });

  it("returns failure when the thread has no messages", async () => {
    const gmail = makeFakeGmail({
      messagesGet: async () => ({ data: { threadId: "t1" } }),
      threadsGet: async () => ({ data: { id: "t1", messages: [] } }),
    });
    const res = await gmailRead({ id: "t1" }, { gmail });

    expect(res.success).toBe(false);
    expect(res.recovery).toMatch(/no thread or message found/i);
  });
});
