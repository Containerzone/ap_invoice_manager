import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  getSchedule: vi.fn(),
  recordOutcome: vi.fn(),
  retry: vi.fn(),
  report: vi.fn(),
  shadow: vi.fn(),
  writerEnabled: vi.fn(),
}));

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticate } }));
vi.mock("./financialWorkflowDb", () => ({
  getFinancialWorkflowScheduleByTaskUid: mocks.getSchedule,
  recordFinancialWorkflowScheduleOutcome: mocks.recordOutcome,
}));
vi.mock("./vtigerFinancialWriteService", () => ({ retryFinancialPostSuccessActions: mocks.retry }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: mocks.report }));
vi.mock("./financialLiveExecutionService", () => ({ isFinancialGlobalShadowModeEnabled: mocks.shadow }));
vi.mock("./financialProductionWriter", () => ({ isFinancialLiveWriteEnvironmentEnabled: mocks.writerEnabled }));

import { financialPostSuccessRetryHandler, financialRecurringProposalHandler, isFirstSydneyCalendarDay } from "./financialScheduledHandlers";

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("inactive financial scheduled handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ isCron: true, taskUid: "financial-task" });
    mocks.getSchedule.mockResolvedValue(undefined);
    mocks.shadow.mockReturnValue(true);
    mocks.writerEnabled.mockReturnValue(false);
  });

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

  it("has no recurring source selector even if a future cron task is present", async () => {
    mocks.getSchedule.mockResolvedValue({ workflowType: "recurring_for_hire", enabled: true });
    const res = response();
    await financialRecurringProposalHandler({ params: { workflowType: "recurring_for_hire" }, path: "/api/scheduled/financial-recurring/recurring_for_hire" } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(501);
    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "blocked_missing_source_selector" }));
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("uses the Australia/Sydney calendar boundary for recurring storage", () => {
    expect(isFirstSydneyCalendarDay(new Date("2026-09-30T13:59:00.000Z"))).toBe(false);
    expect(isFirstSydneyCalendarDay(new Date("2026-09-30T14:00:00.000Z"))).toBe(true);
  });
});
