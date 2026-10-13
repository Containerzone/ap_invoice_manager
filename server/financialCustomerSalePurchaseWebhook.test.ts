import { afterEach, describe, expect, it, vi } from "vitest";
const candidateLookup = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("./vtigerFinancialCandidateService", () => ({ findExactFinancialCandidate: candidateLookup.find }));

import { parseCustomerSalePurchaseWebhookEnvelope, registerCustomerSalePurchaseWebhook, resolveCustomerSalePurchaseRecordId } from "./financialCustomerSalePurchaseWebhook";

afterEach(() => {
  delete process.env.FINANCIAL_AP_WEBHOOK_SECRET;
  delete process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED;
});

describe("Customer Sale purchase webhook contract", () => {
  it("accepts an exact VTiger record id only and ignores financial body fields", () => {
    expect(parseCustomerSalePurchaseWebhookEnvelope({ record_id: "24x901", event: "container-control.customer-sale-request", amount: 0 })).toEqual({ recordId: "24x901", event: "container-control.customer-sale-request" });
    expect(parseCustomerSalePurchaseWebhookEnvelope({ id: "C1860" })).toEqual({ recordId: "C1860", event: null });
    expect(() => parseCustomerSalePurchaseWebhookEnvelope({ id: "D702930" })).toThrow(/exact VTiger/i);
  });

  it("resolves the Customer Sale C-number through one exact read-only lookup", async () => {
    candidateLookup.find.mockResolvedValueOnce({
      outcome: "found",
      sourceCategory: "container_control",
      businessNumber: "C1879",
      candidates: [{ recordId: "5x489279" }],
      message: "Exact VTiger candidate found",
    });
    await expect(resolveCustomerSalePurchaseRecordId("C1879")).resolves.toBe("5x489279");
    expect(candidateLookup.find).toHaveBeenCalledWith({ sourceCategory: "container_control", businessNumber: "C1879" });
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
