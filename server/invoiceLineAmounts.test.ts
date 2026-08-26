import { describe, expect, it } from "vitest";
import { getGstExclusiveUnitAmount } from "./invoiceLineAmounts";

describe("GST-exclusive Xero PO unit amount", () => {
  it("preserves HC1807's $3,000 GST-exclusive line amount rather than using its $3,300 GST-inclusive total", () => {
    expect(getGstExclusiveUnitAmount("3000.00", "1.000")).toBe(3000);
  });

  it("derives a GST-exclusive per-unit amount from an exclusive line total and quantity", () => {
    expect(getGstExclusiveUnitAmount("3000.00", "2")).toBe(1500);
  });

  it("uses safe defaults for missing or invalid input", () => {
    expect(getGstExclusiveUnitAmount(undefined, undefined)).toBe(0);
    expect(getGstExclusiveUnitAmount("100", "0")).toBe(100);
  });
});
