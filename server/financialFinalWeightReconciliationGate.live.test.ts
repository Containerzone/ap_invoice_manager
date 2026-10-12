import { describe, expect, it } from "vitest";

/**
 * Opt-in deployment assertion for the separate legacy-404 recovery gate. It
 * never calls Xero, VTiger, a webhook or a Draft writer.
 */
describe.runIf(process.env.RUN_LIVE_FINAL_WEIGHT_RECONCILIATION_GATE_TEST === "true")("Final Weight reconciliation deployment gate", () => {
  it("matches the explicitly requested deployment state", () => {
    expect(process.env.FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED).toBe(process.env.EXPECTED_FINAL_WEIGHT_RECONCILIATION_GATE ?? "false");
  });
});
