import { describe, it, expect } from "vitest";
import { ok, fail } from "../../src/tools/types";

describe("response envelope helpers", () => {
  it("ok() marks success and carries data", () => {
    expect(ok({ n: 1 })).toEqual({ success: true, data: { n: 1 } });
  });

  it("ok() merges extra fields", () => {
    const res = ok([1], { next_action: "do x", diagnostics: { returned: 1 } });
    expect(res.success).toBe(true);
    expect(res.next_action).toBe("do x");
    expect(res.diagnostics).toEqual({ returned: 1 });
  });

  it("fail() marks failure with a recovery hint", () => {
    expect(fail("try again")).toEqual({ success: false, recovery: "try again" });
  });

  it("fail() attaches diagnostics only when provided", () => {
    expect(fail("nope", { kind: "auth" })).toEqual({
      success: false,
      recovery: "nope",
      diagnostics: { kind: "auth" },
    });
  });
});
