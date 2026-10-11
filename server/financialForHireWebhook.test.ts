import { describe, expect, it, vi } from "vitest";
import { disabledForHireWebhookHandler, parseForHireWebhookEnvelope } from "./financialForHireWebhook";

describe("dormant For Hire webhook contract", () => {
  it("accepts only an exact VTiger Container Control ID or record_id", () => {
    expect(parseForHireWebhookEnvelope({ record_id: "24x901", event: "container-control.request" })).toEqual({ recordId: "24x901", event: "container-control.request" });
    expect(parseForHireWebhookEnvelope({ id: "24x901" })).toEqual({ recordId: "24x901", event: null });
    expect(() => parseForHireWebhookEnvelope({ id: "C1860" })).toThrow(/requires an exact VTiger/i);
  });

  it("remains a 503 no-write stub even with a valid secret", async () => {
    const previous = process.env.FINANCIAL_AP_WEBHOOK_SECRET;
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await disabledForHireWebhookHandler({ header: (name: string) => name === "x-financial-webhook-secret" ? "test-secret" : undefined, body: { id: "24x901" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "for-hire-route-not-activated", xeroWritesAttempted: 0 }));
    if (previous === undefined) delete process.env.FINANCIAL_AP_WEBHOOK_SECRET; else process.env.FINANCIAL_AP_WEBHOOK_SECRET = previous;
  });
});
