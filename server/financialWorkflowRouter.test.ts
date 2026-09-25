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
  getFinancialWorkflowExceptions: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowRunDetail: vi.fn().mockResolvedValue(undefined),
  getFinancialWorkflowRuns: vi.fn().mockResolvedValue([]),
  getFinancialWorkflowSchedules: vi.fn().mockResolvedValue([]),
  resolveFinancialWorkflowException: vi.fn().mockResolvedValue(undefined),
  upsertFinancialWorkflowConfig: vi.fn().mockResolvedValue(undefined),
  upsertFinancialWorkflowSchedule: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./vtigerFinancialReadService", () => ({
  getVtigerFinancialConnectionStatus: vi.fn().mockReturnValue({ configured: true, missing: [] }),
  retrieveCurrentVtigerFinancialRecord: vi.fn().mockResolvedValue({ customerOrganisationName: "Current customer", modifiedtime: "2026-09-25 12:00:00" }),
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
});
