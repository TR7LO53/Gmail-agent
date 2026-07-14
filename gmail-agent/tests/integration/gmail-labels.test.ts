import { describe, it, expect } from "vitest";
import { gmailListLabels } from "../../src/tools/gmail-labels";
import { makeFakeGmail } from "../helpers/fake-gmail";

const labels = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "Label_1", name: "Shipping", type: "user" },
];

describe("gmailListLabels (integration, fake Gmail)", () => {
  it("maps labels and adds a next_action hint", async () => {
    const gmail = makeFakeGmail({ labelsList: async () => ({ data: { labels } }) });
    const res = await gmailListLabels({}, { gmail });

    expect(res.success).toBe(true);
    expect(res.data!.labels).toEqual([
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_1", name: "Shipping", type: "user" },
    ]);
    expect(res.next_action).toMatch(/gmail_search/);
    expect(res.diagnostics).toMatchObject({ count: 2 });
  });

  it("hides system labels when includeSystem=false", async () => {
    const gmail = makeFakeGmail({ labelsList: async () => ({ data: { labels } }) });
    const res = await gmailListLabels({ includeSystem: false }, { gmail });

    expect(res.data!.labels).toEqual([{ id: "Label_1", name: "Shipping", type: "user" }]);
  });

  it("maps an error to a recovery hint", async () => {
    const gmail = makeFakeGmail({
      labelsList: async () => {
        throw Object.assign(new Error("rate"), { code: 429 });
      },
    });
    const res = await gmailListLabels({}, { gmail });

    expect(res.success).toBe(false);
    expect(res.recovery).toMatch(/rate limit/i);
  });
});
