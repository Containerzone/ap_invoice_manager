import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FinancialWriteDisabledError } from "./financialProductionWriter";

const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  getControl: vi.fn(),
  getManifest: vi.fn(),
  getPack: vi.fn(),
  getPostSuccess: vi.fn(),
  revalidate: vi.fn(),
  preparePayload: vi.fn(),
  executeWriter: vi.fn(),
  runPostSuccess: vi.fn(),
  reportFailure: vi.fn(),
}));

vi.mock("./financialWorkflowDb", () => ({
  getFinancialExecutionApproval: mocks.getApproval,
  getFinancialCutoverControlForWorkflow: mocks.getControl,
  getFinancialReleaseManifest: mocks.getManifest,
  getFinancialCutoverPack: mocks.getPack,
  getFinancialPostSuccessActionsForExecution: mocks.getPostSuccess,
}));
vi.mock("./financialApprovalService", () => ({ revalidateApprovedFinancialExecution: mocks.revalidate }));
vi.mock("./financialVerifiedDraftPayload", () => ({ prepareVerifiedFinancialDraftPayload: mocks.preparePayload }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: mocks.executeWriter }));
vi.mock("./vtigerFinancialWriteService", () => ({ runFinancialPostSuccessAction: mocks.runPostSuccess }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: mocks.reportFailure }));

import { executeApprovedFinancialDraft, getFinancialExecutionGateState } from "./financialLiveExecutionService";

const approval = {
  id: 71,
  status: "approved",
  expiresAt: new Date(Date.now() + 10 * 60_000),
  workflowType: "main_customer_invoice",
  workflowRunId: 8,
  documentIntentId: 9,
  releaseManifestId: 10,
  releaseFamilyId: 11,
  cutoverPackId: 12,
  approvalReference: "FIN-71",
  approvedBy: 3,
  proposedAction: "create_draft",
  proposedDocumentNumber: "INV-71",
  sourceSnapshotHash: "source",
  rulesSnapshotHash: "rules",
  proposalHash: "proposal",
  xeroPreflightHash: "preflight",
};

const document = {
  documentFamily: "customer_invoice" as const,
  documentType: "main_invoice",
  proposedAction: "create_draft" as const,
  proposedDocumentNumber: "INV-71",
  partyName: "Customer",
  partySourceId: "contact-71",
  accountCode: "200",
  gstTreatment: "GST_EXCLUSIVE" as const,
  currency: "AUD" as const,
  subtotal: 100,
  taxAmount: 10,
  total: 110,
  issueDate: null,
  dueDate: null,
  lineItems: [],
  sourceWorkflow: "main_customer_invoice" as const,
  sourceRecordId: "4x71",
  validationStatus: "valid" as const,
};

function applyAllGates() {
  mocks.getApproval.mockResolvedValue(approval);
  mocks.getControl.mockResolvedValue({ liveEnabled: true, mode: "live_enabled" });
  mocks.getManifest.mockResolvedValue({
    manifest: { status: "approved" },
    families: [{ id: 11, releaseStatus: "included", legacyWriterIdentifier: "old-writer", legacyWriterOwner: "Operations", legacyDisableAction: "Disabled after handoff" }],
  });
  mocks.getPack.mockResolvedValue({ state: "approved", workflowType: "main_customer_invoice" });
  mocks.revalidate.mockResolvedValue({
    matchesApproval: true,
    document,
    sourceRecordId: "4x71",
    workflowIdempotencyKey: "run-8",
    sourceData: {},
    preview: {
      approvalEligible: true,
      preflight: { documentNumber: "INV-71", duplicateState: "not_found", contactCheck: { found: true, contactId: "contact-71" }, itemChecks: [] },
    },
  });
  mocks.preparePayload.mockReturnValue({ documentNumber: "INV-71", endpoint: "/Invoices", method: "POST" });
  mocks.executeWriter.mockResolvedValue({ outcome: "succeeded", executionId: 501, result: { xeroDocumentId: "xero-71", documentNumber: "INV-71", status: "DRAFT" } });
  mocks.getPostSuccess.mockResolvedValue([]);
}

