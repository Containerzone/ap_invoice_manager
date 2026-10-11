import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: vi.fn(), rows: [] as any[], select: vi.fn(), insert: vi.fn(), update: vi.fn(), values: vi.fn(), duplicate: vi.fn(), set: vi.fn(), where: vi.fn(), source: vi.fn(), xero: vi.fn(), policy: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialFinalWeightAdjustmentSource", () => ({ readFinalWeightFacts: m.source }));
vi.mock("./financialReadOnlyXeroService", () => ({ readFinalWeightXeroEvidence: m.xero }));
vi.mock("./financialFinalWeightAdjustmentRelease", async original => ({ ...(await original<any>()), getFinalWeightReleasePolicy: m.policy }));
import { assertFinalWeightLedgerIntegrity, bindFinalWeightPayload, claimFinalWeightEvent, consumeFinalWeightPayload, holdFinalWeightEvent, recordFinalWeightEvidence, verifyFinalWeightAutomaticWriteAccess } from "./financialFinalWeightAdjustmentDb";
import { buildFinalWeightAdjustment, FINAL_WEIGHT_RULES_HASH, FINAL_WEIGHT_RULES_VERSION, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { facts, policy, xero } from "./_test/finalWeightFixtures";
function evidence() {
  const source = facts(); const currentXero = xero(); const preview = buildFinalWeightAdjustment(source, "overweight", currentXero);
  const sourceHash = sourceSnapshotHash({ ...source, direction: "overweight", rulesVersion: FINAL_WEIGHT_RULES_VERSION });
  const payload = prepareFinalWeightPayload(preview, sourceHash);
  const event: any = { id: 5, direction: "overweight", dealId: source.dealId, dealNumber: source.dealNumber, invoiceNumber: preview.invoiceNumber, xeroInvoiceId: preview.invoiceId,
    sourceSnapshot: source, sourceSnapshotHash: sourceHash, rulesSnapshotHash: FINAL_WEIGHT_RULES_HASH, xeroPreflight: currentXero, xeroPreflightHash: financialSha256(currentXero),
    originalDraft: preview.originalDraft, expectedDraft: preview.expectedDraft, originalDraftHash: financialSha256(preview.originalDraft), expectedDraftHash: financialSha256(preview.expectedDraft),
    claimedDealId: source.dealId, claimedInvoiceId: preview.invoiceId, claimedInvoiceNumber: preview.invoiceNumber, releaseKey: policy().releaseKey, authorisedPayload: { hash: financialSha256(payload), payload }, status: "reserved", processingToken: "token" };
  return { event, payload, input: { eventId: 5, direction: "overweight" as const, releaseKey: policy().releaseKey, preparedBy: 7, payload }, source, currentXero, preview, sourceHash };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); m.rows = [evidence().event];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }));
  m.insert.mockImplementation(() => ({ values: m.values })); m.values.mockImplementation(() => ({ onDuplicateKeyUpdate: m.duplicate })); m.duplicate.mockResolvedValue(undefined);
  m.update.mockImplementation(() => ({ set: m.set })); m.set.mockImplementation(() => ({ where: m.where })); m.where.mockResolvedValue([{ affectedRows: 1 }]);
  m.db.mockResolvedValue({ select: m.select, insert: m.insert, update: m.update });
  m.source.mockResolvedValue(facts()); m.xero.mockResolvedValue(xero()); m.policy.mockResolvedValue(policy());
});
afterEach(() => vi.unstubAllEnvs());
describe("Final-weight immutable evidence ledger and one-time claims", () => {
  it("accepts intact exact ledger evidence and revalidates current source/full Xero before transport", async () => {
    const current = evidence(); expect(() => assertFinalWeightLedgerIntegrity(current.event, current.input, policy())).not.toThrow();
    await verifyFinalWeightAutomaticWriteAccess(current.input);
    expect(m.source).toHaveBeenCalledWith("5x77", "overweight"); expect(m.xero).toHaveBeenCalledWith("INV-702877", "Synthetic Customer", "overweight"); expect(m.update).not.toHaveBeenCalled();
  });
  it.each(["direction", "status", "claimedDealId", "claimedInvoiceId", "claimedInvoiceNumber", "rulesSnapshotHash", "sourceSnapshotHash", "xeroPreflightHash", "originalDraftHash", "expectedDraftHash", "releaseKey", "processingToken"])("rejects tampered %s immutable reservation", key => {
    const current = evidence(); current.event[key] = key === "processingToken" ? null : "wrong";
    expect(() => assertFinalWeightLedgerIntegrity(current.event, current.input, policy())).toThrow(/immutable/);
  });
  it("rejects forged authorised payload/source and wrong approver", () => {
    const current = evidence(); current.event.authorisedPayload.payload.body.Invoices[0].DueDate = "2027-01-01";
    expect(() => assertFinalWeightLedgerIntegrity(current.event, current.input, policy())).toThrow();
    const other = evidence(); expect(() => assertFinalWeightLedgerIntegrity(other.event, { ...other.input, preparedBy: 8 }, policy())).toThrow();
    other.event.sourceSnapshot.actualWeight = 99; expect(() => assertFinalWeightLedgerIntegrity(other.event, other.input, policy())).toThrow();
  });
  it("rejects current source change and exact current Xero line/contact/status changes", async () => {
    m.source.mockResolvedValue(facts({ actualWeight: 99 })); await expect(verifyFinalWeightAutomaticWriteAccess(evidence().input)).rejects.toThrow(/changed/);
    m.source.mockResolvedValue(facts()); m.xero.mockResolvedValue(xero({ invoice: { ...xero().invoice, Status: "AUTHORISED" } }));
    await expect(verifyFinalWeightAutomaticWriteAccess(evidence().input)).rejects.toThrow(/changed since reservation/);
  });
  it("only inserts immutable factual columns; duplicate receipt update is solely evidence-key no-op", async () => {
    const current = evidence(); await recordFinalWeightEvidence({ facts: current.source, direction: "overweight", preview: current.preview, xero: current.currentXero, sourceSnapshotHash: current.sourceHash, xeroPreflightHash: financialSha256(current.currentXero), holdReason: null });
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ originalDraft: current.preview.originalDraft, expectedDraft: current.preview.expectedDraft, direction: "overweight" }));
    expect(Object.keys(m.duplicate.mock.calls[0]![0].set)).toEqual(["evidenceKey"]); expect(m.update).not.toHaveBeenCalled();
  });
  it("reserves same deal/id/number claim for both branches and holds duplicate-key collision", async () => {
    const current = evidence(); m.rows = [{ ...current.event, status: "previewed", processingToken: null, claimedInvoiceId: null }];
    expect(await claimFinalWeightEvent(5, "token", current.sourceHash, current.event.xeroPreflightHash)).toBe(true);
    expect(m.set).toHaveBeenCalledWith(expect.objectContaining({ claimedDealId: "5x77", claimedInvoiceId: "invoice-exact", claimedInvoiceNumber: "INV-702877", status: "reserved" }));
    m.where.mockRejectedValue({ code: "ER_DUP_ENTRY" }); expect(await claimFinalWeightEvent(5, "token", current.sourceHash, current.event.xeroPreflightHash)).toBe(false);
  });
  it("binds once only and consumption rejects stale/already submitted CAS", async () => {
    await bindFinalWeightPayload(5, "token", policy().releaseKey, evidence().payload);
    expect(m.set).toHaveBeenCalledWith(expect.objectContaining({ authorisedPayload: { hash: financialSha256(evidence().payload), payload: evidence().payload } }));
    m.where.mockResolvedValue([{ affectedRows: 0 }]); await expect(bindFinalWeightPayload(5, "token", policy().releaseKey, evidence().payload)).rejects.toThrow(/once/);
    await expect(consumeFinalWeightPayload(evidence().input, 9)).rejects.toThrow(/already consumed/);
  });
  it("consumes immediately once into submitted and retains claims/payload on reconciliation hold", async () => {
    await consumeFinalWeightPayload(evidence().input, 9); expect(m.set).toHaveBeenCalledWith(expect.objectContaining({ status: "submitted", executionId: 9 }));
    await holdFinalWeightEvent(5, "token", "Uncertain transport");
    const hold = m.set.mock.calls.at(-1)![0]; expect(hold).toMatchObject({ status: "reconciliation_required", processingToken: null });
    expect(hold.claimedInvoiceId).toBeUndefined(); expect(hold.authorisedPayload).toBeUndefined(); expect(hold.originalDraft).toBeUndefined(); expect(hold.expectedDraft).toBeUndefined();
  });
});
