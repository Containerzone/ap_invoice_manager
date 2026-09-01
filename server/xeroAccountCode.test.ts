import { describe, expect, it } from "vitest";
import { resolveXeroBillAccountCode } from "./xeroService";

describe("resolveXeroBillAccountCode", () => {
  it("retains an explicitly configured Xero account code", () => {
    expect(resolveXeroBillAccountCode("429")).toBe("429");
    expect(resolveXeroBillAccountCode(" 310 ")).toBe("310");
  });

  it("uses the standard purchase account for null, blank and whitespace-only source values", () => {
    expect(resolveXeroBillAccountCode(null)).toBe("310");
    expect(resolveXeroBillAccountCode("")).toBe("310");
    expect(resolveXeroBillAccountCode("   ")).toBe("310");
  });
});
