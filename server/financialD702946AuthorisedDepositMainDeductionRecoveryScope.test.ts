import { afterEach, describe, expect, it, vi } from "vitest";
import { drafts, source } from "./financialD702946DepositMainDeductionRecovery.testFixtures";
import { assertD702946RecoveryPair } from "./financialD702946DepositMainDeductionRecoveryScope";
import {
  D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope,
  D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY,
  assertD702946AuthorisedDepositEvidence,
  assertD702946AuthorisedDepositMainDraft,
  assertD702946AuthorisedDepositRecoveryPair,
  assertD702946AuthorisedDepositRecoveryPayload,
  assertD702946AuthorisedDepositRecoveryReadback,
  assertD702946AuthorisedDepositRecoverySource,
  prepareD702946AuthorisedDepositMainDeductionRecoveryPayload,
} from "./financialD702946AuthorisedDepositMainDeductionRecoveryScope";
import {
  assertD702946AuthorisedDepositMainDeductionRecoveryRelease,
  resolveD702946AuthorisedDepositMainDeductionRecoveryPolicy,
} from "./financialD702946AuthorisedDepositMainDeductionRecoveryRelease";
import { assertFinancialDraftWriteAuthorised, financialDraftWriteAllowsTransientRetry } from "./financialProductionWriter";

const authorisedPair = () => {
  const pair = drafts();
  pair.deposit.Status = "AUTHORISED";
  pair.deposit.AmountDue = 500;
  return pair;
};
const policy = () => ({ enabled: true, releaseKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, approvedBy: 7,
  approvedAt: "2026-10-19T00:00:00.000Z", scope });
const context = () => ({ workflowType: scope.workflowType, approvalReference: D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY,
  globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true,
  currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, executionId: 1200002,
  d702946AuthorisedDepositMainDeductionRecoveryEventId: 2, d702946AuthorisedDepositMainDeductionRecoveryToken: "token",
  d702946AuthorisedDepositMainDeductionRecoveryReleaseKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY,
  d702946AuthorisedDepositMainDeductionRecoveryApprovedBy: 7 });

afterEach(() => vi.unstubAllEnvs());
describe("closed D702946 Authorised Deposit recovery V2 scope", () => {
  it("does not widen V1: an Authorised Deposit remains rejected by its original Draft/Draft pair", () => {
    const { main, deposit } = authorisedPair();
    expect(() => assertD702946RecoveryPair(main, deposit)).toThrow(/DRAFT/);
  });
  it("requires literal V2 gate plus a separate V2 policy and rejects V1-style approval", () => {
    vi.stubEnv("FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    expect(() => assertD702946AuthorisedDepositMainDeductionRecoveryRelease(policy())).not.toThrow();
    expect(resolveD702946AuthorisedDepositMainDeductionRecoveryPolicy(undefined)).toEqual({ enabled: false, releaseKey: "", approvedBy: null, approvedAt: null, scope: null });
    expect(() => assertD702946AuthorisedDepositMainDeductionRecoveryRelease({ ...policy(), releaseKey: "D702946-DEPOSIT-MAIN-DEDUCTION-RECOVERY-V1" })).toThrow();
    vi.stubEnv("FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "TRUE");
    expect(() => assertD702946AuthorisedDepositMainDeductionRecoveryRelease(policy())).toThrow(/disabled/);
  });
  it("accepts only an exact current Main Draft and exact wholly outstanding Authorised Deposit evidence", () => {
    const { main, deposit } = authorisedPair();
    expect(() => assertD702946AuthorisedDepositRecoveryPair(main, deposit)).not.toThrow();
    expect(() => assertD702946AuthorisedDepositMainDraft({ ...main, Status: "AUTHORISED" })).toThrow(/Main/);
    for (const patch of [{ Status: "DRAFT" }, { AmountDue: 499.99 }, { AmountPaid: 0.01 }, { AmountCredited: 0.01 },
      { CurrencyCode: "USD" }, { Payments: [{}] }, { LineItems: [] }]) {
      expect(() => assertD702946AuthorisedDepositEvidence({ ...deposit, ...patch })).toThrow();
    }
    expect(() => assertD702946AuthorisedDepositRecoveryPair(main, { ...deposit, Contact: { ContactID: "another" } })).toThrow(/ContactID/);
  });
  it("requires current matching source facts and exact $500 Deposit Amount Required", () => {
    const facts = source();
    expect(() => assertD702946AuthorisedDepositRecoverySource(facts.mainFacts, facts.depositFacts)).not.toThrow();
    expect(() => assertD702946AuthorisedDepositRecoverySource(facts.mainFacts, { ...facts.depositFacts, depositAmountRequiredInclusive: 500.01 })).toThrow();
    expect(() => assertD702946AuthorisedDepositRecoverySource({ ...facts.mainFacts, customerName: "changed" }, facts.depositFacts)).not.toThrow();
    expect(() => assertD702946AuthorisedDepositRecoverySource({ ...facts.mainFacts, quoteId: "wrong" }, facts.depositFacts)).toThrow();
  });
  it("serializes only the preserved Main Draft plus exactly one final deduction; Deposit is evidence only", () => {
    const { main, deposit } = authorisedPair(), beforeMain = structuredClone(main), beforeDeposit = structuredClone(deposit);
    const payload = prepareD702946AuthorisedDepositMainDeductionRecoveryPayload(main, deposit, "evidence");
    const row = (payload.body.Invoices as any[])[0];
    expect(payload).toMatchObject({ method: "POST", endpoint: `/Invoices/${scope.mainXeroInvoiceId}`, expectedXeroDocumentId: scope.mainXeroInvoiceId, documentNumber: scope.mainInvoiceNumber });
    expect(payload.body.Invoices).toHaveLength(1);
    expect(row.LineItems.slice(0, -1)).toEqual(beforeMain.LineItems);
    expect(row.LineItems.at(-1)).toEqual(scope.deduction);
    expect(JSON.stringify(payload.body)).not.toContain(scope.depositXeroInvoiceId);
    expect(main).toEqual(beforeMain); expect(deposit).toEqual(beforeDeposit);
    expect(() => assertD702946AuthorisedDepositRecoveryPayload(payload)).not.toThrow();
  });
  it("proves all retained Main fields plus the one deduction after order-independent readback", () => {
    const { main, deposit } = authorisedPair();
    const payload = prepareD702946AuthorisedDepositMainDeductionRecoveryPayload(main, deposit, "evidence");
    const actual = { ...main, ...(payload.body.Invoices as any[])[0], SubTotal: 8574.60, TotalTax: 857.47, Total: 9432.07,
      LineItems: [...main.LineItems, { ...scope.deduction, LineItemID: "new" }] };
    expect(() => assertD702946AuthorisedDepositRecoveryReadback({ ...actual, LineItems: [...actual.LineItems].reverse() }, payload)).not.toThrow();
    expect(() => assertD702946AuthorisedDepositRecoveryReadback({ ...actual, Reference: "changed" }, payload)).toThrow();
  });
  it("keeps V2 mutually exclusive and non-retriable at the guarded financial writer", () => {
    vi.stubEnv("FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    expect(() => assertFinancialDraftWriteAuthorised(context())).not.toThrow();
    expect(() => assertFinancialDraftWriteAuthorised({ ...context(), d702946DepositMainDeductionRecoveryEventId: 1 })).toThrow(/mutually exclusive/);
    expect(() => assertFinancialDraftWriteAuthorised({ ...context(), workflowType: "deposit_main_deduction" })).toThrow();
    expect(financialDraftWriteAllowsTransientRetry(context())).toBe(false);
  });
});
