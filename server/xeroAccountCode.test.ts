import { describe, expect, it } from "vitest";
import { formatXeroUtcDate, resolveXeroBillAccountCode } from "./xeroService";

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

describe("formatXeroUtcDate", () => {
  it("formats Xero's legacy UTC date representation without throwing", () => {
    expect(formatXeroUtcDate("/Date(1769779200000+0000)/")).toBe("2026-01-30");
  });

  it("accepts an ISO timestamp and ignores invalid date values safely", () => {
    expect(formatXeroUtcDate("2026-08-31T00:00:00.000Z")).toBe("2026-08-31");
    expect(formatXeroUtcDate("not-a-date")).toBeUndefined();
    expect(formatXeroUtcDate(null)).toBeUndefined();
  });
});
