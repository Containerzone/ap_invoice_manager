import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAssetPurchaseWebhookEnvelope, registerAssetPurchaseWebhook } from "./financialAssetPurchaseWebhook";

afterEach(() => {
  delete process.env.FINANCIAL_AP_WEBHOOK_SECRET;
  delete process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED;
});

describe("Asset purchase webhook contract", () => {
  it("accepts an exact VTiger record id only and ignores financial body fields", () => {
    expect(parseAssetPurchaseWebhookEnvelope({ record_id: "24x901", event: "container-control.asset-request", amount: 0 })).toEqual({ recordId: "24x901", event: "container-control.asset-request" });
    expect(() => parseAssetPurchaseWebhookEnvelope({ id: "C1860" })).toThrow(/exact VTiger/i);
  });

  it("mounts the protected route but holds before source reads or Xero writes while its release gate is off", async () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    const handlers = new Map<string, any>();
    registerAssetPurchaseWebhook({ post: (path: string, handler: any) => handlers.set(path, handler) } as any);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handlers.get("/api/webhooks/vtiger/container-control-asset")({ header: () => "test-secret", body: { id: "24x901" } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "asset-purchase-release-disabled", xeroWritesAttempted: 0 }));
  });
});
