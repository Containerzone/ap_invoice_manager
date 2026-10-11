import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initial: vi.fn(), recurring: vi.fn(),
  getPolicy: vi.fn(), assertPolicy: vi.fn(),
  getEvent: vi.fn(), claim: vi.fn(), bind: vi.fn(), complete: vi.fn(), due: vi.fn(), latest: vi.fn(), hold: vi.fn(), clearDue: vi.fn(),
  execute: vi.fn(), report: vi.fn(),
}));

vi.mock("./financialForHireService", () => ({ previewInitialForHirePo: mocks.initial, previewRecurringForHirePo: mocks.recurring }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: mocks.getPolicy, assertForHireRelease: mocks.assertPolicy }));
vi.mock("./financialForHireDb", () => ({
  bindForHirePayload: mocks.bind, claimForHirePreview: mocks.claim, clearForHireNextBillingDate: mocks.clearDue,
  completeForHireDraft: mocks.complete, dueForHireRecurringRoots: mocks.due, getForHireEventForPeriod: mocks.getEvent,
  holdForHireExecution: mocks.hold, latestVerifiedForHireEvent: mocks.latest,
}));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: mocks.execute }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: mocks.report }));

import { processAutomaticInitialForHire, processAutomaticRecurringForHire, runAutomaticRecurringForHire } from "./financialForHireLiveService";

const policy = { releaseKey: "FOR-HIRE-UNIT-TEST", approvedBy: 9 };
const document = {
  documentFamily: "purchase_order", documentType: "initial_for_hire", proposedAction: "create_draft", proposedDocumentNumber: "HC1860",
  reference: "C1860", partyName: "Hire Supplier", partySourceId: "contact-hire", accountCode: "312", gstTreatment: "GST_EXCLUSIVE",
  currency: "AUD", subtotal: 120, taxAmount: 12, total: 132, issueDate: new Date("2026-10-01T00:00:00.000Z"), dueDate: null,
  lineItems: [{ itemCode: "HC 20", description: "20' Container Hire from 01/10/26 to 31/10/26", quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "312", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
  sourceWorkflow: "container_control_acquisition", sourceRecordId: "24x901", validationStatus: "valid",
} as any;
const preview = (kind: "initial" | "recurring" = "initial") => ({
  kind, state: "previewed", holdReason: null, noWrites: true, sourceSnapshotHash: "s".repeat(64), rulesSnapshotHash: "r".repeat(64), xeroPreflightHash: "p".repeat(64),
  facts: { recordId: "24x901" }, lifecycle: [], preflight: {}, preview: { periodStart: "2026-10-01", periodEnd: "2026-10-31", proposedPoNumber: "HC1860", document: { ...document, documentType: kind === "initial" ? "initial_for_hire" : "recurring_for_hire", proposedDocumentNumber: kind === "initial" ? "HC1860" : "HC1860-2" } },
});
const event = (overrides: Record<string, unknown> = {}) => ({ id: 14, containerControlId: "24x901", containerControlNumber: "C1860", eventKind: "initial", billingPeriodStart: "2026-10-01", billingPeriodEnd: "2026-10-31", proposedPoNumber: "HC1860", status: "previewed", ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
  mocks.getPolicy.mockResolvedValue(policy);
  mocks.assertPolicy.mockImplementation(() => undefined);
  mocks.initial.mockResolvedValue(preview());
  mocks.recurring.mockResolvedValue(preview("recurring"));
  mocks.getEvent.mockResolvedValue(event());
  mocks.claim.mockResolvedValue(true);
  mocks.bind.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue(undefined);
  mocks.hold.mockResolvedValue(undefined);
  mocks.latest.mockResolvedValue(event({ id: 13, status: "drafts_created" }));
  mocks.due.mockResolvedValue([]);
  mocks.execute.mockResolvedValue({ outcome: "succeeded", executionId: 41, result: { xeroDocumentId: "xero-po-1", documentNumber: "HC1860", status: "DRAFT" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("automatic For Hire AP lifecycle", () => {
  it("creates only a fresh current preflighted Draft PO and stores the next due date", async () => {
    const result = await processAutomaticInitialForHire("24x901");
    expect(result).toMatchObject({ ok: true, status: "drafts_created", poNumber: "HC1860", xeroWritesAttempted: 1 });
    expect(mocks.bind).toHaveBeenCalledWith(14, policy.releaseKey, expect.objectContaining({ endpoint: "/PurchaseOrders", method: "POST", documentNumber: "HC1860" }));
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "initial_for_hire", preparedBy: 9,
      authorisation: expect.objectContaining({ forHireAutomaticEventId: 14, forHireReleaseKey: policy.releaseKey, forHireApprovedBy: 9 }),
    }));
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ eventId: 14, executionId: 41, nextBillingDate: "2026-11-01", priorEventId: null }));
  });

  it("does not write when current source/Xero preview is held", async () => {
    mocks.initial.mockResolvedValue({ ...preview(), state: "held", holdReason: "Existing Xero PO is occupied." });
    await expect(processAutomaticInitialForHire("24x901")).resolves.toMatchObject({ ok: false, status: "held", xeroWritesAttempted: 0 });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not create a stale recurring extension after the selected predecessor changes", async () => {
    mocks.latest.mockResolvedValue(event({ id: 99, status: "drafts_created" }));
    await expect(processAutomaticRecurringForHire("24x901", 13, "2026-11-01")).resolves.toMatchObject({ ok: false, status: "held" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous Xero result in reconciliation-required without blind repeat", async () => {
    mocks.execute.mockResolvedValue({ outcome: "reconciliation_required", executionId: 41, error: "gateway timeout" });
    await expect(processAutomaticInitialForHire("24x901")).resolves.toMatchObject({ ok: false, status: "reconciliation_required", xeroWritesAttempted: 1 });
    expect(mocks.hold).toHaveBeenCalledWith(14, expect.stringMatching(/ambiguous/i), true);
  });

  it("runs a bounded AP-only recurring selector and isolates a held root", async () => {
    mocks.due.mockResolvedValue([event({ id: 13, status: "drafts_created", nextBillingDate: "2026-11-01" })]);
    mocks.recurring.mockResolvedValue({ ...preview("recurring"), preview: { ...preview("recurring").preview, proposedPoNumber: "HC1860-2", document: { ...document, documentType: "recurring_for_hire", proposedDocumentNumber: "HC1860-2" } } });
    mocks.execute.mockResolvedValue({ outcome: "succeeded", executionId: 44, result: { xeroDocumentId: "xero-po-2", documentNumber: "HC1860-2", status: "DRAFT" } });
    const result = await runAutomaticRecurringForHire("2026-11-01");
    expect(mocks.due).toHaveBeenCalledWith("2026-11-01", 10);
    expect(result).toMatchObject({ ok: true, considered: 1, xeroWritesAttempted: 1 });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ priorEventId: 13, nextBillingDate: "2026-11-01" }));
  });
});
