import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMainCustomerInvoiceWebhookEnvelope, registerMainCustomerInvoiceWebhook } from "./financialMainCustomerInvoiceWebhook";

afterEach(() => {
  delete process.env.FINANCIAL_AP_WEBHOOK_SECRET;
  delete process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED;
});

describe("Main Customer Invoice webhook contract", () => {
  it("accepts an exact Deal ID only and ignores all financial values in the body", () => {
    expect(parseMainCustomerInvoiceWebhookEnvelope({ deal_id: "5x702877", event: "customer-invoice.main-create", total: 1, customer: "Wrong" })).toEqual({ recordId: "5x702877", event: "customer-invoice.main-create" });
    expect(() => parseMainCustomerInvoiceWebhookEnvelope({ id: "D702877" })).toThrow(/exact VTiger Deal/i);
  });

  it("holds before any Deal/Quote source read or Xero write while the Main Invoice gate is off", async () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    const handlers = new Map<string, any>();
    registerMainCustomerInvoiceWebhook({ post: (path: string, handler: any) => handlers.set(path, handler) } as any);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handlers.get("/api/webhooks/vtiger/main-customer-invoice")({ header: () => "test-secret", body: { id: "5x702877" } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "main-customer-invoice-release-disabled", xeroWritesAttempted: 0 }));
  });
});
