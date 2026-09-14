import { describe, expect, it, vi } from "vitest";
import {
  reconcileRecentInvoiceMessages,
  selectRecentAttachedMessageIds,
} from "./microsoftGraphReconciliation";

const now = new Date("2026-09-14T06:30:00.000Z");

describe("Microsoft missed-notification reconciliation", () => {
  it("considers only recent messages with attachments and bounds the recovery workload", () => {
    const messages = [
      { id: "recent-pdf", hasAttachments: true, receivedDateTime: "2026-09-14T06:25:00.000Z" },
      { id: "no-file", hasAttachments: false, receivedDateTime: "2026-09-14T06:24:00.000Z" },
      { id: "old-file", hasAttachments: true, receivedDateTime: "2026-09-13T22:00:00.000Z" },
      { id: "invalid-date", hasAttachments: true, receivedDateTime: "not-a-date" },
    ];

    expect(selectRecentAttachedMessageIds(messages, now)).toEqual(["recent-pdf"]);
  });

  it("continues after an individual recovery failure and reports it for monitoring", async () => {
    const processMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("attachment retrieval failed"));
    const result = await reconcileRecentInvoiceMessages([
      { id: "first", hasAttachments: true, receivedDateTime: "2026-09-14T06:25:00.000Z" },
      { id: "second", hasAttachments: true, receivedDateTime: "2026-09-14T06:24:00.000Z" },
    ], processMessage, now);

    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ considered: 2, recovered: 1, failedMessageIds: ["second"] });
  });
});
