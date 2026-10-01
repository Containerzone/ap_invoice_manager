import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInitialStorageDrafts, type StorageDeal } from "./financialStorageDrafts";
vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: vi.fn() }));
vi.mock("./financialInitialStorageDb", () => ({ reserveInitialStorageEvent: vi.fn(), previewInitialStorageReservation: vi.fn().mockResolvedValue({ suffix: "A", existing: null }), claimInitialStorageEvent: vi.fn(), storedStorageReceipts: (event: any) => event.documentResults ?? [], updateInitialStorageEvent: vi.fn() }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: vi.fn(), readBackFinancialDraft: vi.fn(), verifyInitialStorageXeroAccounts: vi.fn() }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: vi.fn() }));
vi.mock("./financialWorkflowDb", () => ({ createFinancialPostSuccessAction: vi.fn() }));
vi.mock("./vtigerFinancialWriteService", () => ({ isFinancialPostSuccessVtigerWriteEnabled: vi.fn().mockReturnValue(false), runFinancialPostSuccessAction: vi.fn() }));

const source = { id: "5x123", potential_no: "D123", sales_stage: "4 STORAGE at ORIGIN", cf_potentials_storagerequired: "Yes at Origin", potentialname: "CONT-1234",
  cf_potentials_containertype: "20 Foot Standard", cf_potentials_datein: "2026-08-10", cf_potentials_fullcontainerdeliverydate: "", related_to: "3x10",
  contact_id: "4x20", cf_potentials_contractorc2: "6x30", cf_potentials_fullcontainerdeliveryv: "6x40" };
const deal: StorageDeal = { dealId: "5x123", dealNumber: "D123", location: "origin", containerNumber: "CONT-1234", containerType: "20 Foot Standard", dateIn: "2026-08-10", deliveryDate: null,
  customer: { name: "Business", vtigerId: "3x10", email: null }, driver: { name: "Driver", vtigerId: "6x30", email: null },
  storageSupplier: { name: "Containerzone", vtigerId: "xero-contact", email: null } };
const createEvent = () => ({ id: 17, dealId: "5x123", dealNumber: "D123", location: "origin", periodStart: "2026-08-10", periodEnd: "2026-08-31", suffix: "A", sourceHash: "", status: "held", pilotApprovalKey: null,
  approvedDocumentsHash: null, approvedPreflightHash: null, approvalExpiresAt: null, approvedBy: null, legacyHandoffConfirmedAt: null, documentResults: [] as any[] });
let event = createEvent();
let preflight: any[] = [];

async function setup() {
  const vtiger = await import("./vtigerFinancialReadService");
  vi.mocked(vtiger.retrieveCurrentVtigerFinancialRecord).mockImplementation(async (id) => id === "5x123" ? source :
    id === "3x10" ? { id, accountname: "Business", email1: "billing@example.test" } : { id, vendorname: "Driver", email: "driver@example.test" });
  const db = await import("./financialInitialStorageDb");
  vi.mocked(db.reserveInitialStorageEvent).mockImplementation(async (input) => { event.sourceHash = (input as any).sourceHash; return { event: event as any, existing: false }; });
  vi.mocked(db.claimInitialStorageEvent).mockResolvedValue(true);
  vi.mocked(db.updateInitialStorageEvent).mockImplementation(async (input) => { event.status = input.status as any; if (input.receipts) event.documentResults = [...input.receipts]; });
  const xero = await import("./financialReadOnlyXeroService");
  vi.mocked(xero.preflightFinancialXeroIntents).mockImplementation(async () => preflight);
  vi.mocked(xero.readBackFinancialDraft).mockResolvedValue({ status: "DRAFT" } as any);
}

