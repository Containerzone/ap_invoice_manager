import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const evaluation = {
  workflowType: "main_customer_invoice",
  mode: "shadow",
  idempotencyKey: "safe-key",
  sourceSummary: {},
  intents: [],
  issues: [],
  outcome: "passed",
  safeRequestSummary: { xeroWritePermitted: false },
};

vi.mock("./financialWorkflowService", () => ({
  FINANCIAL_SHADOW_MODE: true,
  evaluateAndPersistFinancialWorkflow: vi.fn().mockResolvedValue({
    evaluation,
    persistence: { runId: 77, duplicate: false, intentIds: [], exceptionIds: [] },
  }),
}));

vi.mock("./financialWorkflowDb", () => ({
  addFinancialExceptionComment: vi.fn().mockResolvedValue(1),
  assignFinancialWorkflowException: vi.fn().mockResolvedValue(undefined),
  getFinancialDocumentIntents: vi.fn().mockResolvedValue([]),
  getFinancialDocuments: vi.fn().mockResolvedValue([]),
  getFinancialExceptionComments: vi.fn().mockResolvedValue([]),
  getFinancialOperationsDashboard: vi.fn().mockResolvedValue({ runsToday: 0 }),
  getFinancialWorkflowConfig: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowConfigAudits: vi.fn().mockResolvedValue([]),
  createFinancialCandidateDiscovery: vi.fn().mockResolvedValue(33),
  createFinancialIntegrationAudit: vi.fn().mockResolvedValue(44),
  createFinancialShadowTest: vi.fn().mockResolvedValue(901),
  getFinancialCandidateDiscoveries: vi.fn().mockResolvedValue([]),
  getFinancialIntegrationAudits: vi.fn().mockResolvedValue([]),
  getFinancialShadowTestById: vi.fn().mockResolvedValue({ id: 901, reviewStatus: "pending", actualResult: { reviewEligible: true } }),
  getFinancialShadowTests: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowExceptions: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowRunDetail: vi.fn().mockResolvedValue(undefined),
  getFinancialWorkflowRuns: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowSchedules: vi.fn().mockResolvedValue([]),
  resolveFinancialWorkflowException: vi.fn().mockResolvedValue(undefined),
  reviewFinancialShadowTest: vi.fn().mockResolvedValue(undefined),
  upsertFinancialWorkflowConfig: vi.fn().mockResolvedValue(undefined),
  upsertFinancialWorkflowSchedule: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./vtigerFinancialReadService", () => ({
  getVtigerFinancialConnectionStatus: vi.fn().mockReturnValue({ configured: true, missing: [] }),
  testVtigerFinancialConnection: vi.fn().mockResolvedValue({ configured: true, missing: [], outcome: "passed" }),
  retrieveCurrentVtigerFinancialRecord: vi.fn().mockResolvedValue({ customerOrganisationName: "Current customer", modifiedtime: "2026-09-25 12:00:00" }),
}));

vi.mock("./vtigerFinancialCandidateService", () => ({
  findExactFinancialCandidate: vi.fn().mockResolvedValue({
    outcome: "found", sourceCategory: "deal", businessNumber: "D702903", message: "Exact match", candidates: [{
      recordId: "4x702903", module: "Potentials", matchedField: "potentials_no", sourceCategory: "deal", businessNumber: "D702903", sourceRefreshedAt: new Date(), summary: { potentials_no: "D702903" },
    }],
  }),
  getFinancialCandidateFinderConfig: vi.fn().mockReturnValue({ deal: [], container_control: [] }),
}));

vi.mock("./financialReadOnlyXeroService", () => ({
  getFinancialXeroConnectionStatus: vi.fn().mockResolvedValue({ configured: true, tokenState: "valid" }),
  testFinancialXeroConnection: vi.fn().mockResolvedValue({ outcome: "passed" }),
  preflightFinancialXeroIntents: vi.fn().mockResolvedValue([]),
  previewHistoricalXeroReferences: vi.fn().mockResolvedValue([]),
}));

