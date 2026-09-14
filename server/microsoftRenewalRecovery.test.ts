import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthenticateRequest,
  mockGetMicrosoftGraphState,
  mockUpdateMicrosoftGraphState,
  mockRenewSubscription,
  mockCreateSubscription,
  mockReportFailure,
} = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockGetMicrosoftGraphState: vi.fn(),
  mockUpdateMicrosoftGraphState: vi.fn(),
  mockRenewSubscription: vi.fn(),
  mockCreateSubscription: vi.fn(),
  mockReportFailure: vi.fn(),
}));

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mockAuthenticateRequest } }));
vi.mock("./db", () => ({
  deleteOldArchivedInvoices: vi.fn(),
  getMicrosoftGraphState: mockGetMicrosoftGraphState,
  getOpenWorkflowFailures: vi.fn(),
  getWorkflowMonitoringSettings: vi.fn(),
  updateMicrosoftGraphState: mockUpdateMicrosoftGraphState,
  updateWorkflowMonitoringSettings: vi.fn(),
}));
vi.mock("./microsoftGraphConfig", () => ({ getMicrosoftGraphConfig: () => ({ mailbox: "invoices@containerzone.com.au" }) }));
vi.mock("./microsoftGraphService", () => ({
  renewGraphMessageSubscription: mockRenewSubscription,
  createGraphMessageSubscription: mockCreateSubscription,
  isMissingGraphSubscriptionError: (error: unknown) => error instanceof Error && error.message.includes("(404): ResourceNotFound"),
}));
vi.mock("./workflowAlertService", () => ({ getWorkflowAlertRecipients: vi.fn(), reportWorkflowFailureSafely: mockReportFailure }));
vi.mock("./emailService", () => ({ sendOperationalAlertEmail: vi.fn() }));

import { microsoftSubscriptionRenewalHandler } from "./scheduledHandlers";

describe("Microsoft Graph subscription renewal recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({ isCron: true, taskUid: "renewal-task" });
    mockGetMicrosoftGraphState.mockResolvedValue({
      mailbox: "invoices@containerzone.com.au",
      subscriptionId: "expired-subscription-id",
      scheduleCronTaskUid: "renewal-task",
      notificationUrl: "https://apinvmanager-dm3caxom.manus.space/api/microsoft/notifications",
    });
    mockRenewSubscription.mockRejectedValue(new Error("Microsoft Graph request failed (404): ResourceNotFound — The object was not found."));
    mockCreateSubscription.mockResolvedValue({ id: "replacement-subscription-id", expirationDateTime: "2026-09-16T00:00:00.000Z" });
  });

  it("recreates a missing subscription using the deployed callback host and preserves the renewal schedule", async () => {
    const response = { status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    const request = {};

    await microsoftSubscriptionRenewalHandler(request as any, response as any);

    expect(mockCreateSubscription).toHaveBeenCalledWith("https://apinvmanager-dm3caxom.manus.space/api/microsoft/notifications");
    expect(mockUpdateMicrosoftGraphState).toHaveBeenCalledWith("invoices@containerzone.com.au", expect.objectContaining({
      subscriptionId: "replacement-subscription-id",
      subscriptionExpiresAt: new Date("2026-09-16T00:00:00.000Z"),
      lastSubscriptionError: null,
    }));
    expect(response.json).toHaveBeenCalledWith({ ok: true, recreated: true, subscriptionExpiresAt: "2026-09-16T00:00:00.000Z" });
    expect(mockReportFailure).not.toHaveBeenCalled();
  });
});
