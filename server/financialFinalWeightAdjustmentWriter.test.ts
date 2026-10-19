import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ verify: vi.fn(), consume: vi.fn(), auth: vi.fn(), put: vi.fn(), post: vi.fn(), request: vi.fn(), billingLock: vi.fn(), d702946Lock: vi.fn() }));
vi.mock("./financialFinalWeightAdjustmentDb", () => ({ verifyFinalWeightAutomaticWriteAccess: m.verify, consumeFinalWeightPayload: m.consume }));
vi.mock("./financialBillingPartySyncDb", () => ({ getBillingPartySyncPendingInvoiceLock: m.billingLock }));
vi.mock("./financialD702946DepositMainDeductionRecoveryDb", () => ({ getPendingD702946DepositMainDeductionRecovery: m.d702946Lock }));
vi.mock("axios", () => ({ default: { put: m.put, post: m.post } }));
vi.mock("./xeroService", () => ({ EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE", getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.request }));
import { assertFinancialDraftWriteAuthorised, executeFinancialDraftWrite, type FinancialWriteAuthorisation } from "./financialProductionWriter";
import { buildFinalWeightAdjustment, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { facts, policy, xero } from "./_test/finalWeightFixtures";
const context = (patch: Partial<FinancialWriteAuthorisation> = {}): FinancialWriteAuthorisation => ({ executionId: 9, workflowType: "final_weight_adjustment", approvalReference: policy().releaseKey, globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, finalWeightAutomaticEventId: 1, finalWeightDirection: "overweight", finalWeightReleaseKey: policy().releaseKey, finalWeightApprovedBy: 7, ...patch });
const payload = () => prepareFinalWeightPayload(buildFinalWeightAdjustment(facts(), "overweight", xero()), "source-hash");
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "false"); m.billingLock.mockResolvedValue(null); m.d702946Lock.mockResolvedValue(null); m.verify.mockResolvedValue(undefined); m.consume.mockResolvedValue(undefined); m.auth.mockResolvedValue({ token: "test-token", tenantId: "test-tenant" }); m.request.mockImplementation(async (_auth, _name, operation) => operation()); m.post.mockResolvedValue({ data: { Invoices: [{ InvoiceID: "invoice-exact", InvoiceNumber: "INV-702877", Status: "DRAFT" }] } }); });
afterEach(() => vi.unstubAllEnvs());
describe("Final-weight narrowly isolated production amendment writer", () => {
  it("requires independent default-off env even if global/Main/Deposit enabled", () => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", ""); vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED", "true");
    expect(() => assertFinancialDraftWriteAuthorised(context())).toThrow(/independent/);
  });
  it.each([
    { workflowType: "main_customer_invoice" }, { finalWeightAutomaticEventId: undefined }, { finalWeightAutomaticEventId: 0 }, { finalWeightDirection: "other" },
    { finalWeightApprovedBy: 0 }, { finalWeightReleaseKey: undefined }, { approvalReference: "main-release" }, { executionId: null },
    { currentDocumentPreflightPassed: false }, { legacyWriterHandoffComplete: false }, { mainCustomerInvoiceAutomaticEventId: 7 }, { depositInvoiceAutomaticEventId: 7 },
    { assetPurchaseAutomaticEventId: 7 }, { storageAutomaticEventId: 7 }, { storagePilotEventId: 7 }, { forHireAutomaticEventId: 7 }, { customerSalePurchaseAutomaticEventId: 7 },
  ])("rejects invalid or cross-family authorisation %#", patch => {
    expect(() => assertFinancialDraftWriteAuthorised(context(patch as any))).toThrow();
  });
  it.each([
    { method: "PUT" }, { endpoint: "/Invoices" }, { endpoint: "/Invoices/other" }, { expectedXeroDocumentId: null }, { documentFamily: "purchase_order" },
    { documentNumber: "INV-702877-D" }, { documentNumber: "INV-702877-2" }, { idempotencyKey: "bad" },
  ])("rejects create/other update transport %# before auth or ledger consumption", async patch => {
    await expect(executeFinancialDraftWrite({ ...payload(), ...patch } as any, context())).rejects.toThrow();
    expect(m.auth).not.toHaveBeenCalled(); expect(m.verify).not.toHaveBeenCalled(); expect(m.consume).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it.each([{ Status: "AUTHORISED" }, { Type: "ACCPAY" }, { InvoiceID: "other" }, { InvoiceNumber: "INV-1" }, { CurrencyCode: "USD" }, { LineAmountTypes: "Inclusive" }, { Contact: {} }, { LineItems: [] }, { DueDate: "" }])("rejects unrelated Draft payload type %#", async patch => {
    const value = payload(); (value.body.Invoices as any[])[0] = { ...(value.body.Invoices as any[])[0], ...patch };
    await expect(executeFinancialDraftWrite(value, context())).rejects.toThrow(/specific existing/); expect(m.auth).not.toHaveBeenCalled();
  });
  it("requires immutable exact-payload authorization before any one-shot consumption/auth", async () => {
    m.verify.mockRejectedValue(new Error("No exact ledger authorization"));
    await expect(executeFinancialDraftWrite(payload(), context())).rejects.toThrow(/ledger/);
    expect(m.consume).not.toHaveBeenCalled(); expect(m.auth).not.toHaveBeenCalled();
  });
  it("one-time consumed payload blocks any subsequent transport", async () => {
    m.consume.mockRejectedValue(new Error("Already consumed"));
    await expect(executeFinancialDraftWrite(payload(), context())).rejects.toThrow(/consumed/); expect(m.auth).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it("performs exactly one specific Draft POST update only after verification/consume, never PUT or transient retry", async () => {
    const value = payload(); await executeFinancialDraftWrite(value, context());
    expect(m.verify).toHaveBeenCalledWith(expect.objectContaining({ eventId: 1, direction: "overweight", payload: value }));
    expect(m.consume).toHaveBeenCalledWith(expect.objectContaining({ eventId: 1 }), 9);
    expect(m.post).toHaveBeenCalledWith("https://api.xero.com/api.xro/2.0/Invoices/invoice-exact", value.body, expect.any(Object));
    expect(m.put).not.toHaveBeenCalled(); expect(m.request.mock.calls[0]![3]).toEqual({ retryTransientGatewayFailures: false });
    expect(m.verify.mock.invocationCallOrder[0]).toBeLessThan(m.consume.mock.invocationCallOrder[0]!);
    expect(m.consume.mock.invocationCallOrder[0]).toBeLessThan(m.auth.mock.invocationCallOrder[0]!);
  });
  it.each(["reserved", "submitted", "reconciliation_required"])("blocks transport while billing sync is %s, even after the rate limiter delay", async state => {
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.request.mockImplementation(async (_auth, _operation, operation) => {
      m.billingLock.mockResolvedValue({ id: 3, state, xeroInvoiceId: "invoice-exact" });
      return operation();
    });
    await expect(executeFinancialDraftWrite(payload(), context())).rejects.toThrow(/pending or uncertain billing-party update/);
    expect(m.billingLock).toHaveBeenCalledWith("invoice-exact");
    expect(m.post).not.toHaveBeenCalled(); expect(m.put).not.toHaveBeenCalled();
  });
  it("allows a fully verified billing transition and does not read locks when sync is disabled", async () => {
    await executeFinancialDraftWrite(payload(), context());
    expect(m.billingLock).not.toHaveBeenCalled();
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.billingLock.mockResolvedValue(null);
    await executeFinancialDraftWrite(payload(), context());
    expect(m.billingLock).toHaveBeenCalledWith("invoice-exact");
    expect(m.post).toHaveBeenCalledTimes(2);
  });
  it("blocks a separate Draft amendment while the D702946 recovery receipt is pending or uncertain", async () => {
    m.d702946Lock.mockResolvedValue({ id: 1, status: "reconciliation_required" });
    await expect(executeFinancialDraftWrite(payload(), context())).rejects.toThrow(/Deposit deduction recovery/i);
    expect(m.d702946Lock).toHaveBeenCalledWith("invoice-exact");
    expect(m.post).not.toHaveBeenCalled();
  });
  it("holds a wrong/non-Draft transport response for reconciliation", async () => {
    m.post.mockResolvedValue({ data: { Invoices: [{ InvoiceID: "wrong", InvoiceNumber: "INV-702877", Status: "AUTHORISED" }] } });
    await expect(executeFinancialDraftWrite(payload(), context())).rejects.toThrow(/exact expected Draft/);
  });
});
