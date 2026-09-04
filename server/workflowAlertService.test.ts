import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRecordWorkflowFailure,
  mockUpdateWorkflowFailureAlertAttempt,
  mockSendOperationalAlertEmail,
} = vi.hoisted(() => ({
  mockRecordWorkflowFailure: vi.fn(),
  mockUpdateWorkflowFailureAlertAttempt: vi.fn(),
  mockSendOperationalAlertEmail: vi.fn(),
}));

vi.mock("./db", () => ({
  recordWorkflowFailure: mockRecordWorkflowFailure,
  updateWorkflowFailureAlertAttempt: mockUpdateWorkflowFailureAlertAttempt,
}));
vi.mock("./emailService", () => ({
  sendOperationalAlertEmail: mockSendOperationalAlertEmail,
}));

import { getWorkflowAlertRecipients } from "./workflowAlertService";
import { reportWorkflowFailure } from "./workflowAlertService";

describe("workflow alert recipient configuration", () => {
  it("loads the two configured alert recipients from the environment without exposing them through an API response", () => {
    const recipients = getWorkflowAlertRecipients();
    expect(recipients).toHaveLength(2);
    expect(recipients.every((recipient) => recipient.includes("@"))).toBe(true);
  });

  it("normalizes and deduplicates valid recipient entries", () => {
    expect(getWorkflowAlertRecipients("one@example.com, TWO@example.com, one@example.com, invalid")).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
  });
});

describe("workflow failure reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordWorkflowFailure.mockResolvedValue({
      shouldAlert: true,
      failure: {
        id: 77,
        workflowType: "vtiger-po-webhook",
        recordKey: "po-request:77",
        title: "PO creation failed for D702837",
        errorMessage: "No recognised transport cost fields",
        details: { dealNumber: "D702837" },
        lastOccurredAt: new Date("2026-09-04T00:00:00.000Z"),
      },
    });
    mockSendOperationalAlertEmail.mockResolvedValue({ success: true });
  });

  it("records the failure and sends one immediate alert to the configured recipients", async () => {
    await reportWorkflowFailure({
      workflowType: "vtiger-po-webhook",
      recordKey: "po-request:77",
      title: "PO creation failed for D702837",
      errorMessage: "No recognised transport cost fields",
    });

    expect(mockSendOperationalAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      recipients: getWorkflowAlertRecipients(),
      subject: "AP workflow failure: PO creation failed for D702837",
    }));
    expect(mockUpdateWorkflowFailureAlertAttempt).toHaveBeenCalledWith(77, undefined);
  });
});
