import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { drafts, source, policy, context, previewFixture, updatedDraft } from "./financialD702946DepositMainDeductionRecovery.testFixtures";
import { assertD702946RecoverySource, assertD702946RecoveryPair, assertD702946RecoveryPayload, assertD702946RecoveryReadback,
  d702946ExistingDeductions, prepareD702946DepositMainDeductionRecoveryPayload, D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope } from "./financialD702946DepositMainDeductionRecoveryScope";
import { resolveD702946DepositMainDeductionRecoveryPolicy, assertD702946DepositMainDeductionRecoveryRelease } from "./financialD702946DepositMainDeductionRecoveryRelease";
import { assertFinancialDraftWriteAuthorised, financialDraftWriteAllowsTransientRetry } from "./financialProductionWriter";
import { writableDraft } from "./financialDepositDraftCorrectionService";

afterEach(() => vi.unstubAllEnvs());
describe("closed D702946 deduction recovery scope", () => {
  it("is cleanly default off even under approved global/generic Deposit gates", () => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", undefined);
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED", "true");
    expect(resolveD702946DepositMainDeductionRecoveryPolicy(undefined)).toEqual({ enabled: false, releaseKey: "", approvedBy: null, approvedAt: null, scope: null });
    expect(() => assertD702946DepositMainDeductionRecoveryRelease(policy())).toThrow(/disabled/);
    expect(() => assertFinancialDraftWriteAuthorised(context())).toThrow(/default-off/);
  });
  it.each(["TRUE", "1", "false", ""])('requires literal true, not %s', gate => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", gate);
    expect(() => assertD702946DepositMainDeductionRecoveryRelease(policy())).toThrow();
  });
  it.each([{ enabled: false }, { scope: { ...scope, dealId: "5x490314" } }, { scope: { ...scope, mainRecoveryEventId: 2 } },
    { scope: { ...scope, deduction: { ...scope.deduction, TaxAmount: -45.46 } } }, { releaseKey: "generic-deposit" }, { approvedBy: null },
    { approvedAt: null }, { approvedAt: "not-a-time" }, { approvedAt: "2999-01-01T00:00:00Z" }])("rejects changed scope or generic approval %#", patch => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    expect(() => assertD702946DepositMainDeductionRecoveryRelease({ ...policy(), ...patch })).toThrow();
  });
  it("preserves EVERY existing writable header/line and only appends the exact cent override", () => {
    const { main, deposit } = drafts(), before = structuredClone(main);
    const payload = prepareD702946DepositMainDeductionRecoveryPayload(main, deposit, "evidence");
    const expected = writableDraft(main); expected.LineItems.push({ ...scope.deduction });
    expect(payload.body).toEqual({ Invoices: [expected] }); expect(main).toEqual(before);
    expect(payload).toMatchObject({ method: "POST", endpoint: `/Invoices/${scope.mainXeroInvoiceId}`, expectedXeroDocumentId: scope.mainXeroInvoiceId, documentNumber: "INV-702946" });
    expect(scope.deduction.LineAmount + scope.deduction.TaxAmount).toBe(-500);
    expect(scope.deduction.TaxAmount).toBe(-45.45); expect(payload.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertD702946RecoveryPayload(payload)).not.toThrow();
  });
  it.each(["Less deposit invoice INV-702946-D", "Note: Less deposit invoice INV-702946-D already", "Deposit deduction — INV-702946-D"])('holds existing contained marker %s', marker => {
    const { main, deposit } = drafts(); main.LineItems[0].Description = marker;
    expect(d702946ExistingDeductions(main)).toHaveLength(1);
    expect(() => prepareD702946DepositMainDeductionRecoveryPayload(main, deposit, "evidence")).toThrow(/Existing/);
  });
  it.each([{ dealId: "5xother" }, { dealNumber: "D702947" }, { sourceHoldReason: "mapping" }, { sourceRefreshedAt: null }, { quoteId: "other" }])("refuses mismatched source %#", patch => {
    const facts = source(); expect(() => assertD702946RecoverySource({ ...facts.mainFacts, ...patch }, facts.depositFacts)).toThrow();
  });
  it.each([499.99, 500.001, "500", null, NaN])("requires exact numeric $500 source %#", amount => {
    const facts = source(); expect(() => assertD702946RecoverySource(facts.mainFacts, { ...facts.depositFacts, depositAmountRequiredInclusive: amount })).toThrow();
  });
  it.each([{ Status: "AUTHORISED" }, { Type: "ACCPAY" }, { CurrencyCode: "USD" }, { LineAmountTypes: "Inclusive" }, { InvoiceID: "foreign" },
    { Contact: { ContactID: "" } }, { AmountPaid: 1 }, { AmountCredited: 1 }, { Payments: [{}] }, { CreditNotes: [{}] }, { Prepayments: [{}] }, { Overpayments: [{}] }])("requires unallocated exact Draft pair %#", patch => {
    const { main, deposit } = drafts(); expect(() => assertD702946RecoveryPair({ ...main, ...patch }, deposit)).toThrow();
  });
  it("accepts Xero null zero-credit evidence while retaining all other unallocated-Draft guards", () => {
    const { main, deposit } = drafts();
    main.AmountCredited = null; deposit.AmountCredited = null;
    expect(() => assertD702946RecoveryPair(main, deposit)).not.toThrow();
  });
  it("readback proves all retained headers/lines, exact amounts and bounded one-line payload, allowing generated ID/reordering", () => {
    const p = previewFixture().payload, actual = updatedDraft(p);
    expect(() => assertD702946RecoveryReadback(actual, p)).not.toThrow();
    expect(() => assertD702946RecoveryReadback({ ...actual, LineItems: [...actual.LineItems].reverse() }, p)).not.toThrow();
    expect(() => assertD702946RecoveryReadback({ ...actual, Reference: "changed" }, p)).toThrow();
    const changed = structuredClone(actual); changed.LineItems[0].Tracking = [];
    expect(() => assertD702946RecoveryReadback(changed, p)).toThrow();
    const tax = structuredClone(actual); tax.LineItems[1].TaxAmount = -45.46;
    expect(() => assertD702946RecoveryReadback(tax, p)).toThrow();
  });
  it("only accepts the mutually exclusive exact class, context and writer ID", () => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    expect(() => assertFinancialDraftWriteAuthorised(context())).not.toThrow();
    for (const patch of [{ workflowType: "deposit_main_deduction" }, { d702946DepositMainDeductionRecoveryToken: undefined },
      { executionId: undefined }, { approvalReference: "generic" }, { depositMainDeductionAutomaticEventId: 2 }, { mainInvoiceReconciliationEventId: 1 },
      { globalShadowMode: true }, { currentDocumentPreflightPassed: false }, { d702946DepositMainDeductionRecoveryApprovedBy: 0 }])
      expect(() => assertFinancialDraftWriteAuthorised({ ...context(), ...patch })).toThrow();
  });
  it("never retries this class or generic Deposit deduction", () => {
    expect(financialDraftWriteAllowsTransientRetry(context())).toBe(false);
    expect(financialDraftWriteAllowsTransientRetry({ ...context(), d702946DepositMainDeductionRecoveryEventId: undefined })).toBe(false);
    expect(financialDraftWriteAllowsTransientRetry({ ...context(), workflowType: "deposit_main_deduction", d702946DepositMainDeductionRecoveryEventId: undefined, depositMainDeductionAutomaticEventId: 4 })).toBe(false);
  });
  it("leaves generic main eligibility unchanged and no route exposes recovery apply", () => {
    const generic = readFileSync(new URL("./financialDepositMainDeductionService.ts", import.meta.url), "utf8");
    expect(generic).toContain('mainEvent.status !== "drafts_created"');
    expect(generic).not.toContain("D702946");
    for (const file of ["routers.ts", "financialWebhookRouter.ts"]) {
      try { expect(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")).not.toContain("applyApprovedD702946"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    }
  });
});
