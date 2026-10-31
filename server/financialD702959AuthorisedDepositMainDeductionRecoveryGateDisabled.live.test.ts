import { describe, expect, it } from "vitest";
import {
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease,
  getD702959AuthorisedDepositMainDeductionRecoveryPolicy,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryRelease";
import { getD702959AuthorisedDepositMainDeductionRecoveryEvent } from "./financialD702959AuthorisedDepositMainDeductionRecoveryDb";

const live = process.env.RUN_LIVE_FINANCIAL_TESTS === "true";
const test = live ? it : it.skip;

describe("D702959 Authorised Deposit deduction recovery gate restoration (live, no-write)", () => {
  test("is disabled after the one-time completed Draft amendment and cannot arm the recovery", async () => {
    expect(process.env.FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED).toBe("false");

    const policy = await getD702959AuthorisedDepositMainDeductionRecoveryPolicy();
    expect(() => assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy))
      .toThrow("D702959 Authorised-Deposit deduction recovery is disabled");

    const receipt = await getD702959AuthorisedDepositMainDeductionRecoveryEvent(1);
    expect(receipt).toMatchObject({
      id: 1,
      status: "draft_updated",
      executionId: 2220001,
    });
  }, 30_000);
});
