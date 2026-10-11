import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ policy: vi.fn(), event: vi.fn(), entries: vi.fn(), consume: vi.fn(), receipt: vi.fn(), finish: vi.fn(), source: vi.fn(), xero: vi.fn(), readback: vi.fn(), auth: vi.fn(), request: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: vi.fn() }));
vi.mock("./financialWarrantyAvisoRelease", async original => ({ ...(await original<any>()), getWarrantyReleasePolicy: m.policy }));
vi.mock("./financialWarrantyAvisoDb", () => ({ getWarrantyEvent: m.event, getWarrantyExecutionEntries: m.entries, consumeWarrantyStep: m.consume, recordWarrantyReceipt: m.receipt, finishWarranty: m.finish }));
vi.mock("./financialWarrantyAvisoSource", () => ({ readWarrantyFacts: m.source }));
vi.mock("./financialWarrantyAvisoXero", () => ({ readWarrantyXeroEvidence: m.xero, readWarrantyDocument: m.readback }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.request }));
vi.mock("axios", () => ({ default: { put: m.put, post: m.post } }));
import { warrantyFixture } from "./financialWarrantyAvisoFixtures";
import { resolveWarrantyRelease } from "./financialWarrantyAvisoRelease";
import { authorizeWarrantyWrite, executeWarrantyOperation, executeWarrantyPair, type WarrantyWriterContext } from "./financialWarrantyAvisoWriter";

