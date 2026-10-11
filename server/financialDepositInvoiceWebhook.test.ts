import { afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("./financialDepositInvoiceService", () => ({
  DEPOSIT_INVOICE_WEBHOOK_PATH: "/api/webhooks/vtiger/deposit-invoice",
  processAutomaticDepositInvoice: m.process,
}));
import {
  parseDepositInvoiceWebhookEnvelope,
  registerDepositInvoiceWebhook,
} from "./financialDepositInvoiceWebhook";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function handler() {
  const handlers = new Map<string, any>();
  registerDepositInvoiceWebhook({
    post: (path: string, callback: any) => handlers.set(path, callback),
  } as any);
  return handlers.get("/api/webhooks/vtiger/deposit-invoice");
}
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
describe("Deposit dedicated protected webhook", () => {
  it("accepts one exact Deal ID and ignores forged financial values", () => {
    expect(
      parseDepositInvoiceWebhookEnvelope({
        deal_id: "5x77",
        depositStatus: "PAID",
        total: 1,
        dueDate: "forged",
        customer: "Wrong",
      })
    ).toEqual({ recordId: "5x77" });
    for (const body of [
      { id: "D77" },
      { id: "5x77", deal_id: "5x88" },
      { deal_id: 77 },
      {},
      [],
    ])
      expect(() => parseDepositInvoiceWebhookEnvelope(body)).toThrow(
        /exact VTiger|exact named/
      );
  });
  it("rejects invalid or missing private auth with 401 before source, DB or Xero work", async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "private-test");
    for (const supplied of ["", "wrong", "private-tess"]) {
      const res = response();
      await handler()(
        { header: () => supplied, body: { deal_id: "5x77" } },
        res
      );
      expect(res.status).toHaveBeenCalledWith(401);
    }
    expect(m.process).not.toHaveBeenCalled();
  });
  it("holds before any source, DB, Xero or alerts while disabled even if global or other family gates are armed", async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "private-test");
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "false");
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    vi.stubEnv("FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED", "true");
    const res = response();
    await handler()(
      { header: () => "private-test", body: { deal_id: "5x77", amount: 1 } },
      res
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "held",
        error: "deposit-invoice-release-disabled",
        xeroWritesAttempted: 0,
      })
    );
    expect(m.process).not.toHaveBeenCalled();
  });
  it("passes only the named ID to the dedicated family when independently armed", async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "private-test");
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    m.process.mockResolvedValue({
      ok: false,
      status: "held",
      xeroWritesAttempted: 0,
    });
    const res = response();
    await handler()(
      { header: () => "private-test", body: { record_id: "5x77", total: 1 } },
      res
    );
    expect(m.process).toHaveBeenCalledWith("5x77");
    expect(res.status).toHaveBeenCalledWith(202);
  });
});
