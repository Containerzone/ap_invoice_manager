import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  original: vi.fn(),
  policy: vi.fn(),
  preview: vi.fn(),
  reserve: vi.fn(),
  bind: vi.fn(),
  complete: vi.fn(),
  hold: vi.fn(),
  writer: vi.fn(),
}));

vi.mock("./financialDepositInvoiceReconciliationDb", async original => ({
  ...(await original<any>()),
  getDepositInvoiceReconciliationOriginal: m.original,
  reserveDepositInvoiceReconciliation: m.reserve,
  bindDepositInvoiceReconciliationPayload: m.bind,
  completeDepositInvoiceReconciliation: m.complete,
  holdDepositInvoiceReconciliation: m.hold,
}));
vi.mock("./financialDepositInvoiceRelease", async original => ({
  ...(await original<any>()),
  getDepositInvoiceReleasePolicy: m.policy,
}));
vi.mock("./financialDepositInvoiceService", () => ({ previewDepositInvoice: m.preview }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.writer }));

import {
  applyApprovedDepositInvoiceReconciliation,
  previewDepositInvoiceReconciliation,
} from "./financialDepositInvoiceReconciliationService";
import { DEPOSIT_INVOICE_RULES_HASH } from "./financialDepositInvoiceDrafts";

const originalEvent = (patch: Record<string, unknown> = {}) => ({
  id: 180001,
  evidenceKey: "e".repeat(64),
  dealId: "5x2941",
  dealNumber: "D702941",
  proposedInvoiceNumber: "INV-702941-D",
  customerVtigerId: "4x2",
  customerName: "Scoped Customer Pty Ltd",
  sourceRefreshedAt: new Date("2025-12-01T00:00:00.000Z"),
  sourceSnapshotHash: "s".repeat(64),
  rulesSnapshotHash: DEPOSIT_INVOICE_RULES_HASH,
  xeroPreflightHash: "x".repeat(64),
  sourceSnapshot: { legacy: true },
  proposal: { legacy: true },
  xeroPreflight: { legacy: true },
  postconditionHold: "No Deposit-to-main deduction.",
  claimedDealId: "5x2941",
  claimedInvoiceNumber: "INV-702941-D",
  releaseKey: "legacy-release",
  authorisedPayload: { legacy: true },
  processingToken: null,
  status: "reconciliation_required",
  holdReason: "Legacy claim requires reconciliation.",
  executionId: null,
  xeroInvoiceId: null,
  ...patch,
});

const proposal = () => ({
  documentFamily: "customer_invoice" as const,
  documentType: "deposit_invoice",
  proposedAction: "create_draft" as const,
  proposedDocumentNumber: "INV-702941-D",
  reference: "D702941",
  partyName: "Scoped Customer Pty Ltd",
  partySourceId: "xero-customer",
  accountCode: "200",
  gstTreatment: "GST_INCLUSIVE" as const,
  currency: "AUD",
  subtotal: 110,
  taxAmount: 10,
  total: 110,
  issueDate: new Date("2026-10-18T00:00:00.000Z"),
  dueDate: null,
  lineItems: [{
    itemCode: "Deposit Required",
    description: "Deposit for Q1 from INV-702941",
    quantity: 1,
    unitAmount: 110,
    accountCode: "200",
    gstTreatment: "GST_INCLUSIVE" as const,
  }],
  sourceWorkflow: "deposit_invoice",
  sourceRecordId: "5x2941",
  validationStatus: "valid" as const,
});

function currentPreview(patch: Record<string, unknown> = {}) {
  const document = proposal();
  return {
    facts: { dealId: "5x2941", dealNumber: "D702941" },
    preview: { eligible: true, proposedInvoiceNumber: "INV-702941-D", document },
    preflight: { documentNumber: "INV-702941-D", duplicateState: "not_found" },
    sourceSnapshotHash: "c".repeat(64),
    xeroPreflightHash: "p".repeat(64),
    state: "previewed",
    holdReason: null,
    noWrites: true,
    ...patch,
  };
}

