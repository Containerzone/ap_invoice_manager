import { describe, expect, it } from "vitest";

describe.runIf(process.env.RUN_LIVE_CUSTOMER_CONTACT_V2_GATE_TEST === "true")("Customer contact v2 deployment gates", () => {
  it("matches the explicitly expected dual-gate state", () => {
    const expected = process.env.EXPECTED_CUSTOMER_CONTACT_V2_GATE ?? "false";
    expect(process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED).toBe(expected);
    expect(process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED).toBe(expected);
  });
});
