import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), auth: vi.fn(), request: vi.fn(), sourceMain: vi.fn(), sourceDeposit: vi.fn(),
  anchors: vi.fn(), conflicts: vi.fn(), reserve: vi.fn(), hold: vi.fn(), complete: vi.fn(), event: vi.fn(), writerReceipt: vi.fn(), execute: vi.fn(), policy: vi.fn() }));
vi.mock("axios", () => ({ default: { get: m.get, post: m.post, put: m.put } }));
vi.mock("./financialMainCustomerInvoiceService", () => ({ readMainCustomerInvoiceFacts: m.sourceMain }));
vi.mock("./financialDepositInvoiceSource", () => ({ readDepositInvoiceFacts: m.sourceDeposit }));
vi.mock("./financialD702946DepositMainDeductionRecoveryDb", () => ({ readD702946RecoveryAnchors: m.anchors, assertNoD702946RecoveryCompetingPaths: m.conflicts }));
vi.mock("./financialD702946AuthorisedDepositMainDeductionRecoveryDb", () => ({ reserveD702946AuthorisedDepositMainDeductionRecovery: m.reserve,
  holdD702946AuthorisedDepositMainDeductionRecovery: m.hold, completeD702946AuthorisedDepositMainDeductionRecovery: m.complete,
  getD702946AuthorisedDepositMainDeductionRecoveryEvent: m.event, assertD702946AuthorisedDepositRecoveryWriterReceipt: m.writerReceipt }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.execute }));
vi.mock("./financialD702946AuthorisedDepositMainDeductionRecoveryRelease", async importOriginal => ({ ...await importOriginal<any>(), getD702946AuthorisedDepositMainDeductionRecoveryPolicy: m.policy }));
vi.mock("./xeroService", () => ({ EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE", getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.request }));
import { previewD702946AuthorisedDepositMainDeductionRecovery, applyApprovedD702946AuthorisedDepositMainDeductionRecovery, reconcileD702946AuthorisedDepositMainDeductionRecovery } from "./financialD702946AuthorisedDepositMainDeductionRecoveryService";
import { D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY } from "./financialD702946AuthorisedDepositMainDeductionRecoveryScope";
import { drafts, source, anchors } from "./financialD702946DepositMainDeductionRecovery.testFixtures";
const input = { dealId: scope.dealId, originalMainEventId: scope.originalMainEventId };
const policy = () => ({ enabled: true, releaseKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, approvedBy: 7, approvedAt: "2026-10-19T00:00:00.000Z", scope });
let invoices: ReturnType<typeof drafts>;
function receipt() {
  return { id: 2, scopeKey: "D702946-authorised-deposit-main-deduction-recovery-v2", status: "reserved", processingToken: "token", executionId: null, submittedAt: null };
}
beforeEach(() => {
  vi.clearAllMocks(); invoices = drafts(); invoices.deposit.Status = "AUTHORISED"; (invoices.deposit as any).AmountDue = 500;
  const facts = source(); m.sourceMain.mockResolvedValue(facts.mainFacts); m.sourceDeposit.mockResolvedValue(facts.depositFacts);
  m.auth.mockResolvedValue({ token: "mock-token", tenantId: "tenant" }); m.request.mockImplementation(async (_auth: unknown, _operation: string, request: () => Promise<unknown>) => request());
  m.anchors.mockResolvedValue(anchors()); m.conflicts.mockResolvedValue(undefined); m.policy.mockResolvedValue(policy());
  m.reserve.mockResolvedValue({ state: "reserved", event: receipt() }); m.hold.mockResolvedValue(undefined); m.complete.mockResolvedValue(undefined);
  m.get.mockImplementation(async (url: string, config: any) => {
    if (url.endsWith("/Organisation")) return { data: { Organisations: [{ Name: "CONTAINERZONE" }] } };
    const number = config?.params?.InvoiceNumbers;
    const row = number ? number === scope.mainInvoiceNumber ? invoices.main : invoices.deposit : url.endsWith(scope.mainXeroInvoiceId) ? invoices.main : invoices.deposit;
    return { data: { Invoices: [structuredClone(row)] } };
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("D702946 Authorised Deposit V2 recovery", () => {
  it("uses only GETs to build an exact Main-Draft-only payload, with the Deposit retained as Authorised evidence", async () => {
    const result = await previewD702946AuthorisedDepositMainDeductionRecovery(input);
    expect(result).toMatchObject({ status: "ready", noWrites: true }); expect(m.get).toHaveBeenCalledTimes(5); expect(m.post).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled();
    if (result.status === "ready") {
      expect(result.evidence.depositXeroSnapshot.Status).toBe("AUTHORISED");
      expect(result.payload.endpoint).toBe(`/Invoices/${scope.mainXeroInvoiceId}`);
      expect(JSON.stringify(result.payload.body)).not.toContain(scope.depositXeroInvoiceId);
    }
  });
  it.each([{ Status: "DRAFT" }, { AmountDue: 0 }, { AmountDue: 499.99 }, { AmountPaid: 1 }, { AmountCredited: 1 }])("rejects changed Authorised Deposit evidence before any reservation %#", async patch => {
    Object.assign(invoices.deposit, patch); await expect(previewD702946AuthorisedDepositMainDeductionRecovery(input)).rejects.toThrow(); expect(m.reserve).not.toHaveBeenCalled();
  });
  it("requires the V2 gate and never accepts V1/generic gates", async () => {
    vi.stubEnv("FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "false");
    await expect(applyApprovedD702946AuthorisedDepositMainDeductionRecovery(input)).rejects.toThrow(/disabled/);
    expect(m.get).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });
  it("holds one uncertain outcome and never attempts a retry", async () => {
    vi.stubEnv("FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    m.execute.mockResolvedValue({ outcome: "reconciliation_required", executionId: 1200002, error: "504" });
    expect(await applyApprovedD702946AuthorisedDepositMainDeductionRecovery(input)).toMatchObject({ status: "reconciliation_required" });
    expect(m.execute).toHaveBeenCalledTimes(1); expect(m.hold).toHaveBeenCalledTimes(1); expect(m.complete).not.toHaveBeenCalled();
  });
  it("reconciliation uses only GET evidence and requires the Authorised Deposit to remain unchanged", async () => {
    m.event.mockResolvedValue({ ...receipt(), status: "reconciliation_required", processingToken: null, executionId: 1200002, submittedAt: new Date(), authorisedPayload: { body: { Invoices: [{}] } }, payloadHash: "hash", anchorEvidenceHash: "anchor" });
    await expect(reconcileD702946AuthorisedDepositMainDeductionRecovery({ eventId: 2 })).rejects.toThrow();
    expect(m.post).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });
});