const policy = () => ({
  releaseKey: "DEPOSIT-test",
  rulesHash: DEPOSIT_INVOICE_RULES_HASH,
  enabled: true,
  approvedBy: 7,
  approvedAt: "2026-01-01T00:00:00Z",
  effectiveFrom: "2026-01-01T00:00:00Z",
  depositOnlyVtigerBranch: true,
  operationsDepositHandoff: true,
  sourceMappingsConfirmed: true,
  isolatedDraftOnlyApproved: true,
  migrationScope: "new_events_only" as const,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_RECONCILIATION_ENABLED", "true");
  vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "false");
  m.original.mockResolvedValue(originalEvent());
  m.policy.mockResolvedValue(policy());
  m.preview.mockResolvedValue(currentPreview());
  m.reserve.mockResolvedValue({ state: "reserved", event: { id: 88 } });
  m.writer.mockResolvedValue({
    outcome: "succeeded",
    executionId: 99,
    result: { documentNumber: "INV-702941-D", xeroDocumentId: "deposit-xero", status: "DRAFT" },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("scoped Deposit immutable-claim reconciliation", () => {
  it("is a GET-only preview for the named legacy receipt and does not invoke generic claim/write paths", async () => {
    const result = await previewDepositInvoiceReconciliation(180001);
    expect(result).toMatchObject({
      originalEventId: 180001,
      dealNumber: "D702941",
      invoiceNumber: "INV-702941-D",
      noWrites: true,
      payload: { method: "POST", endpoint: "/Invoices", expectedXeroDocumentId: null },
    });
    expect(m.preview).toHaveBeenCalledWith("5x2941", "D702941");
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });

  it.each([
    { id: 180002 },
    { status: "held" },
    { executionId: 2 },
    { xeroInvoiceId: "legacy-xero" },
    { dealNumber: "D702942" },
    { proposedInvoiceNumber: "INV-702942-D" },
  ])("rejects an ineligible immutable original %#", async patch => {
    m.original.mockResolvedValue(originalEvent(patch));
    await expect(previewDepositInvoiceReconciliation(180001)).rejects.toThrow(/Only the immutable scoped Deposit/);
    expect(m.preview).not.toHaveBeenCalled();
  });

  it("rejects a changed/held current exact source or preflight before reserving", async () => {
    m.preview.mockResolvedValue(currentPreview({ state: "held", holdReason: "Existing Xero invoice" }));
    await expect(previewDepositInvoiceReconciliation(180001)).rejects.toThrow(/not eligible/);
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });

  it("requires its separate recovery gate before even reading source or creating a reservation", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_RECONCILIATION_ENABLED", "false");
    await expect(applyApprovedDepositInvoiceReconciliation(180001)).rejects.toThrow(/disabled/);
    expect(m.original).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
  });

  it("binds a fresh independent receipt and creates only the exact new Deposit Draft without any deduction plan", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    const result = await applyApprovedDepositInvoiceReconciliation(180001);
    expect(result).toMatchObject({ ok: true, status: "drafts_created", eventId: 88, executionId: 99 });
    expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({
      originalEventId: 180001,
      dealNumber: "D702941",
      invoiceNumber: "INV-702941-D",
    }));
    expect(m.bind).toHaveBeenCalledWith(88, expect.any(String), "DEPOSIT-test", expect.objectContaining({
      method: "POST", endpoint: "/Invoices", documentNumber: "INV-702941-D",
    }));
    expect(m.writer).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "deposit_invoice_reconciliation",
      proposedAction: "create_draft",
      authorisation: expect.objectContaining({ depositInvoiceReconciliationEventId: 88 }),
    }));
    expect(m.writer.mock.calls[0]![0].postSuccessPlan).toBeUndefined();
    expect(m.complete).toHaveBeenCalledWith(expect.objectContaining({ eventId: 88, executionId: 99 }));
  });
});
