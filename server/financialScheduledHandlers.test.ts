import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getSchedule: vi.fn(),
  recordOutcome: vi.fn(),
  retry: vi.fn(),
  report: vi.fn(),
  shadow: vi.fn(),
  writerEnabled: vi.fn(),
  recurring: vi.fn(),
  forHireRecurring: vi.fn(),
  recordTraversal: vi.fn(),
}));

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticate } }));
vi.mock("./financialWorkflowDb", () => ({
  getFinancialWorkflowScheduleByTaskUid: mocks.getSchedule,
  recordFinancialWorkflowScheduleOutcome: mocks.recordOutcome,
}));
vi.mock("./vtigerFinancialWriteService", () => ({ retryFinancialPostSuccessActions: mocks.retry, isFinancialPostSuccessVtigerWriteEnabled: vi.fn(() => false) }));
vi.mock("./financialStorageRelease", () => ({ getStorageReleasePolicy: vi.fn(async () => ({})), assertStorageRelease: vi.fn() }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: mocks.report }));
vi.mock("./financialLiveExecutionService", () => ({ isFinancialGlobalShadowModeEnabled: mocks.shadow }));
vi.mock("./financialProductionWriter", () => ({ isFinancialLiveWriteEnvironmentEnabled: mocks.writerEnabled }));
vi.mock("./financialStorageLifecycleService", () => ({ runAutomaticRecurringStorage: mocks.recurring }));
vi.mock("./financialForHireLiveService", () => ({ runAutomaticRecurringForHire: mocks.forHireRecurring }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: vi.fn(async () => ({})), assertForHireRelease: vi.fn() }));
vi.mock("./financialForHireDailyTraversalDb", () => ({ recordForHireDailyTraversal: mocks.recordTraversal }));