async function armTestEvent() {
  const { storageDocumentsHash, storagePreflightHash } = await import("./financialInitialStorageService");
  const { documents } = buildInitialStorageDrafts(deal, "A", true);
  event.approvedDocumentsHash = storageDocumentsHash(documents);
  const live = structuredClone(documents);
  live[1]!.lineItems[0]!.description = "Exact Xero JD description";
  for (let i = 0; i < 3; i++) live[i]!.partySourceId = `xero-contact-${i}`;
  event.approvedPreflightHash = storagePreflightHash(preflight as any, live);
  event.pilotApprovalKey = "exact-approved-pilot";
  event.approvedBy = 1;
  event.approvalExpiresAt = new Date(Date.now() + 10 * 60_000);
  event.legacyHandoffConfirmedAt = new Date();
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "false");
  vi.stubEnv("FINANCIAL_GLOBAL_SHADOW_MODE", "true");
  vi.stubEnv("FINANCIAL_INITIAL_STORAGE_ENABLED", "false");
  event = createEvent();
  preflight = ["INV-123-A", "JD123", "GD123"].map((number, i) => ({ documentNumber: number, duplicateState: "not_found", contactCheck: { found: true, contactId: `xero-contact-${i}` }, itemChecks: i === 1 ? [{ itemCode: "JD 20", found: true, nativeDescription: "Exact Xero JD description" }] : [] }));
  await setup();
});
afterEach(() => vi.unstubAllEnvs());

