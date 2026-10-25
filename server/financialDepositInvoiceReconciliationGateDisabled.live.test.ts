import { describe, expect, it } from "vitest";

const live = process.env.RUN_LIVE_FINANCIAL_TESTS === "true";
const test = live ? it : it.skip;

describe("Deposit Invoice reconciliation recovery gate disabled state (live)", () => {
  test("is restored to the literal default-off value after a one-time recovery", () => {
    expect(process.env.FINANCIAL_DEPOSIT_INVOICE_RECONCILIATION_ENABLED).toBe("false");
  });
});
