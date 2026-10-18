import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  original: vi.fn(), prior: vi.fn(), policy: vi.fn(), preview: vi.fn(), reserve: vi.fn(), bind: vi.fn(), complete: vi.fn(), hold: vi.fn(), writer: vi.fn(),
}));
vi.mock("./financialFinalWeightAdjustmentDb", () => ({ getFinalWeightEvent: m.original }));
vi.mock("./financialFinalWeightReconciliationDb", () => ({ getFinalWeightReconciliationEvent: m.prior }));
vi.mock("./financialFinalWeightAdjustmentRelease", async original => ({ ...(await original<any>()), getFinalWeightReleasePolicy: m.policy }));
vi.mock("./financialFinalWeightReconciliationService", () => ({ previewFinalWeightReconciliation: m.preview }));
vi.mock("./financialFinalWeightReconciliationRemediationDb", () => ({
  isEligibleFinalWeightReconciliationVerifierDefectReceipt: (value: unknown) => Boolean(value && (value as any).status === "reconciliation_required" &&
    (value as any).holdReason === "Final Weight reconciliation Xero evidence changed." && (value as any).executionId === null && (value as any).submittedAt === null && (value as any).processingToken === null && (value as any).authorisedPayload),
  reserveFinalWeightReconciliationRemediation: m.reserve,
  bindFinalWeightReconciliationRemediationPayload: m.bind,
  completeFinalWeightReconciliationRemediation: m.complete,
  holdFinalWeightReconciliationRemediation: m.hold,
  getFinalWeightReconciliationRemediationEvent: vi.fn(),
}));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.writer }));

import {
  applyCallerApprovedFinalWeightReconciliationVerifierDefectRemediation,
  previewFinalWeightReconciliationVerifierDefectRemediation,
} from "./financialFinalWeightReconciliationRemediationService";
import { FINAL_WEIGHT_RECONCILIATION_VERIFIER_DEFECT_HOLD_REASON, FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON } from "./financialFinalWeightReconciliationOrigin";
import { policy } from "./_test/finalWeightFixtures";

