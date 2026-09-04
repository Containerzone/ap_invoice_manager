import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuthenticateRequest, mockGetSettings, mockGetOpenFailures, mockUpdateSettings, mockSendAlert } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockGetSettings: vi.fn(),
  mockGetOpenFailures: vi.fn(),
  mockUpdateSettings: vi.fn(),
  mockSendAlert: vi.fn(),
}));

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mockAuthenticateRequest } }));
vi.mock("./db", () => ({
  deleteOldArchivedInvoices: vi.fn(),
  getMicrosoftGraphState: vi.fn(),
  getOpenWorkflowFailures: mockGetOpenFailures,
  getWorkflowMonitoringSettings: mockGetSettings,
  updateMicrosoftGraphState: vi.fn(),
  updateWorkflowMonitoringSettings: mockUpdateSettings,
}));
vi.mock("./microsoftGraphService", () => ({ renewGraphMessageSubscription: vi.fn() }));
vi.mock("./microsoftGraphConfig", () => ({ getMicrosoftGraphConfig: () => ({ mailbox: "invoices@containerzone.com.au" }) }));
vi.mock("./workflowAlertService", () => ({
  getWorkflowAlertRecipients: () => ["alerts@example.com"],
  reportWorkflowFailureSafely: vi.fn(),
}));
vi.mock("./emailService", () => ({ sendOperationalAlertEmail: mockSendAlert }));

import { workflowFailureReconciliationHandler } from "./scheduledHandlers";

function createResponse() {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe("workflowFailureReconciliationHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({ isCron: true, taskUid: "summary-task" });
    mockGetSettings.mockResolvedValue({ dailySummaryCronTaskUid: "summary-task" });
    mockGetOpenFailures.mockResolvedValue([{
      title: "PO creation failed for D702837",
      workflowType: "vtiger-po-webhook",
      recordKey: "po-request:77",
      lastOccurredAt: new Date("2026-09-04T00:00:00.000Z"),
      occurrenceCount: 1,
      errorMessage: "No recognised transport cost fields",
    }]);
    mockSendAlert.mockResolvedValue({ success: true });
  });

  it("emails a reconciliation summary for open failures and records the send time", async () => {
    const response = createResponse();
    await workflowFailureReconciliationHandler({ path: "/api/scheduled/workflow-failure-reconciliation" } as any, response as any);

    expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({
      recipients: ["alerts@example.com"],
      subject: "AP daily reconciliation — 1 open workflow failure",
    }));
    expect(mockUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ lastDailySummaryAt: expect.any(Date) }));
    expect(response.json).toHaveBeenCalledWith({ ok: true, openFailureCount: 1 });
  });
});