function context(role: "admin" | "user"): TrpcContext {
  return {
    user: {
      id: role === "admin" ? 1 : 2, openId: `${role}-id`, name: role, email: `${role}@example.com`, loginMethod: "manus", role,
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), status: "active",
    },
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("financial operations tRPC safeguards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("permits an admin dry run and returns an explicit no-write result", async () => {
    const { appRouter } = await import("./routers");
    const { evaluateAndPersistFinancialWorkflow } = await import("./financialWorkflowService");
    const caller = appRouter.createCaller(context("admin"));
    const result = await caller.financialOperations.dryRun({
      workflowType: "main_customer_invoice", sourceRecordId: "deal-1", sourceData: { customerOrganisationName: "Customer" }, reEvaluationKey: "manual-1",
    });
    expect(result).toMatchObject({ mode: "shadow", xeroWritePermitted: false, financialShadowMode: true });
    expect(evaluateAndPersistFinancialWorkflow).toHaveBeenCalledWith(expect.objectContaining({ triggerType: "re_evaluation", workflowType: "main_customer_invoice" }), 1);
  });

  it("does not grant staff the ability to create financial dry runs or change mappings", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller(context("user"));
    await expect(caller.financialOperations.dryRun({ workflowType: "main_customer_invoice", sourceData: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.financialOperations.saveConfig({ configKey: "warranty.mappings", configValue: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts only disabled financial target schedule metadata in phase one", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller(context("admin"));
    await expect(caller.financialOperations.saveDisabledSchedule({ workflowType: "recurring_for_hire", enabled: false })).resolves.toMatchObject({ enabled: false, mode: "shadow" });
    await expect(caller.financialOperations.saveDisabledSchedule({ workflowType: "recurring_for_hire", enabled: true as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("supports a read-only administrator-triggered re-evaluation of a current VTiger record", async () => {
    const { appRouter } = await import("./routers");
    const { retrieveCurrentVtigerFinancialRecord } = await import("./vtigerFinancialReadService");
    const { evaluateAndPersistFinancialWorkflow } = await import("./financialWorkflowService");
    const result = await appRouter.createCaller(context("admin")).financialOperations.refreshCurrentVtigerRecord({
      workflowType: "main_customer_invoice", vtigerRecordId: "4x12345", sourceRecordNumber: "D700001",
    });
    expect(result).toMatchObject({ mode: "shadow", xeroWritePermitted: false });
    expect(retrieveCurrentVtigerFinancialRecord).toHaveBeenCalledWith("4x12345");
    expect(evaluateAndPersistFinancialWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: "re_evaluation", sourceRecordId: "4x12345", sourceData: expect.objectContaining({ customerOrganisationName: "Current customer" }),
    }), 1);
  });

  it("records a named current-record shadow test with no Xero write permission", async () => {
    const { appRouter } = await import("./routers");
    const { preflightFinancialXeroIntents } = await import("./financialReadOnlyXeroService");
    const { createFinancialShadowTest } = await import("./financialWorkflowDb");
    const result = await appRouter.createCaller(context("admin")).financialOperations.validateCurrentVtigerRecord({
      workflowType: "main_customer_invoice", branch: "Main customer invoice", vtigerRecordId: "4x12345", sourceRecordNumber: "D700001",
      expectedResult: { proposedDocumentNumbers: ["INV-700001"] },
    });
    expect(result).toMatchObject({ mode: "shadow", xeroWritePermitted: false, xeroWriteMethodsCalled: [], testId: 901 });
    expect(preflightFinancialXeroIntents).toHaveBeenCalledWith([]);
    expect(createFinancialShadowTest).toHaveBeenCalledWith(expect.objectContaining({
      sourceRecordNumber: "D700001", xeroPreflight: expect.objectContaining({ readOnly: true, xeroWriteMethodsCalled: [] }),
    }));
  });

  it("records an exact named candidate lookup without exposing a live writer", async () => {
    const { appRouter } = await import("./routers");
    const { createFinancialCandidateDiscovery } = await import("./financialWorkflowDb");
    const result = await appRouter.createCaller(context("admin")).financialOperations.findVtigerCandidate({
      sourceCategory: "deal", businessNumber: "D702903", workflowType: "main_customer_invoice",
    });
    expect(result).toMatchObject({ outcome: "found", discoveryId: 33, xeroWritePermitted: false });
    expect(createFinancialCandidateDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      businessNumber: "D702903", candidateRecordIds: ["4x702903"], initiatedBy: 1,
    }));
  });

  it("allows only an administrator to confirm or reject recorded shadow evidence", async () => {
    const { appRouter } = await import("./routers");
    const { reviewFinancialShadowTest } = await import("./financialWorkflowDb");
    await expect(appRouter.createCaller(context("user")).financialOperations.reviewShadowTest({
      testId: 901, reviewStatus: "confirmed", reviewerComment: "Confirmed against source and rule facts.",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(appRouter.createCaller(context("admin")).financialOperations.reviewShadowTest({
      testId: 901, reviewStatus: "confirmed", reviewerComment: "Confirmed against source and rule facts.",
    })).resolves.toMatchObject({ success: true, xeroWritePermitted: false });
    expect(reviewFinancialShadowTest).toHaveBeenCalledWith(expect.objectContaining({ testId: 901, reviewedBy: 1, reviewStatus: "confirmed" }));
  });

  it("does not allow a blocked or different test to be confirmed", async () => {
    const { appRouter } = await import("./routers");
    const { getFinancialShadowTestById } = await import("./financialWorkflowDb");
    vi.mocked(getFinancialShadowTestById).mockResolvedValueOnce({ id: 902, reviewStatus: "pending", actualResult: { reviewEligible: false } } as any);
    await expect(appRouter.createCaller(context("admin")).financialOperations.reviewShadowTest({
      testId: 902, reviewStatus: "confirmed", reviewerComment: "Attempting to override a blocked test.",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
