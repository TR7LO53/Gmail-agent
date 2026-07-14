import { describe, it, expect } from "vitest";
import {
  getHeader,
  decodeBase64Url,
  decodeBody,
  extractAttachments,
  hasAttachment,
} from "../../src/gmail/parse";
import { b64url } from "../helpers/fake-gmail";

describe("getHeader", () => {
  const headers = [
    { name: "From", value: "DHL <noreply@dhl.com>" },
    { name: "Subject", value: "Your shipment" },
  ];
  it("is case-insensitive", () => {
    expect(getHeader(headers, "from")).toBe("DHL <noreply@dhl.com>");
    expect(getHeader(headers, "SUBJECT")).toBe("Your shipment");
  });
  it("returns undefined for missing header or undefined headers", () => {
    expect(getHeader(headers, "To")).toBeUndefined();
    expect(getHeader(undefined, "From")).toBeUndefined();
  });
});

describe("decodeBase64Url / decodeBody", () => {
  it("decodes base64url body data", () => {
    expect(decodeBase64Url(b64url("Hello world"))).toBe("Hello world");
  });

  it("prefers the text/plain part", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("PLAIN BODY") } },
        { mimeType: "text/html", body: { data: b64url("<p>HTML BODY</p>") } },
      ],
    };
    expect(decodeBody(payload as any)).toBe("PLAIN BODY");
  });

  it("falls back to stripped text/html when no plain part exists", () => {
    const payload = {
      mimeType: "text/html",
      body: { data: b64url("<p>Hi <b>there</b></p>") },
    };
    expect(decodeBody(payload as any)).toBe("Hi there");
  });

  it("returns empty string when there is no body", () => {
    expect(decodeBody(undefined)).toBe("");
    expect(decodeBody({ mimeType: "multipart/mixed" } as any)).toBe("");
  });
});

describe("attachments", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("body") } },
      {
        mimeType: "application/pdf",
        filename: "label.pdf",
        body: { attachmentId: "att-123", size: 2048 },
      },
    ],
  };

  it("detects attachments", () => {
    expect(hasAttachment(payload as any)).toBe(true);
    expect(hasAttachment({ mimeType: "text/plain", body: { data: "x" } } as any)).toBe(false);
  });

  it("extracts attachments as references, never base64", () => {
    const atts = extractAttachments(payload as any, "msg-1");
    expect(atts).toHaveLength(1);
    expect(atts[0]).toEqual({
      filename: "label.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      attachmentId: "att-123",
      messageId: "msg-1",
      ref: "gmail://message/msg-1/attachment/att-123",
    });
    // Hard guarantee: no field carries raw base64 bytes.
    expect(Object.keys(atts[0])).not.toContain("data");
    expect(JSON.stringify(atts[0])).not.toMatch(/base64/i);
  });
});
