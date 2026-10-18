import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  original: vi.fn(), policy: vi.fn(), preview: vi.fn(), reserve: vi.fn(), bind: vi.fn(), complete: vi.fn(), hold: vi.fn(), writer: vi.fn(),
}));
vi.mock("./financialFinalWeightAdjustmentDb", () => ({ getFinalWeightEvent: m.original }));
vi.mock("./financialFinalWeightAdjustmentRelease", async original => ({ ...(await original<any>()), getFinalWeightReleasePolicy: m.policy }));
vi.mock("./financialFinalWeightAdjustmentService", () => ({ previewFinalWeightAdjustment: m.preview }));
vi.mock("./financialFinalWeightReconciliationDb", () => ({ reserveFinalWeightReconciliation: m.reserve, bindFinalWeightReconciliationPayload: m.bind, completeFinalWeightReconciliation: m.complete, holdFinalWeightReconciliation: m.hold }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.writer }));
import { applyApprovedFinalWeightReconciliation, previewFinalWeightReconciliation } from "./financialFinalWeightReconciliationService";
import { facts, policy, xero } from "./_test/finalWeightFixtures";
import { buildFinalWeightAdjustment, FINAL_WEIGHT_RULES_VERSION, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON } from "./financialFinalWeightReconciliationOrigin";

const originalEvent = (patch: Record<string, unknown> = {}) => ({
  id: 22, status: "reconciliation_required", holdReason: "Request failed with status code 404", executionId: 31,
  direction: "overweight", dealId: "5x77", dealNumber: "D702877", invoiceNumber: "INV-702877", xeroInvoiceId: "invoice-exact",
  originalDraftHash: "old", expectedDraftHash: "expected", ...patch,
});
function currentPreview() {
  const built = buildFinalWeightAdjustment(facts(), "overweight", xero());
  return { facts: facts(), direction: "overweight", preview: built, xero: xero(), sourceSnapshotHash: "source-hash", rulesSnapshotHash: "rule-hash", xeroPreflightHash: "xero-hash", state: "previewed", holdReason: null, noWrites: true };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true");
  vi.stubEnv("FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED", "true");
  m.original.mockResolvedValue(originalEvent());
  m.policy.mockResolvedValue(policy());
  m.preview.mockResolvedValue(currentPreview());
  m.reserve.mockResolvedValue({ state: "reserved", event: { id: 44 } });
  m.writer.mockResolvedValue({ outcome: "succeeded", executionId: 55, result: { documentNumber: "INV-702877", xeroDocumentId: "invoice-exact", status: "DRAFT" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("Final Weight legacy 404 reconciliation", () => {
  it("keeps the existing 404-with-execution recovery eligible, GET-only and immutable", async () => {
    const preview = await previewFinalWeightReconciliation(22);
    expect(preview).toMatchObject({ originalEventId: 22, invoiceNumber: "INV-702877", noWrites: true, payload: { method: "POST", endpoint: "/Invoices/invoice-exact" } });
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });
  it.each([
    { status: "draft_updated" }, { holdReason: "Request failed with status code 500" }, { xeroInvoiceId: null }, { executionId: null },
    { holdReason: FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON, executionId: 31 },
    { holdReason: `${FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON}; arbitrary extra prose`, executionId: null },
    { holdReason: "An operator put this event on reconciliation hold", executionId: null },
  ])("refuses arbitrary or non-eligible original reconciliation holds %#", async patch => {
    m.original.mockResolvedValue(originalEvent(patch));
    await expect(previewFinalWeightReconciliation(22)).rejects.toThrow(/Only an immutable Final Weight 404 or exact Xero-drift/);
    expect(m.preview).not.toHaveBeenCalled();
  });
  it("allows only the exact no-execution Xero-drift class and records current rules evidence", async () => {
    m.original.mockResolvedValue(originalEvent({ holdReason: FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON, executionId: null }));
    const preview = await previewFinalWeightReconciliation(22);
    expect(m.preview).toHaveBeenCalledWith("5x77", "overweight");
    expect(preview).toMatchObject({ originalEventId: 22, invoiceNumber: "INV-702877", xeroInvoiceId: "invoice-exact", noWrites: true,
      evidence: { sourceSnapshot: expect.objectContaining({ direction: "overweight", rulesVersion: FINAL_WEIGHT_RULES_VERSION }) } });
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });
  it.each([
    () => ({ ...currentPreview(), state: "held" }),
    () => ({ ...currentPreview(), preview: { ...currentPreview().preview, eligible: false } }),
    () => ({ ...currentPreview(), preview: { ...currentPreview().preview, invoiceId: "other-invoice" } }),
  ])("refuses a drift recovery unless the fresh current preview is previewed, eligible and the same invoice %#", async current => {
    m.original.mockResolvedValue(originalEvent({ holdReason: FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON, executionId: null }));
    m.preview.mockResolvedValue(current());
    await expect(previewFinalWeightReconciliation(22)).rejects.toThrow(/Current Final Weight source\/Xero Draft is not eligible for exact recovery/);
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });
  it("refuses to apply while the separate recovery gate is off", async () => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED", "");
    await expect(applyApprovedFinalWeightReconciliation(22)).rejects.toThrow(/disabled/);
    expect(m.preview).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled();
  });
  it("binds one fresh POST payload and completes only after exact writer success", async () => {
    const result = await applyApprovedFinalWeightReconciliation(22);
    expect(result).toMatchObject({ ok: true, eventId: 44, executionId: 55, documentNumber: "INV-702877" });
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({ originalEventId: 22, dealId: "5x77", xeroInvoiceId: "invoice-exact" }));
    expect(m.bind).toHaveBeenCalledWith(44, expect.any(String), policy().releaseKey, expect.objectContaining({ method: "POST", endpoint: "/Invoices/invoice-exact" }));
    expect(m.writer).toHaveBeenCalledWith(expect.objectContaining({ workflowType: "final_weight_reconciliation", expectedFinalWeightDraft: currentPreview().preview.expectedDraft, authorisation: expect.objectContaining({ finalWeightReconciliationEventId: 44 }) }));
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ eventId: 44, executionId: 55 }));
  });
  it("keeps a new recovery receipt for reconciliation when writer evidence is uncertain", async () => {
    m.writer.mockResolvedValue({ outcome: "reconciliation_required", executionId: 55, error: "readback unavailable" });
    const result = await applyApprovedFinalWeightReconciliation(22);
    expect(result).toMatchObject({ ok: false, status: "reconciliation_required", eventId: 44 });
    expect(m.hold).toHaveBeenCalledWith(44, expect.any(String), expect.stringMatching(/requires reconciliation/));
    expect(m.complete).not.toHaveBeenCalled();
  });
});
