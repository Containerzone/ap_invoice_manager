import { afterEach, describe, expect, it, vi } from "vitest";
import { drafts, scope, source } from "./financialD702959AuthorisedDepositMainDeductionRecovery.testFixtures";
import {
  D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY,
  assertD702959AuthorisedDepositEvidence,
  assertD702959AuthorisedDepositMainDraft,
  assertD702959AuthorisedDepositRecoveryPair,
  assertD702959AuthorisedDepositRecoveryPayload,
  assertD702959AuthorisedDepositRecoveryReadback,
  assertD702959AuthorisedDepositRecoverySource,
  d702959AuthorisedDepositDeduction,
  prepareD702959AuthorisedDepositMainDeductionRecoveryPayload,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryScope";
import {
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease,
  resolveD702959AuthorisedDepositMainDeductionRecoveryPolicy,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryRelease";
import { assertFinancialDraftWriteAuthorised, financialDraftWriteAllowsTransientRetry } from "./financialProductionWriter";

const policy = () => ({ enabled: true, releaseKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, approvedBy: 7,
  approvedAt: "2026-10-29T00:00:00.000Z", scope });
const context = () => ({ workflowType: scope.workflowType, approvalReference: D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY,
  globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true,
  currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, executionId: 2200001,
  d702959AuthorisedDepositMainDeductionRecoveryEventId: 1, d702959AuthorisedDepositMainDeductionRecoveryToken: "token",
  d702959AuthorisedDepositMainDeductionRecoveryReleaseKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY,
  d702959AuthorisedDepositMainDeductionRecoveryApprovedBy: 7 });

afterEach(() => vi.unstubAllEnvs());
describe("closed D702959 Authorised Deposit recovery scope", () => {
  it("is default-off and requires an independently named scope-bound policy", () => {
    expect(() => assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy())).toThrow(/disabled/);
    vi.stubEnv("FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    expect(() => assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy())).not.toThrow();
    expect(resolveD702959AuthorisedDepositMainDeductionRecoveryPolicy(undefined)).toEqual({ enabled: false, releaseKey: "", approvedBy: null, approvedAt: null, scope: null });
    expect(() => assertD702959AuthorisedDepositMainDeductionRecoveryRelease({ ...policy(), releaseKey: "D702946-AUTHORISED-DEPOSIT-MAIN-DEDUCTION-RECOVERY-V2" })).toThrow(/disabled|separate/);
    vi.stubEnv("FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "TRUE");
    expect(() => assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy())).toThrow(/disabled/);
  });

  it("excludes every other Deal/receipt/invoice identity and requires exact source facts", () => {
    const facts = source();
    expect(() => assertD702959AuthorisedDepositRecoverySource(facts.mainFacts, facts.depositFacts)).not.toThrow();
    expect(() => assertD702959AuthorisedDepositRecoverySource({ ...facts.mainFacts, dealId: "5xother" }, facts.depositFacts)).toThrow(/D702959/);
    expect(() => assertD702959AuthorisedDepositRecoverySource(facts.mainFacts, { ...facts.depositFacts, dealNumber: "D702946" })).toThrow(/D702959/);
    expect(() => assertD702959AuthorisedDepositRecoverySource(facts.mainFacts, { ...facts.depositFacts, customerVtigerId: "4xother" })).toThrow(/D702959/);
    expect(() => assertD702959AuthorisedDepositRecoverySource(facts.mainFacts, { ...facts.depositFacts, depositAmountRequiredInclusive: 0 })).toThrow(/Deposit Amount Required/);
  });

  it("accepts only the Main DRAFT as target and the wholly outstanding Authorised Deposit as evidence", () => {
    const { main, deposit } = drafts();
    expect(() => assertD702959AuthorisedDepositRecoveryPair(main, deposit)).not.toThrow();
    expect(() => assertD702959AuthorisedDepositMainDraft({ ...main, Status: "AUTHORISED" })).toThrow(/Main/);
    expect(() => assertD702959AuthorisedDepositMainDraft({ ...main, AmountPaid: 1 })).toThrow(/Main/);
    expect(() => assertD702959AuthorisedDepositMainDraft({ ...main, AmountDue: 1 })).toThrow(/wholly outstanding/);
    expect(() => assertD702959AuthorisedDepositEvidence({ ...deposit, Status: "DRAFT" })).toThrow(/AUTHORISED/);
    expect(() => assertD702959AuthorisedDepositEvidence({ ...deposit, AmountCredited: 1 })).toThrow(/AUTHORISED/);
    expect(() => assertD702959AuthorisedDepositEvidence({ ...deposit, LineItems: [{ ...deposit.LineItems[0], ItemCode: "Other" }] })).toThrow(/Deposit Required/);
  });

  it("preserves every retained writable header, line ID, description, account/tax, tracking and order while appending exactly one dynamic negative line", () => {
    const { main, deposit } = drafts();
    const beforeMain = structuredClone(main), beforeDeposit = structuredClone(deposit);
    const payload = prepareD702959AuthorisedDepositMainDeductionRecoveryPayload(main, deposit, "evidence");
    const row = (payload.body.Invoices as any[])[0];
    expect(payload).toMatchObject({ method: "POST", endpoint: `/Invoices/${scope.mainXeroInvoiceId}`, expectedXeroDocumentId: scope.mainXeroInvoiceId, documentNumber: scope.mainInvoiceNumber });
    expect(row.LineItems.slice(0, -1)).toEqual(beforeMain.LineItems);
    expect(row.LineItems.at(-1)).toEqual(d702959AuthorisedDepositDeduction(deposit));
    expect(row.LineItems.at(-1)).toMatchObject({ Description: "Less deposit invoice INV-702959-D", UnitAmount: -454.55, LineAmount: -454.55, TaxAmount: -45.45, AccountCode: "200", TaxType: "OUTPUT" });
    expect(JSON.stringify(payload.body)).not.toContain(scope.depositXeroInvoiceId);
    expect(main).toEqual(beforeMain); expect(deposit).toEqual(beforeDeposit);
    expect(() => assertD702959AuthorisedDepositRecoveryPayload(payload)).not.toThrow();
  });

  it("holds on per-line total inconsistency or any existing deduction marker rather than guessing", () => {
    const { main, deposit } = drafts();
    expect(() => prepareD702959AuthorisedDepositMainDeductionRecoveryPayload({ ...main, AmountDue: 4203.45, TotalTax: 382.13, Total: 4203.45 }, deposit, "evidence")).toThrow(/totals/);
    expect(() => prepareD702959AuthorisedDepositMainDeductionRecoveryPayload({ ...main, LineItems: [...main.LineItems, { ...main.LineItems[0], LineItemID: "other", Description: "Less deposit invoice INV-702959-D (old)" }] }, deposit, "evidence")).toThrow(/Existing/);
  });

  it("requires exact post-readback preservation and one deduction even if Xero reorders Draft lines", () => {
    const { main, deposit } = drafts();
    const payload = prepareD702959AuthorisedDepositMainDeductionRecoveryPayload(main, deposit, "evidence");
    const row = (payload.body.Invoices as any[])[0];
    const actual = { ...main, ...row, AmountDue: 3703.46, SubTotal: 3366.77, TotalTax: 336.69, Total: 3703.46,
      LineItems: [...main.LineItems, { ...row.LineItems.at(-1), LineItemID: "new-deduction" }] };
    expect(() => assertD702959AuthorisedDepositRecoveryReadback({ ...actual, LineItems: [...actual.LineItems].reverse() }, payload)).not.toThrow();
    expect(() => assertD702959AuthorisedDepositRecoveryReadback({ ...actual, LineItems: [{ ...actual.LineItems[0], Description: "changed" }, ...actual.LineItems.slice(1)] }, payload)).toThrow(/line/);
  });

  it("permits only its distinct mutually exclusive writer context and never retries", () => {
    vi.stubEnv("FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    expect(() => assertFinancialDraftWriteAuthorised(context())).not.toThrow();
    expect(() => assertFinancialDraftWriteAuthorised({ ...context(), d702946AuthorisedDepositMainDeductionRecoveryEventId: 2 })).toThrow(/mutually exclusive/);
    expect(() => assertFinancialDraftWriteAuthorised({ ...context(), workflowType: "deposit_main_deduction" })).toThrow(/D702959/);
    expect(financialDraftWriteAllowsTransientRetry(context())).toBe(false);
  });
});
