import { describe, expect, it } from "vitest";

/**
 * Opt-in deployment assertion for the isolated D702946 local-validation
 * recovery gate. It does not read source systems, reserve a receipt or write.
 */
describe.runIf(
  process.env.RUN_LIVE_MAIN_CUSTOMER_INVOICE_RECONCILIATION_GATE_TEST === "true"
)("Main Invoice reconciliation deployment gate", () => {
  it("matches the explicitly requested disabled-by-default deployment state", () => {
    expect(
      process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED
    ).toBe(
      process.env.EXPECTED_MAIN_CUSTOMER_INVOICE_RECONCILIATION_GATE ?? "false"
    );
  });
});
