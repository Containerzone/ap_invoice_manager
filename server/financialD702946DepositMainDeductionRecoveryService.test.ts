import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), auth: vi.fn(), request: vi.fn(), sourceMain: vi.fn(), sourceDeposit: vi.fn(),
  anchors: vi.fn(), conflicts: vi.fn(), reserve: vi.fn(), hold: vi.fn(), complete: vi.fn(), event: vi.fn(), writerReceipt: vi.fn(), execute: vi.fn(), policy: vi.fn() }));
vi.mock("axios", () => ({ default: { get: m.get, post: m.post, put: m.put } }));
vi.mock("./financialMainCustomerInvoiceService", () => ({ readMainCustomerInvoiceFacts: m.sourceMain }));
vi.mock("./financialDepositInvoiceSource", () => ({ readDepositInvoiceFacts: m.sourceDeposit }));
vi.mock("./financialD702946DepositMainDeductionRecoveryDb", () => ({ readD702946RecoveryAnchors: m.anchors, assertNoD702946RecoveryCompetingPaths: m.conflicts,
  reserveD702946DepositMainDeductionRecovery: m.reserve, holdD702946DepositMainDeductionRecovery: m.hold, completeD702946DepositMainDeductionRecovery: m.complete,
  getD702946DepositMainDeductionRecoveryEvent: m.event, assertD702946RecoveryWriterReceipt: m.writerReceipt }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.execute }));