let f: ReturnType<typeof warrantyFixture>;
let entries: any[];
const context = (step: "main" | "po" = "main"): WarrantyWriterContext => ({ family: "warranty_aviso", reservationId: f.reservation.id, releaseKey: f.policy.releaseKey, approvedBy: 7, step });
const noTransport = () => {
  expect(m.auth).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled(); expect(m.put).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
};
const mainReadback = () => {
  const main = structuredClone(f.plan.expectedMain);
  main.LineItems[1].LineItemID = "appended-line-id";
  return main;
};
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
  f = warrantyFixture(); entries = [];
  m.policy.mockImplementation(async () => f.policy);
  m.event.mockImplementation(async () => f.reservation);
  m.entries.mockImplementation(async () => entries);
  m.source.mockImplementation(async () => f.facts);
  m.xero.mockImplementation(async () => entries.some(e => e.status === "main_receipt" && e.receipt?.readbackVerified === true) ? { ...f.evidence, main: mainReadback() } : f.evidence);
  m.auth.mockResolvedValue({ token: "synthetic-token", tenantId: "synthetic-tenant" });
  m.consume.mockImplementation(async (_reservation, step) => {
    if (entries.some(e => e.status === `${step}_submitted`)) throw new Error("Immutable attempt consumed");
    entries.push({ status: `${step}_submitted` });
  });
  m.receipt.mockImplementation(async (_reservation, step, receipt) => { entries.push({ status: `${step}_receipt`, receipt: structuredClone(receipt) }); });
  m.finish.mockImplementation(async (_reservation, status, holdReason, receipt) => { entries.push({ status, holdReason, receipt }); });
  m.request.mockImplementation(async (_auth, _operation, fn) => fn());
  m.put.mockResolvedValue({ status: 200, data: { Invoices: [{ InvoiceID: "main-id", InvoiceNumber: "INV-77", Status: "DRAFT" }] } });
  m.post.mockResolvedValue({ status: 200, data: { PurchaseOrders: [{ PurchaseOrderID: "po-id", PurchaseOrderNumber: "I77", Status: "DRAFT" }] } });
  m.readback.mockImplementation(async kind => kind === "main" ? mainReadback() : { ...structuredClone(f.plan.expectedPo), PurchaseOrderID: "po-id" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Warranty isolated release-backed exact write authorization", () => {
  it("valid authorization independently re-reads exact source and Xero but performs no write", async () => {
    expect(await authorizeWarrantyWrite(f.plan.mainPayload, context())).toMatchObject({ plan: f.plan });
    expect(m.source).toHaveBeenCalledWith("5x77", f.config); expect(m.xero).toHaveBeenCalledWith(f.facts); noTransport();
  });
  it("missing policy rejects even generic live flags before any reservation/source/Xero access", async () => {
    m.policy.mockResolvedValue(resolveWarrantyRelease(null));
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/disabled/);
    expect(m.event).not.toHaveBeenCalled(); expect(m.source).not.toHaveBeenCalled(); expect(m.xero).not.toHaveBeenCalled(); noTransport();
  });
  it("unset dedicated flag never inherits global/storage/Main authorization", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", ""); vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/disabled/); noTransport();
  });
  it.each([
    { family: "main_customer_invoice" }, { family: "generic" }, { step: "invoice" }, { releaseKey: "generic" }, { approvedBy: 8 },
    { family: undefined, workflowType: "warranty", globalShadowMode: false, familyLiveEnabled: true, currentDocumentPreflightPassed: true },
  ])("generic/forged context %j cannot authorize transport", async patch => {
    await expect(executeWarrantyOperation(f.plan.mainPayload, { ...context(), ...patch } as any)).rejects.toThrow(/authority/);
    expect(m.source).not.toHaveBeenCalled(); noTransport();
  });
  it.each(["status", "claimKey", "executionGroup", "releaseKey", "approvedBy", "authorisedPayload", "policyHash", "stale", "future", "sourceHash", "xeroHash", "proposal"])("tampered immutable authority %s rejected before source/HTTP", async kind => {
    const r = f.reservation;
    if (kind === "status") r.status = "held";
    if (kind === "claimKey") r.claimKey = null;
    if (kind === "executionGroup") r.executionGroup = null;
    if (kind === "releaseKey") r.releaseKey = "generic";
    if (kind === "approvedBy") r.approvedBy = 8;
    if (kind === "authorisedPayload") r.authorisedPayload = null;
    if (kind === "policyHash") r.authorisedPayload.policyHash = "f".repeat(64);
    if (kind === "stale") r.createdAt = new Date(Date.now() - 300001);
    if (kind === "future") r.createdAt = new Date(Date.now() + 1);
    if (kind === "sourceHash") r.sourceSnapshotHash = "f".repeat(64);
    if (kind === "xeroHash") r.xeroPreflightHash = "f".repeat(64);
    if (kind === "proposal") r.proposal = { ...f.plan, mainNumber: "INV-OTHER" };
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/authority|authorit|corrupted|mismatch/);
    expect(m.source).not.toHaveBeenCalled(); noTransport();
  });
  it.each(["method", "endpoint", "operation", "idempotencyKey", "line", "header"])("exact operation/body %s cannot be caller-tampered", async kind => {
    const payload = structuredClone(f.plan.mainPayload);
    if (kind === "method") payload.method = "POST";
    if (kind === "endpoint") payload.endpoint = "/Invoices";
    if (kind === "operation") payload.operation = "create_aviso_draft";
    if (kind === "idempotencyKey") payload.idempotencyKey = "forged";
    if (kind === "line") payload.body.Invoices[0].LineItems[0].AccountCode = "313";
    if (kind === "header") payload.body.Invoices[0].DueDate = "2026-10-16";
    await expect(executeWarrantyOperation(payload, context())).rejects.toThrow(/exact operation\/body\/line/);
    expect(m.source).not.toHaveBeenCalled(); noTransport();
  });
  it.each([false, undefined, null, "true", "false", 1, {}])("PO blocked if main_receipt readbackVerified=%j is not literal true", async readbackVerified => {
    entries.push({ status: "main_receipt", receipt: { xeroDocumentId: "main-id", readbackVerified } });
    await expect(executeWarrantyOperation(f.plan.poPayload, context("po"))).rejects.toThrow(/verified-main-readback/);
    expect(m.source).not.toHaveBeenCalled(); expect(m.consume).not.toHaveBeenCalled(); noTransport();
  });
  it("PO blocked when no main receipt exists or only a submitted attempt exists", async () => {
    for (const prior of [[], [{ status: "main_submitted" }]]) {
      entries = prior;
      await expect(executeWarrantyOperation(f.plan.poPayload, context("po"))).rejects.toThrow(/verified-main-readback/);
    }
    noTransport();
  });
  it.each(["reconciliation_required", "drafts_created", "main_submitted", "main_receipt"])("main cannot retry after %s", async status => {
    entries.push({ status, receipt: { readbackVerified: true } });
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/no retry/); noTransport();
  });
  it("even verified receipt does not bypass full current main readback before PO", async () => {
    entries.push({ status: "main_receipt", receipt: { readbackVerified: true } });
    const current = mainReadback(); current.LineItems[0].Description = "Changed after readback";
    m.xero.mockResolvedValue({ ...f.evidence, main: current });
    await expect(executeWarrantyOperation(f.plan.poPayload, context("po"))).rejects.toThrow(/full-line/); noTransport();
  });
  it("policy edits after reservation invalidate the independent policy hash", async () => {
    m.policy.mockResolvedValue({ ...f.policy, avisoContactId: "another-aviso-id" });
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/authority/); noTransport();
  });
  it("fresh source or Xero preflight drift fails before transport", async () => {
    m.source.mockResolvedValue({ ...f.facts, customerName: "Changed" });
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/changed/);
    m.source.mockResolvedValue(f.facts); m.xero.mockResolvedValue({ ...f.evidence, comparisonHash: "f".repeat(64) });
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/preflight drift/); noTransport();
  });
});

