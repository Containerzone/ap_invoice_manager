import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCustomerSalePurchaseWebhookEnvelope, registerCustomerSalePurchaseWebhook } from "./financialCustomerSalePurchaseWebhook";

afterEach(() => {
  delete process.env.FINANCIAL_AP_WEBHOOK_SECRET;
  delete process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED;
});

describe("Customer Sale purchase webhook contract", () => {
  it("accepts an exact VTiger record id only and ignores financial body fields", () => {
    expect(parseCustomerSalePurchaseWebhookEnvelope({ record_id: "24x901", event: "container-control.customer-sale-request", amount: 0 })).toEqual({ recordId: "24x901", event: "container-control.customer-sale-request" });
    expect(() => parseCustomerSalePurchaseWebhookEnvelope({ id: "C1860" })).toThrow(/exact VTiger/i);
  });

  it("mounts the protected route but holds before source reads or Xero writes while its release gate is off", async () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    const handlers = new Map<string, any>();
    registerCustomerSalePurchaseWebhook({ post: (path: string, handler: any) => handlers.set(path, handler) } as any);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handlers.get("/api/webhooks/vtiger/container-control-customer-sale")({ header: () => "test-secret", body: { id: "24x901" } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "customer-sale-purchase-release-disabled", xeroWritesAttempted: 0 }));
  });
});
