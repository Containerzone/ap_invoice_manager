import { describe, expect, it } from "vitest";
import {
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease,
  getD702959AuthorisedDepositMainDeductionRecoveryPolicy,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryRelease";
import { previewD702959AuthorisedDepositMainDeductionRecovery } from "./financialD702959AuthorisedDepositMainDeductionRecoveryService";

const live = process.env.RUN_LIVE_FINANCIAL_TESTS === "true";
const test = live ? it : it.skip;

describe("D702959 Authorised Deposit deduction recovery gate (live, GET-only)", () => {
  test("requires the configured gate and permits only the exact no-write preview", async () => {
    expect(process.env.FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED).toBe("true");

    const policy = await getD702959AuthorisedDepositMainDeductionRecoveryPolicy();
    assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy);

    const preview = await previewD702959AuthorisedDepositMainDeductionRecovery({
      dealId: "5x492104",
      originalMainEventId: 1290001,
    });

    expect(preview).toMatchObject({
      status: "ready",
      noWrites: true,
    });
    if (preview.status !== "ready") throw new Error("Expected the exact D702959 recovery preview to be ready.");
    expect(preview.payload).toMatchObject({
      method: "POST",
      endpoint: "/Invoices/2f392a0b-e8fb-43f4-a91a-27801b0350fe",
      documentNumber: "INV-702959",
      expectedXeroDocumentId: "2f392a0b-e8fb-43f4-a91a-27801b0350fe",
    });
  }, 120_000);
});