describe("Warranty one-shot mocked transport and reconciliation", () => {
  it("one pair consumes each step before transport, verifies full readback before PO and never retries or queues CRM", async () => {
    const result = await executeWarrantyPair(f.reservation, f.plan, 7);
    expect(result).toMatchObject({ ok: true, status: "drafts_created", xeroWritesAttempted: 2 });
    expect(m.put).toHaveBeenCalledTimes(1); expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.consume.mock.calls.map(c => c[1])).toEqual(["main", "po"]);
    expect(m.consume.mock.invocationCallOrder[0]).toBeLessThan(m.put.mock.invocationCallOrder[0]);
    expect(m.consume.mock.invocationCallOrder[1]).toBeLessThan(m.post.mock.invocationCallOrder[0]);
    expect(m.readback.mock.invocationCallOrder[0]).toBeLessThan(m.receipt.mock.invocationCallOrder[0]);
    expect(m.receipt.mock.calls[0][2].readbackVerified).toBe(true);
    expect(m.receipt.mock.invocationCallOrder[0]).toBeLessThan(m.post.mock.invocationCallOrder[0]);
    for (const call of m.request.mock.calls) expect(call[3]).toEqual({ retryTransientGatewayFailures: false });
    expect(m.put).toHaveBeenCalledWith("https://api.xero.com/api.xro/2.0/Invoices/main-id", f.plan.mainPayload.body, {
      headers: { Authorization: "Bearer synthetic-token", "Xero-tenant-id": "synthetic-tenant", "Content-Type": "application/json", "Idempotency-Key": f.plan.mainPayload.idempotencyKey }, timeout: 20000,
    });
    expect(m.finish).toHaveBeenCalledWith(f.reservation, "drafts_created", null, expect.any(Object));
  });
  it("tenant drift holds before consumption or HTTP", async () => {
    m.auth.mockResolvedValue({ token: "synthetic", tenantId: "other-tenant" });
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/tenant changed/);
    expect(m.consume).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled();
  });
  it.each(["originalLine", "appendedTax", "header"])("successful main HTTP with %s full-readback mismatch never permits PO", async kind => {
    const current = mainReadback();
    if (kind === "originalLine") current.LineItems[0].Description = "Changed";
    if (kind === "appendedTax") current.LineItems[1].TaxType = "INPUT";
    if (kind === "header") current.Reference = "Changed";
    m.readback.mockResolvedValue(current);
    expect(await executeWarrantyPair(f.reservation, f.plan, 7)).toMatchObject({ ok: false, status: "reconciliation_required" });
    expect(m.post).not.toHaveBeenCalled(); expect(m.put).toHaveBeenCalledTimes(1);
    expect(m.receipt.mock.calls[0][2]).toMatchObject({ readbackVerified: false, xeroDocumentId: "main-id", httpStatus: 200 });
    await expect(executeWarrantyOperation(f.plan.poPayload, context("po"))).rejects.toThrow(/no retry/);
    expect(m.post).not.toHaveBeenCalled();
  });
  it("response-only main receipt without full document readback is false and terminal", async () => {
    m.readback.mockRejectedValue(new Error("Full GET unavailable"));
    expect(await executeWarrantyPair(f.reservation, f.plan, 7)).toMatchObject({ status: "reconciliation_required" });
    expect(m.receipt.mock.calls[0][2]).toMatchObject({ httpStatus: 200, readbackVerified: false });
    expect(m.post).not.toHaveBeenCalled();
  });
  it("verified main + PO transport failure retains both receipts and terminal reconciliation with no retry", async () => {
    m.post.mockRejectedValue(new Error("Uncertain gateway response"));
    expect(await executeWarrantyPair(f.reservation, f.plan, 7)).toMatchObject({ ok: false, status: "reconciliation_required", xeroWritesAttemptedUpperBound: 2 });
    expect(m.receipt.mock.calls.map(c => [c[1], c[2].readbackVerified])).toEqual([["main", true], ["po", false]]);
    expect(entries.at(-1).status).toBe("reconciliation_required");
    expect(f.reservation.claimKey).toBe("warranty:D77");
    await expect(executeWarrantyOperation(f.plan.mainPayload, context())).rejects.toThrow(/no retry/);
    await expect(executeWarrantyOperation(f.plan.poPayload, context("po"))).rejects.toThrow(/no retry/);
    expect(m.put).toHaveBeenCalledTimes(1); expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.request).toHaveBeenCalledTimes(2);
    expect(m.finish).toHaveBeenCalledTimes(1);
  });
  it("successful PO HTTP with failed readback remains a partial terminal pair, not success", async () => {
    m.readback.mockImplementation(async kind => kind === "main" ? mainReadback() : { ...f.plan.expectedPo, PurchaseOrderID: "po-id", Status: "AUTHORISED" });
    expect(await executeWarrantyPair(f.reservation, f.plan, 7)).toMatchObject({ ok: false, status: "reconciliation_required" });
    expect(m.receipt.mock.calls[1][2]).toMatchObject({ httpStatus: 200, xeroDocumentId: "po-id", readbackVerified: false });
    expect(m.finish.mock.calls[0][1]).toBe("reconciliation_required");
    expect(m.post).toHaveBeenCalledTimes(1);
  });
});