const payload = {
  endpoint: "/Invoices/invoice-exact" as const,
  method: "POST" as const,
  documentFamily: "customer_invoice" as const,
  documentNumber: "INV-702941",
  expectedXeroDocumentId: "invoice-exact",
  idempotencyKey: "a".repeat(64),
  body: { Invoices: [{ InvoiceID: "invoice-exact", InvoiceNumber: "INV-702941", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Contact: { ContactID: "customer-exact" }, Date: "2026-10-11", DueDate: "2026-10-15", LineItems: [{ Description: "Exact", Quantity: 1, UnitAmount: 1, AccountCode: "200", TaxType: "OUTPUT" }] }] },
};
const original = (patch: Record<string, unknown> = {}) => ({
  id: 660001, status: "reconciliation_required", holdReason: FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON, executionId: null,
  direction: "overweight", dealId: "5x941", dealNumber: "D702941", invoiceNumber: "INV-702941", xeroInvoiceId: "invoice-exact",
  originalDraftHash: "old", expectedDraftHash: "expected", ...patch,
});
const prior = (patch: Record<string, unknown> = {}) => ({
  id: 1, originalEventId: 660001, status: "reconciliation_required", holdReason: FINAL_WEIGHT_RECONCILIATION_VERIFIER_DEFECT_HOLD_REASON,
  executionId: null, submittedAt: null, processingToken: null, authorisedPayload: { hash: "old-payload", payload },
  direction: "overweight", dealId: "5x941", dealNumber: "D702941", invoiceNumber: "INV-702941", xeroInvoiceId: "invoice-exact", ...patch,
});
const freshPreview = () => ({
  originalEventId: 660001, direction: "overweight" as const, dealId: "5x941", dealNumber: "D702941", invoiceNumber: "INV-702941", xeroInvoiceId: "invoice-exact",
  expectedDraft: payload.body.Invoices[0], payload,
  evidence: { originalEventId: 660001, direction: "overweight" as const, dealId: "5x941", dealNumber: "D702941", invoiceNumber: "INV-702941", xeroInvoiceId: "invoice-exact", originalEventHash: "original", sourceSnapshotHash: "source", xeroPreflightHash: "xero", sourceSnapshot: {}, xeroPreflight: {}, originalDraft: {}, expectedDraft: payload.body.Invoices[0], originalDraftHash: "old", expectedDraftHash: "expected" },
  noWrites: true as const,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true");
  vi.stubEnv("FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED", "true");
  m.original.mockResolvedValue(original()); m.prior.mockResolvedValue(prior()); m.policy.mockResolvedValue(policy()); m.preview.mockResolvedValue(freshPreview());
  m.reserve.mockResolvedValue({ state: "reserved", event: { id: 72 } });
  m.writer.mockResolvedValue({ outcome: "succeeded", executionId: 73, result: { documentNumber: "INV-702941", xeroDocumentId: "invoice-exact", status: "DRAFT" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("D702941 Final Weight verifier-defect remediation", () => {
  it("keeps the D702941 held receipt immutable and preview-only before explicit approval", async () => {
    const result = await previewFinalWeightReconciliationVerifierDefectRemediation(1);
    expect(result).toMatchObject({ priorReconciliationReceiptId: 1, originalEventId: 660001, invoiceNumber: "INV-702941", noWrites: true });
    expect(m.preview).toHaveBeenCalledWith(660001);
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.bind).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });

  it.each([
    { holdReason: "arbitrary reconciliation hold" }, { holdReason: `${FINAL_WEIGHT_RECONCILIATION_VERIFIER_DEFECT_HOLD_REASON} extra` },
    { submittedAt: new Date() }, { executionId: 50 }, { processingToken: "in-progress" }, { authorisedPayload: null },
  ])("rejects arbitrary, submitted, or executed receipt %# before a fresh preview", async patch => {
    m.prior.mockResolvedValue(prior(patch));
    await expect(previewFinalWeightReconciliationVerifierDefectRemediation(1)).rejects.toThrow(/exact unsubmitted/);
    expect(m.preview).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });

  it.each([
    () => original({ holdReason: "Request failed with status code 404", executionId: 55 }),
    () => original({ holdReason: FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON, executionId: 33 }),
    () => original({ invoiceNumber: "INV-OTHER" }),
  ])("requires the matching no-execution Xero-drift original and same invoice %#", async value => {
    m.original.mockResolvedValue(value());
    await expect(previewFinalWeightReconciliationVerifierDefectRemediation(1)).rejects.toThrow(/matching immutable no-execution/);
    expect(m.preview).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });

  it("rejects a fresh source/Xero preview that points to another invoice without writer access", async () => {
    m.preview.mockResolvedValue({ ...freshPreview(), xeroInvoiceId: "other-invoice" });
    await expect(previewFinalWeightReconciliationVerifierDefectRemediation(1)).rejects.toThrow(/exact immutable invoice/);
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });

  it("requires its default-off gate and caller approval before any preview, receipt reservation, or writer", async () => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED", "");
    await expect(applyCallerApprovedFinalWeightReconciliationVerifierDefectRemediation(1, policy().releaseKey)).rejects.toThrow(/disabled/);
    expect(m.preview).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED", "true");
    await expect(applyCallerApprovedFinalWeightReconciliationVerifierDefectRemediation(1, "wrong"))
      .rejects.toThrow(/explicit caller approval/);
    expect(m.preview).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });

  it("binds a distinct remediation receipt and only one exact-resource POST/readback after caller approval", async () => {
    const result = await applyCallerApprovedFinalWeightReconciliationVerifierDefectRemediation(1, policy().releaseKey);
    expect(result).toMatchObject({ ok: true, eventId: 72, executionId: 73, documentNumber: "INV-702941" });
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({ priorReceipt: expect.objectContaining({ id: 1, executionId: null, submittedAt: null }), evidence: expect.objectContaining({ originalEventId: 660001, xeroInvoiceId: "invoice-exact" }) }));
    expect(m.bind).toHaveBeenCalledWith(72, expect.any(String), policy().releaseKey, expect.objectContaining({ method: "POST", endpoint: "/Invoices/invoice-exact" }));
    expect(m.writer).toHaveBeenCalledWith(expect.objectContaining({ workflowType: "final_weight_reconciliation_remediation", authorisation: expect.objectContaining({ finalWeightReconciliationRemediationEventId: 72 }) }));
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ eventId: 72, executionId: 73 }));
  });

  it("does not reopen or retry a prior remediation receipt", async () => {
    m.reserve.mockResolvedValue({ state: "blocked", event: { id: 72, status: "reconciliation_required" } });
    await expect(applyCallerApprovedFinalWeightReconciliationVerifierDefectRemediation(1, policy().releaseKey)).resolves.toMatchObject({ ok: false, status: "blocked", eventId: 72 });
    expect(m.bind).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });
});
