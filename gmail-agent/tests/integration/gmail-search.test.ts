import { describe, it, expect } from "vitest";
import { gmailSearch } from "../../src/tools/gmail-search";
import { makeFakeGmail, b64url } from "../helpers/fake-gmail";

function messageFixture() {
  return {
    data: {
      id: "m1",
      threadId: "t1",
      snippet: "Your DHL shipment is on its way",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "DHL <noreply@dhl.com>" },
          { name: "To", value: "me@example.com" },
          { name: "Subject", value: "Shipment update" },
          { name: "Date", value: "Mon, 29 Jun 2026 10:00:00 +0000" },
        ],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("body") } },
          { mimeType: "application/pdf", filename: "label.pdf", body: { attachmentId: "a1", size: 10 } },
        ],
      },
    },
  };
}

describe("gmailSearch (integration, fake Gmail)", () => {
  it("returns tidy rows with hints and diagnostics on the happy path", async () => {
    const gmail = makeFakeGmail({
      messagesList: async () => ({
        data: { messages: [{ id: "m1" }], nextPageToken: "NEXT", resultSizeEstimate: 1 },
      }),
      messagesGet: async () => messageFixture(),
    });

    const res = await gmailSearch({ from: "dhl.com", isUnread: true }, { gmail });

    expect(res.success).toBe(true);
    const row = res.data!.messages[0];
    expect(row.id).toBe("m1");
    expect(row.threadId).toBe("t1");
    expect(row.from).toContain("dhl.com");
    expect(row.subject).toBe("Shipment update");
    expect(row.hasAttachment).toBe(true);
    expect(row.isUnread).toBe(true);
    expect(res.data!.nextPageToken).toBe("NEXT");
    expect(res.next_action).toMatch(/gmail_read/);
    expect(res.next_action).toMatch(/pageToken/);
    expect(res.diagnostics).toMatchObject({ query: "from:dhl.com is:unread", returned: 1, hasMore: true });
  });

  it("returns a recovery hint when nothing matches", async () => {
    const gmail = makeFakeGmail({ messagesList: async () => ({ data: {} }) });
    const res = await gmailSearch({ from: "nobody@nowhere.test" }, { gmail });

    expect(res.success).toBe(true);
    expect(res.data!.messages).toHaveLength(0);
    expect(res.recovery).toMatch(/no messages matched/i);
    expect(res.diagnostics).toMatchObject({ returned: 0 });
  });

  it("maps a thrown auth error (403) to a friendly recovery", async () => {
    const gmail = makeFakeGmail({
      messagesList: async () => {
        throw Object.assign(new Error("Forbidden"), { code: 403 });
      },
    });
    const res = await gmailSearch({ query: "anything" }, { gmail });

    expect(res.success).toBe(false);
    expect(res.recovery).toMatch(/npm run auth/);
    expect(res.diagnostics).toMatchObject({ kind: "auth", code: 403 });
  });
});
