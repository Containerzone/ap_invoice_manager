import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), sourceMain: vi.fn(), sourceDeposit: vi.fn(), anchors: vi.fn(), conflicts: vi.fn(),
  reserve: vi.fn(), hold: vi.fn(), complete: vi.fn(), event: vi.fn(), writerReceipt: vi.fn(), execute: vi.fn(), policy: vi.fn() }));
vi.mock("./financialMainCustomerInvoiceService", () => ({ readMainCustomerInvoiceFacts: m.sourceMain }));
vi.mock("./financialDepositInvoiceSource", () => ({ readDepositInvoiceFacts: m.sourceDeposit }));
vi.mock("./financialD702959AuthorisedDepositMainDeductionRecoveryDb", () => ({
  readD702959AuthorisedDepositRecoveryAnchors: m.anchors, assertNoD702959AuthorisedDepositRecoveryCompetingPaths: m.conflicts,
  reserveD702959AuthorisedDepositMainDeductionRecovery: m.reserve, holdD702959AuthorisedDepositMainDeductionRecovery: m.hold,
  completeD702959AuthorisedDepositMainDeductionRecovery: m.complete, getD702959AuthorisedDepositMainDeductionRecoveryEvent: m.event,
  assertD702959AuthorisedDepositRecoveryWriterReceipt: m.writerReceipt,
}));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.execute }));
vi.mock("./financialD702959AuthorisedDepositMainDeductionRecoveryRelease", async importOriginal => ({ ...await importOriginal<any>(), getD702959AuthorisedDepositMainDeductionRecoveryPolicy: m.policy }));
vi.mock("./xeroService", () => ({ EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE", getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runBoundedXeroGet: m.get }));
import {
  applyApprovedD702959AuthorisedDepositMainDeductionRecovery,
  previewD702959AuthorisedDepositMainDeductionRecovery,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryService";
import { anchors, drafts, scope, source } from "./financialD702959AuthorisedDepositMainDeductionRecovery.testFixtures";
import { D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY } from "./financialD702959AuthorisedDepositMainDeductionRecoveryScope";

const input = { dealId: scope.dealId, originalMainEventId: scope.originalMainEventId };
const policy = () => ({ enabled: true, releaseKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, approvedBy: 7, approvedAt: "2026-10-29T00:00:00.000Z", scope });
const receipt = () => ({ id: 1, scopeKey: "D702959-authorised-deposit-main-deduction-recovery-v1", status: "reserved", processingToken: "token", executionId: null, submittedAt: null });
let invoices: ReturnType<typeof drafts>;

beforeEach(() => {
  vi.clearAllMocks(); invoices = drafts();
  const facts = source(); m.sourceMain.mockResolvedValue(facts.mainFacts); m.sourceDeposit.mockResolvedValue(facts.depositFacts);
  m.auth.mockResolvedValue({ token: "mock-token", tenantId: "tenant" }); m.anchors.mockResolvedValue(anchors()); m.conflicts.mockResolvedValue(undefined); m.policy.mockResolvedValue(policy());
  m.reserve.mockResolvedValue({ state: "reserved", event: receipt() }); m.hold.mockResolvedValue(undefined); m.complete.mockResolvedValue(undefined);
  m.get.mockImplementation(async (_auth: unknown, _operation: string, url: string, config: any) => {
    if (url.endsWith("/Organisation")) return { data: { Organisations: [{ Name: "CONTAINERZONE" }] } };
    const number = config?.params?.InvoiceNumbers;
    const row = number ? number === scope.mainInvoiceNumber ? invoices.main : invoices.deposit : url.endsWith(scope.mainXeroInvoiceId) ? invoices.main : invoices.deposit;
    return { data: { Invoices: [structuredClone(row)] } };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("D702959 server-only Authorised Deposit recovery", () => {
  it("uses only bounded GETs to produce the exact Main-only payload; Authorised Deposit is evidence only", async () => {
    const result = await previewD702959AuthorisedDepositMainDeductionRecovery(input);
    expect(result).toMatchObject({ status: "ready", noWrites: true });
    expect(m.get).toHaveBeenCalledTimes(5); expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
    expect(m.get.mock.calls.every(call => call[4]?.retryRateLimitOnce === false)).toBe(true);
    if (result.status === "ready") {
      expect(result.evidence.mainXeroSnapshot.InvoiceID).toBe(scope.mainXeroInvoiceId);
      expect(result.evidence.depositXeroSnapshot.Status).toBe("AUTHORISED");
      expect(result.payload.endpoint).toBe(`/Invoices/${scope.mainXeroInvoiceId}`);
      expect(JSON.stringify(result.payload.body)).not.toContain(scope.depositXeroInvoiceId);
    }
  });

  it.each([
    ["source Deposit mismatch", () => { m.sourceDeposit.mockResolvedValue({ ...source().depositFacts, depositAmountRequiredInclusive: 501 }); }],
    ["Authorised Deposit amount mismatch", () => { invoices.deposit.Total = 501; invoices.deposit.AmountDue = 501; invoices.deposit.LineItems[0].UnitAmount = 501; invoices.deposit.LineItems[0].LineAmount = 501; }],
    ["Main already deducted", () => { invoices.main.LineItems.push({ ...invoices.main.LineItems[0], LineItemID: "already", Description: "Less deposit invoice INV-702959-D", LineAmount: -454.55, TaxAmount: -45.45, UnitAmount: -454.55, Tracking: [] }); }],
    ["Main allocated", () => { invoices.main.AmountPaid = 1; }],
    ["Main status changed", () => { invoices.main.Status = "AUTHORISED"; }],
    ["Deposit status changed", () => { invoices.deposit.Status = "DRAFT"; }],
  ])("holds %s before reservation", async (_name, patch) => {
    patch();
    await expect(previewD702959AuthorisedDepositMainDeductionRecovery(input)).rejects.toThrow();
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it("does not make a source/Xero/ledger operation while the distinct gate remains default-off", async () => {
    vi.stubEnv("FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "false");
    await expect(applyApprovedD702959AuthorisedDepositMainDeductionRecovery(input)).rejects.toThrow(/disabled/);
    expect(m.sourceMain).not.toHaveBeenCalled(); expect(m.get).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it("holds the sole reservation after one uncertain writer outcome and never retries", async () => {
    vi.stubEnv("FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    m.execute.mockResolvedValue({ outcome: "reconciliation_required", executionId: 2200001, error: "504" });
    await expect(applyApprovedD702959AuthorisedDepositMainDeductionRecovery(input)).resolves.toMatchObject({ status: "reconciliation_required", eventId: 1 });
    expect(m.execute).toHaveBeenCalledTimes(1); expect(m.hold).toHaveBeenCalledTimes(1); expect(m.complete).not.toHaveBeenCalled();
  });

  it("rejects a substituted invocation context without any external operation", async () => {
    await expect(previewD702959AuthorisedDepositMainDeductionRecovery({ dealId: "other", originalMainEventId: scope.originalMainEventId })).rejects.toThrow(/exclusively/);
    await expect(previewD702959AuthorisedDepositMainDeductionRecovery({ dealId: scope.dealId, originalMainEventId: 1 })).rejects.toThrow(/exclusively/);
    expect(m.sourceMain).not.toHaveBeenCalled(); expect(m.get).not.toHaveBeenCalled();
  });
});
