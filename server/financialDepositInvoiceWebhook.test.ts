import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ process: vi.fn(), candidate: vi.fn(), report: vi.fn() }));
vi.mock("./financialDepositInvoiceService", () => ({
  DEPOSIT_INVOICE_WEBHOOK_PATH: "/api/webhooks/vtiger/deposit-invoice",
  processAutomaticDepositInvoice: m.process,
}));
vi.mock("./vtigerFinancialCandidateService", () => ({
  findExactFinancialCandidate: m.candidate,
}));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: m.report }));

import {
  parseDepositInvoiceWebhookEnvelope,
  registerDepositInvoiceWebhook,
  resolveDepositInvoiceWebhookRecord,
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
  it("accepts one exact Deal ID or legacy D-number and ignores forged financial values", () => {
    expect(
      parseDepositInvoiceWebhookEnvelope({
        deal_id: "5x77",
        depositStatus: "PAID",
        total: 1,
        dueDate: "forged",
        customer: "Wrong",
      })
    ).toEqual({ recordId: "5x77", dealNumber: null });
    expect(parseDepositInvoiceWebhookEnvelope({ id: "d77" })).toEqual({
      recordId: null,
      dealNumber: "D77",
    });
    for (const body of [
      { id: "D77", deal_id: "5x88" },
      { deal_id: 77 },
      { id: "wrong" },
      {},
      [],
    ])
      expect(() => parseDepositInvoiceWebhookEnvelope(body)).toThrow(
        /exact VTiger|exact named|arbitrary values/
      );
  });

  it("resolves a legacy D-number through exactly one bounded Deal lookup", async () => {
    m.candidate.mockResolvedValue({
      outcome: "found",
      candidates: [{ recordId: "5x77" }],
      message: "Exact match.",
    });
    await expect(
      resolveDepositInvoiceWebhookRecord({ recordId: null, dealNumber: "D77" })
    ).resolves.toBe("5x77");
    expect(m.candidate).toHaveBeenCalledWith({
      sourceCategory: "deal",
      businessNumber: "D77",
    });
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
    expect(m.candidate).not.toHaveBeenCalled();
  });

  it("holds before source, DB, Xero or alerts while disabled even if other gates are armed", async () => {
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
    expect(m.report).not.toHaveBeenCalled();
  });

  it("accepts the established JSON secret body while disabled without source, DB or Xero work", async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "private-test");
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "false");
    const res = response();
    await handler()(
      {
        header: () => undefined,
        body: { id: "D77", secret: "private-test", dryRun: true, amount: 1 },
      },
      res
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(m.candidate).not.toHaveBeenCalled();
    expect(m.process).not.toHaveBeenCalled();
  });

  it("passes only the named exact webservice ID to the dedicated family when armed", async () => {
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
    expect(m.report).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "deposit_invoice",
      recordKey: "deposit-invoice:5x77",
      details: { dealId: "5x77", status: "held" },
    }));
  });

  it("resolves the established D-number envelope before the isolated Deposit family runs", async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "private-test");
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    m.candidate.mockResolvedValue({
      outcome: "found",
      candidates: [{ recordId: "5x77" }],
      message: "Exact match.",
    });
    m.process.mockResolvedValue({
      ok: false,
      status: "held",
      xeroWritesAttempted: 0,
    });
    const res = response();
    await handler()(
      { header: () => undefined, body: { id: "D77", secret: "private-test" } },
      res
    );
    expect(m.process).toHaveBeenCalledWith("5x77");
  });
});