import { financialPostSuccessRetryHandler, financialRecurringProposalHandler, isFirstSydneyCalendarDay } from "./financialScheduledHandlers";
import { FOR_HIRE_RECURRING_CRON } from "./financialForHireSchedule";

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("inactive financial scheduled handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "false");
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "false");
    mocks.authenticate.mockResolvedValue({ isCron: true, taskUid: "financial-task" });
    mocks.getSchedule.mockResolvedValue(undefined);
    mocks.shadow.mockReturnValue(true);
    mocks.writerEnabled.mockReturnValue(false);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("rejects an unregistered post-success schedule without invoking a retry", async () => {
    const res = response();
    await financialPostSuccessRetryHandler({ path: "/api/scheduled/financial-post-success-retry" } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("keeps a registered task blocked while either global execution lock remains active", async () => {
    mocks.getSchedule.mockResolvedValue({ workflowType: "financial_post_success_retry", enabled: true });
    const res = response();
    await financialPostSuccessRetryHandler({ path: "/api/scheduled/financial-post-success-retry" } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "blocked_by_execution_lock" }));
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("returns a disabled no-write audit for a recognised disabled recurring task", async () => {
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", enabled: false });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" }, path: "/api/scheduled/financial-recurring/recurring_for_hire" } as any, res as any);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "disabled_no_write_audit", selectorAvailable: true, xeroWritesAttempted: 0 }));
    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "disabled_no_write_audit" }));
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("executes only the registered enabled For Hire schedule through its isolated release processor", async () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-13T20:05:00Z"));
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", taskUid: "financial-task", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON });
    mocks.forHireRecurring.mockResolvedValue({ ok: true, considered: 1, results: [], xeroWritesAttempted: 0 });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" } } as any, res as any);
    expect(mocks.forHireRecurring).toHaveBeenCalledOnce();
    expect(mocks.recurring).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ considered: 1 }));
  });

  it("refuses a stale first-of-month For Hire schedule before invoking the selector or writer", async () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", taskUid: "financial-task", enabled: true, cronExpression: "0 0 0 1 * *" });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" } } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "for-hire-daily-schedule-required", xeroWritesAttempted: 0 }));
    expect(mocks.forHireRecurring).not.toHaveBeenCalled();
  });

  it("uses managed retry for another due For Hire batch, never an in-process timer", async () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", taskUid: "financial-task", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON });
    mocks.forHireRecurring.mockResolvedValue({ ok: true, considered: 10, retryRemainingBatch: true, xeroWritesAttempted: 10 });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" } } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mocks.forHireRecurring).toHaveBeenCalledOnce();
  });

  it("uses only server-owned daily traversal metadata and persists it before requesting another batch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-13T20:05:00Z"));
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", taskUid: "financial-task", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON, auditData: { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: 10, complete: false } } });
    mocks.forHireRecurring.mockResolvedValue({ ok: true, lastVisitedEventId: 20, retryRemainingBatch: true });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" }, body: { afterEventId: 999999, now: "2099-01-01" } } as any, res as any);
    expect(mocks.forHireRecurring).toHaveBeenCalledWith("2026-12-14", 10, 0);
    expect(mocks.recordTraversal).toHaveBeenCalledWith("financial-task", "2026-12-14", 20, false, 0);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(mocks.recordTraversal.mock.invocationCallOrder[0]).toBeLessThan(res.status.mock.invocationCallOrder[0]);
  });

  it("resets a completed traversal for the next Sydney day without clearing financial holds", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-14T20:05:00Z"));
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", taskUid: "financial-task", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON, auditData: { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: 20, complete: true } } });
    mocks.forHireRecurring.mockResolvedValue({ ok: true, lastVisitedEventId: 12, retryRemainingBatch: false });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" } } as any, res as any);
    expect(mocks.forHireRecurring).toHaveBeenCalledWith("2026-12-15", 0, 0);
    expect(mocks.recordTraversal).toHaveBeenCalledWith("financial-task", "2026-12-15", 12, true, 0);
  });

  it("uses the task-owned manual cursor and ignores manual IDs or dates supplied in the callback body", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-13T20:05:00Z"));
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", taskUid: "financial-task", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON, auditData: { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: 20, afterManualHandoverId: 7, complete: false } } });
    mocks.forHireRecurring.mockResolvedValue({ ok: true, lastVisitedEventId: 20, lastVisitedManualHandoverId: 17, retryRemainingBatch: true });
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" }, body: { afterManualHandoverId: 99999, now: "2099-01-01" } } as any, response() as any);
    expect(mocks.forHireRecurring).toHaveBeenCalledWith("2026-12-14", 20, 7);
    expect(mocks.recordTraversal).toHaveBeenCalledWith("financial-task", "2026-12-14", 20, false, 17);
  });

  it("does not run a daily For Hire callback when the family gate remains off", async () => {
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", taskUid: "financial-task", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" } } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mocks.forHireRecurring).not.toHaveBeenCalled();
  });

  it("uses the Australia/Sydney calendar boundary for recurring storage", () => {
    expect(isFirstSydneyCalendarDay(new Date("2026-09-30T13:59:00.000Z"))).toBe(false);
    expect(isFirstSydneyCalendarDay(new Date("2026-09-30T14:00:00.000Z"))).toBe(true);
  });
  it("executes only the registered enabled recurring storage schedule through the isolated release service", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-31T13:05:00Z"));
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_storage", enabled: true });
    mocks.recurring.mockResolvedValue({ ok: true, considered: 1, results: [], retryRemainingBatch: false });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_storage" } } as any, res as any);
    expect(mocks.recurring).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ considered: 1 }));
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_storage", enabled: false });
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_storage" } } as any, res as any);
    expect(mocks.recurring).toHaveBeenCalledOnce();
  });
  it("requests managed retry when current due roots remain after a bounded successful batch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-31T13:05:00Z"));
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_storage", enabled: true });
    mocks.recurring.mockResolvedValue({ ok: true, retryRemainingBatch: true });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_storage" } } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