describe("financial live execution coordinator", () => {
  const originalLive = process.env.FINANCIAL_LIVE_WRITES_ENABLED;
  const originalShadow = process.env.FINANCIAL_GLOBAL_SHADOW_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    applyAllGates();
  });
  afterEach(() => {
    if (originalLive === undefined) delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    else process.env.FINANCIAL_LIVE_WRITES_ENABLED = originalLive;
    if (originalShadow === undefined) delete process.env.FINANCIAL_GLOBAL_SHADOW_MODE;
    else process.env.FINANCIAL_GLOBAL_SHADOW_MODE = originalShadow;
  });

  it("shows a disabled deployment lock without calling the writer", async () => {
    delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    const state = await getFinancialExecutionGateState(71);
    expect(state.gates.environmentLiveWritesEnabled).toBe(false);
    await expect(executeApprovedFinancialDraft({ approvalId: 71, requestedBy: 3 })).rejects.toBeInstanceOf(FinancialWriteDisabledError);
    expect(mocks.executeWriter).not.toHaveBeenCalled();
  });

  it("rejects the writer when a refreshed source or Xero preflight changes", async () => {
    process.env.FINANCIAL_LIVE_WRITES_ENABLED = "true";
    process.env.FINANCIAL_GLOBAL_SHADOW_MODE = "false";
    mocks.revalidate.mockResolvedValueOnce({
      matchesApproval: false,
      document,
      sourceRecordId: "4x71",
      workflowIdempotencyKey: "run-8",
      preview: { approvalEligible: false, blockers: ["Xero duplicate changed"], preflight: {} },
    });
    await expect(executeApprovedFinancialDraft({ approvalId: 71 })).rejects.toBeInstanceOf(FinancialWriteDisabledError);
    expect(mocks.executeWriter).not.toHaveBeenCalled();
  });

  it("reaches the writer only after every independent gate and fresh evidence pass", async () => {
    process.env.FINANCIAL_LIVE_WRITES_ENABLED = "true";
    process.env.FINANCIAL_GLOBAL_SHADOW_MODE = "false";
    await expect(executeApprovedFinancialDraft({ approvalId: 71, requestedBy: 4 })).resolves.toMatchObject({
      mode: "active_execution",
      approvalId: 71,
      outcome: { outcome: "succeeded", executionId: 501 },
      postSuccess: { outcome: "not_required" },
    });
    expect(mocks.executeWriter).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: 71,
      sourceRecordId: "4x71",
      authorisation: expect.objectContaining({ globalShadowMode: false, currentDocumentPreflightPassed: true }),
    }));
  });

  it("runs every planned VTiger follow-up only after the Xero Draft has succeeded and read back", async () => {
    process.env.FINANCIAL_LIVE_WRITES_ENABLED = "true";
    process.env.FINANCIAL_GLOBAL_SHADOW_MODE = "false";
    mocks.getApproval.mockResolvedValue({ ...approval, workflowType: "storage_finalisation" });
    mocks.getPack.mockResolvedValue({ state: "approved", workflowType: "storage_finalisation" });
    mocks.revalidate.mockResolvedValue({
      matchesApproval: true,
      document: { ...document, documentType: "storage_finalisation", sourceWorkflow: "storage_finalisation" },
      sourceRecordId: "4x71",
      sourceData: { dateOut: "2026-10-01", storageStage: "4 - Finalise" },
      workflowIdempotencyKey: "run-8",
      preview: { approvalEligible: true, preflight: { documentNumber: "INV-71", duplicateState: "found", status: "DRAFT", xeroDocumentId: "invoice-71", contactCheck: { found: true, contactId: "contact-71" }, itemChecks: [] } },
    });
    mocks.getPostSuccess.mockResolvedValue([{ id: 91 }, { id: 92 }]);
    mocks.runPostSuccess.mockResolvedValue({ outcome: "succeeded" });

    const result = await executeApprovedFinancialDraft({ approvalId: 71 });

    expect(result.postSuccess).toMatchObject({ attempted: true, actionIds: [91, 92], outcome: "succeeded" });
    expect(mocks.executeWriter).toHaveBeenCalledWith(expect.objectContaining({
      postSuccessPlan: expect.arrayContaining([
        expect.objectContaining({ actionType: "vtiger_note" }),
        expect.objectContaining({ actionType: "vtiger_task" }),
      ]),
    }));
    expect(mocks.runPostSuccess).toHaveBeenCalledTimes(2);
  });
});