describe("narrow loaded storage event coordinator", () => {
  it("previews the exact three documents with fresh VTiger/Xero GETs and no reservation or write", async () => {
    const { previewInitialLoadedStorage } = await import("./financialInitialStorageService");
    const result = await previewInitialLoadedStorage("5x123");
    expect(result).toMatchObject({ dealNumber: "D123", location: "origin", suffix: "A", eligibleForApproval: true,
      documents: [{ number: "INV-123-A", accountCode: "200", xeroNumberState: "not_found" },
        { number: "JD123", accountCode: "310", itemCode: "JD 20" },
        { number: "GD123", accountCode: "311" }] });
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await import("./financialInitialStorageDb")).reserveInitialStorageEvent).not.toHaveBeenCalled();
    expect((await import("./financialInitialStorageDb")).updateInitialStorageEvent).not.toHaveBeenCalled();
    expect((await import("./financialWriterExecutionService")).executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
  it("holds a pre-existing invoice and PO in preview even when a deleted invoice number could be reused manually", async () => {
    preflight[0].duplicateState = "ambiguous"; preflight[0].status = "DELETED";
    preflight[1].duplicateState = "found"; preflight[1].status = "DRAFT";
    const result = await (await import("./financialInitialStorageService")).previewInitialLoadedStorage("5x123");
    expect(result).toMatchObject({ eligibleForApproval: false, reasons: expect.arrayContaining([
      expect.stringContaining("INV-123-A"), expect.stringContaining("JD123") ]) });
    expect((await import("./financialInitialStorageDb")).reserveInitialStorageEvent).not.toHaveBeenCalled();
    expect((await import("./financialWriterExecutionService")).executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
  it("holds a future Sydney Date In before local reservation or Xero preflight", async () => {
    const { retrieveCurrentVtigerFinancialRecord } = await import("./vtigerFinancialReadService");
    vi.mocked(retrieveCurrentVtigerFinancialRecord).mockResolvedValueOnce({ ...source, cf_potentials_datein: "2099-08-10" });
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: false, status: "held", warning: expect.stringContaining("future") });
    expect((await import("./financialInitialStorageDb")).reserveInitialStorageEvent).not.toHaveBeenCalled();
    expect((await import("./financialReadOnlyXeroService")).preflightFinancialXeroIntents).not.toHaveBeenCalled();
  });
  it("refreshes VTiger and holds before any Xero call when deployment is locked", async () => {
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    const xero = await import("./financialReadOnlyXeroService");
    const writer = await import("./financialWriterExecutionService");
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: false, status: "held", dealNumber: "D123" });
    expect(xero.preflightFinancialXeroIntents).not.toHaveBeenCalled();
    expect(writer.executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
  it("never allocates new suffixes or creates documents for a complete replay", async () => {
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    event.status = "drafts_created";
    event.documentResults = ["INV-123-A", "JD123", "GD123"].map((number) => ({ number, xeroId: number, status: "DRAFT" }));
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: true, status: "duplicate_replay", customerInvoice: "INV-123-A" });
    expect((await import("./financialWriterExecutionService")).executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
  it("creates exactly three guarded Drafts in order, persisting each receipt", async () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_GLOBAL_SHADOW_MODE", "false"); vi.stubEnv("FINANCIAL_INITIAL_STORAGE_ENABLED", "true");
    await armTestEvent();
    const writer = await import("./financialWriterExecutionService");
    let execution = 0;
    vi.mocked(writer.executeGuardedFinancialWriterCommand).mockImplementation(async ({ payload }: any) => ({ outcome: "succeeded", executionId: ++execution, result: { xeroDocumentId: `xero-${execution}`, documentNumber: payload.documentNumber, status: "DRAFT" } } as any));
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: true, status: "writeback_pending", customerInvoice: "INV-123-A", transportPurchaseOrder: "JD123", storagePurchaseOrder: "GD123" });
    expect(vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls.map(([command]) => command.payload.documentNumber)).toEqual(["INV-123-A", "JD123", "GD123"]);
    expect(vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls[1]?.[0].payload.body).toMatchObject({ PurchaseOrders: [{ Status: "DRAFT", CurrencyCode: "AUD", LineItems: [{ ItemCode: "JD 20", AccountCode: "310", Description: "Exact Xero JD description" }] }] });
    expect(vi.mocked((await import("./financialInitialStorageDb")).updateInitialStorageEvent).mock.calls.filter(([call]) => call.status === "reserved")).toHaveLength(3);
    expect((await import("./financialInitialStorageDb")).updateInitialStorageEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "drafts_created", receipts: expect.arrayContaining([expect.objectContaining({ number: "GD123" })]) }));
  });
  it("keeps all verified Draft receipts after VTiger note failure without replaying transport", async () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_GLOBAL_SHADOW_MODE", "false"); vi.stubEnv("FINANCIAL_INITIAL_STORAGE_ENABLED", "true");
    await armTestEvent();
    const writer = await import("./financialWriterExecutionService");
    vi.mocked(writer.executeGuardedFinancialWriterCommand).mockImplementation(async ({ payload }: any) => ({ outcome: "succeeded", executionId: 3,
      result: { xeroDocumentId: payload.documentNumber, documentNumber: payload.documentNumber, status: "DRAFT" } } as any));
    vi.mocked((await import("./financialWorkflowDb")).createFinancialPostSuccessAction).mockRejectedValueOnce(new Error("VTiger note unavailable"));
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: true, status: "writeback_pending" });
    expect(event.documentResults).toHaveLength(3);
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: true, status: "duplicate_replay" });
    expect(vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls).toHaveLength(3);
  });
  it("holds a collision and creates no Draft", async () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_GLOBAL_SHADOW_MODE", "false"); vi.stubEnv("FINANCIAL_INITIAL_STORAGE_ENABLED", "true");
    await armTestEvent(); preflight[0].duplicateState = "found"; preflight[0].status = "DELETED";
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: false, status: "failed" });
    expect((await import("./financialWriterExecutionService")).executeGuardedFinancialWriterCommand).not.toHaveBeenCalled();
  });
  it("a partial Xero failure persists the first readback; retry cannot blindly create it again", async () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_GLOBAL_SHADOW_MODE", "false"); vi.stubEnv("FINANCIAL_INITIAL_STORAGE_ENABLED", "true");
    await armTestEvent();
    const writer = await import("./financialWriterExecutionService");
    vi.mocked(writer.executeGuardedFinancialWriterCommand).mockResolvedValueOnce({ outcome: "succeeded", executionId: 1, result: { xeroDocumentId: "xero-1", documentNumber: "INV-123-A", status: "DRAFT" } } as any).mockRejectedValueOnce(new Error("Xero failed"));
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: false, status: "partial" });
    expect(event.documentResults).toHaveLength(1);
    preflight[0].duplicateState = "found";
    expect(await processInitialLoadedStorage("5x123")).toMatchObject({ ok: false, status: "partial" });
    expect(vi.mocked(writer.executeGuardedFinancialWriterCommand).mock.calls).toHaveLength(2);
  });
});