vi.mock("./financialD702946DepositMainDeductionRecoveryRelease", async importOriginal => ({ ...await importOriginal<any>(), getD702946DepositMainDeductionRecoveryPolicy: m.policy }));
vi.mock("./xeroService", () => ({ EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE", getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.request }));
import { previewD702946DepositMainDeductionRecovery, applyApprovedD702946DepositMainDeductionRecovery, reconcileD702946DepositMainDeductionRecovery } from "./financialD702946DepositMainDeductionRecoveryService";
import { D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope } from "./financialD702946DepositMainDeductionRecoveryScope";
import { drafts, source, policy, anchors, receipt, updatedDraft, previewFixture } from "./financialD702946DepositMainDeductionRecovery.testFixtures";
import { EXPECTED_AP_XERO_TENANT_LABEL } from "./xeroService";
const input = { dealId: scope.dealId, originalMainEventId: scope.originalMainEventId };
let invoices: ReturnType<typeof drafts>;
beforeEach(() => {
  vi.clearAllMocks(); invoices = drafts();
  const facts = source(); m.sourceMain.mockResolvedValue(facts.mainFacts); m.sourceDeposit.mockResolvedValue(facts.depositFacts);
  m.auth.mockResolvedValue({ token: "mock-token", tenantId: "tenant" });
  m.request.mockImplementation(async (_auth: unknown, _operation: string, request: () => Promise<unknown>) => request());
  m.anchors.mockResolvedValue(anchors()); m.conflicts.mockResolvedValue(undefined); m.policy.mockResolvedValue(policy());
  m.reserve.mockResolvedValue({ state: "reserved", event: receipt() }); m.hold.mockResolvedValue(undefined); m.complete.mockResolvedValue(undefined);
  m.get.mockImplementation(async (url: string, config: any) => {
    if (url.endsWith("/Organisation")) return { data: { Organisations: [{ Name: EXPECTED_AP_XERO_TENANT_LABEL }] } };
    const number = config?.params?.InvoiceNumbers;
    const row = number ? number === scope.mainInvoiceNumber ? invoices.main : invoices.deposit : url.endsWith(scope.mainXeroInvoiceId) ? invoices.main : invoices.deposit;
    return { data: { Invoices: [structuredClone(row)] } };
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("D702946 GET-only no-persistence preview and isolated apply", () => {
  it("builds a complete exact preview with only number-then-ID GETs, no writer or persistence", async () => {
    const factsBefore = structuredClone(source()), xeroBefore = structuredClone(invoices);
    const result = await previewD702946DepositMainDeductionRecovery(input);
    expect(result.status).toBe("ready"); expect(result.noWrites).toBe(true);
    expect(m.get).toHaveBeenCalledTimes(5); expect(m.request).toHaveBeenCalledTimes(5); expect(m.post).not.toHaveBeenCalled(); expect(m.put).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.complete).not.toHaveBeenCalled(); expect(m.hold).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
    expect(invoices).toEqual(xeroBefore); expect(source()).toEqual(factsBefore);
    for (const number of [scope.mainInvoiceNumber, scope.depositInvoiceNumber]) {
      const index = m.get.mock.calls.findIndex(([, cfg]) => cfg?.params?.InvoiceNumbers === number);
      const id = number === scope.mainInvoiceNumber ? scope.mainXeroInvoiceId : scope.depositXeroInvoiceId;
      expect(m.get.mock.calls.findIndex(([url]) => url.endsWith(`/Invoices/${id}`))).toBeGreaterThan(index);
    }
    if (result.status === "ready") { expect(result.evidence.depositWriterExecutionId).toBe(1090001); expect(result.evidence.anchorEvidence).toEqual(anchors()); }
  });
  it.each([{ dealId: "5xanother" }, { originalMainEventId: 750002 }])("rejects invalid recovery scope before GET %#", async patch => {
    await expect(previewD702946DepositMainDeductionRecovery({ ...input, ...patch })).rejects.toThrow(); expect(m.get).not.toHaveBeenCalled();
  });
  it("uses the central Xero tenant queue for every recovery read", async () => {
    await previewD702946DepositMainDeductionRecovery(input);
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.request.mock.calls.map((call: unknown[]) => call[1])).toEqual(expect.arrayContaining([
      expect.stringContaining("GET financial-read:d702946-deposit-main-recovery:/Organisation"),
      expect.stringContaining("GET financial-read:d702946-deposit-main-recovery:/Invoices"),
    ]));
  });
  it("fails closed on competing paths, without a preview receipt", async () => {
    m.conflicts.mockRejectedValue(new Error("competing path"));
    await expect(previewD702946DepositMainDeductionRecovery(input)).rejects.toThrow(/competing/); expect(m.reserve).not.toHaveBeenCalled();
  });
  it("returns already for any contained historical/recovery marker and holds ambiguity", async () => {
    invoices.main.LineItems[0].Description = "Previously: Deposit deduction — INV-702946-D";
    expect(await previewD702946DepositMainDeductionRecovery(input)).toMatchObject({ status: "already_deducted", noWrites: true });
    invoices.main.LineItems.push({ ...invoices.main.LineItems[0], Description: "Less deposit invoice INV-702946-D", LineAmount: 0, TaxAmount: 0 });
    await expect(previewD702946DepositMainDeductionRecovery(input)).rejects.toThrow(/ambiguous/); expect(m.reserve).not.toHaveBeenCalled();
  });
  it("holds duplicate invoice number search before reading an arbitrary ID", async () => {
    m.get.mockResolvedValue({ data: { Organisations: [{ Name: EXPECTED_AP_XERO_TENANT_LABEL }], Invoices: [invoices.main, invoices.main] } });
    await expect(previewD702946DepositMainDeductionRecovery(input)).rejects.toThrow(/ambiguous/);
    expect(m.get.mock.calls.some(([url]) => url.endsWith(scope.mainXeroInvoiceId))).toBe(false);
  });
  it("never executes apply under generic gates alone", async () => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", undefined); vi.stubEnv("FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED", "true");
    await expect(applyApprovedD702946DepositMainDeductionRecovery(input)).rejects.toThrow(/disabled/);
    expect(m.get).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });
  it("preserves one-shot uncertain receipt and never loops or posts a retry", async () => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    m.execute.mockResolvedValue({ outcome: "reconciliation_required", executionId: 1200001, error: "504" });
    expect(await applyApprovedD702946DepositMainDeductionRecovery(input)).toMatchObject({ status: "reconciliation_required" });
    expect(m.execute).toHaveBeenCalledTimes(1); expect(m.hold).toHaveBeenCalledTimes(1); expect(m.complete).not.toHaveBeenCalled();
    const command = m.execute.mock.calls[0][0]; expect(command.workflowType).toBe(scope.workflowType); expect(command.authorisation.depositMainDeductionAutomaticEventId).toBeUndefined();
  });
  it("blocks an already-reserved receipt without another writer", async () => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true"); m.reserve.mockResolvedValue({ state: "blocked", event: receipt() });
    expect(await applyApprovedD702946DepositMainDeductionRecovery(input)).toMatchObject({ status: "blocked", noWrites: true }); expect(m.execute).not.toHaveBeenCalled();
  });
  it("completes only retained dedicated full-readback success", async () => {
    vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true");
    m.execute.mockResolvedValue({ outcome: "succeeded", executionId: 1200001, result: {}, recoveryReadbackEvidence: { full: "verified" } });
    expect(await applyApprovedD702946DepositMainDeductionRecovery(input)).toMatchObject({ status: "draft_updated" });
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ readbackEvidence: { full: "verified" } }));
  });
  it("reconciles only the consumed exact full Draft using GETs, not a writer or receipt replay", async () => {
    m.event.mockResolvedValue({ ...receipt(), status: "reconciliation_required", processingToken: null, executionId: 1200001, submittedAt: new Date() });
    invoices.main = updatedDraft() as any; m.writerReceipt.mockResolvedValue(undefined);
    expect(await reconcileD702946DepositMainDeductionRecovery({ eventId: 1 })).toMatchObject({ status: "draft_updated", noXeroWrite: true });
    expect(m.execute).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled();
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ payloadHash: receipt().payloadHash, readbackEvidence: expect.objectContaining({ main: invoices.main }) }));
  });
  it("cannot reconcile a payload absent/changed on the full Draft or an unconsumed receipt", async () => {
    m.event.mockResolvedValue({ ...receipt(), status: "reconciliation_required", processingToken: null, executionId: 1200001, submittedAt: new Date() });
    await expect(reconcileD702946DepositMainDeductionRecovery({ eventId: 1 })).rejects.toThrow();
    m.event.mockResolvedValue({ ...receipt(), status: "reconciliation_required", executionId: null });
    await expect(reconcileD702946DepositMainDeductionRecovery({ eventId: 1 })).rejects.toThrow(/consumed/);
    expect(m.complete).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });
});
