import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  process: vi.fn(),
  getPolicy: vi.fn(),
  assertPolicy: vi.fn(),
  exactCandidate: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("./financialMainCustomerInvoiceService", async original => ({
  ...(await original<typeof import("./financialMainCustomerInvoiceService")>()),
  processAutomaticMainCustomerInvoice: mocks.process,
}));
vi.mock("./financialMainCustomerInvoiceRelease", async original => ({
  ...(await original<typeof import("./financialMainCustomerInvoiceRelease")>()),
  getMainCustomerInvoiceReleasePolicy: mocks.getPolicy,
  assertMainCustomerInvoiceRelease: mocks.assertPolicy,
}));
vi.mock("./vtigerFinancialCandidateService", () => ({
  findExactFinancialCandidate: mocks.exactCandidate,
}));
vi.mock("./workflowAlertService", () => ({
  reportWorkflowFailureSafely: mocks.alert,
}));

import {
  hasMainCustomerInvoiceWebhookSecret,
  parseMainCustomerInvoiceWebhookEnvelope,
  registerMainCustomerInvoiceWebhook,
  resolveMainCustomerInvoiceWebhookRecord,
  safeMainCustomerInvoiceWebhookFailure,
} from "./financialMainCustomerInvoiceWebhook";

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
}

function registeredHandler() {
  const handlers = new Map<string, any>();
  registerMainCustomerInvoiceWebhook({
    post: (path: string, handler: any) => handlers.set(path, handler),
  } as any);
  return handlers.get("/api/webhooks/vtiger/main-customer-invoice");
}

afterEach(() => {
  delete process.env.FINANCIAL_AP_WEBHOOK_SECRET;
  delete process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET;
  delete process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPolicy.mockResolvedValue({});
  mocks.exactCandidate.mockResolvedValue({
    outcome: "found",
    candidates: [{ recordId: "5x702877" }],
    message: "exact match",
  });
  mocks.process.mockResolvedValue({
    ok: true,
    status: "drafts_created",
    recordId: "5x702877",
    xeroWritesAttempted: 1,
  });
});

describe("Main Customer Invoice webhook contract", () => {
  it("accepts one exact webservice ID or legacy D-number and ignores financial body values", () => {
    expect(
      parseMainCustomerInvoiceWebhookEnvelope({
        id: "5x702877",
        event: "customer-invoice.main-create",
        total: 1,
        customer: "Wrong",
      })
    ).toEqual({
      recordId: "5x702877",
      dealNumber: null,
      event: "customer-invoice.main-create",
    });
    expect(parseMainCustomerInvoiceWebhookEnvelope({ id: "D702877" })).toEqual({
      recordId: null,
      dealNumber: "D702877",
      event: null,
    });
    expect(() =>
      parseMainCustomerInvoiceWebhookEnvelope({ id: "D702877", deal_id: "5x2" })
    ).toThrow(/conflicting/i);
  });

  it("accepts the established VTiger JSON body-secret without exposing it", () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    expect(
      hasMainCustomerInvoiceWebhookSecret({
        header: () => undefined,
        body: { id: "5x702877", secret: "test-secret", dryRun: true },
      } as any)
    ).toBe(true);
    expect(
      hasMainCustomerInvoiceWebhookSecret({
        header: () => undefined,
        body: { id: "5x702877", secret: "wrong" },
      } as any)
    ).toBe(false);
  });

  it("accepts the Main Invoice-specific secret without rotating the shared secret", () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "shared-secret";
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET =
      "main-invoice-secret";
    expect(
      hasMainCustomerInvoiceWebhookSecret({
        header: () => undefined,
        body: { id: "D702877", secret: "main-invoice-secret" },
      } as any)
    ).toBe(true);
    expect(
      hasMainCustomerInvoiceWebhookSecret({
        header: () => undefined,
        body: { id: "D702877", secret: "shared-secret" },
      } as any)
    ).toBe(true);
    expect(
      hasMainCustomerInvoiceWebhookSecret({
        header: () => undefined,
        body: { id: "D702877", secret: "wrong" },
      } as any)
    ).toBe(false);
  });

  it("holds before any Deal/Quote source read or Xero write while the Main Invoice gate is off", async () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    const res = response();
    await registeredHandler()(
      {
        header: () => undefined,
        body: { id: "D702877", secret: "test-secret", dryRun: true },
      },
      res
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "main-customer-invoice-release-disabled",
        xeroWritesAttempted: 0,
      })
    );
    expect(mocks.exactCandidate).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("resolves a legacy D-number only after a valid release, then processes its exact Deal", async () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED = "true";
    const res = response();
    await registeredHandler()(
      {
        header: () => undefined,
        body: { id: "D702877", secret: "test-secret", dryRun: true },
      },
      res
    );
    expect(mocks.assertPolicy).toHaveBeenCalledWith({});
    expect(mocks.exactCandidate).toHaveBeenCalledWith({
      sourceCategory: "deal",
      businessNumber: "D702877",
    });
    expect(mocks.process).toHaveBeenCalledWith("5x702877");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("holds an ambiguous D-number without calling the Draft coordinator", async () => {
    mocks.exactCandidate.mockResolvedValue({
      outcome: "ambiguous",
      candidates: [{ recordId: "5x1" }, { recordId: "5x2" }],
      message: "two exact candidates",
    });
    await expect(
      resolveMainCustomerInvoiceWebhookRecord({
        recordId: null,
        dealNumber: "D702877",
        event: null,
      })
    ).rejects.toThrow(/ambiguous/i);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("keeps the post-contact failure cause in the held response and alert while redacting a configured secret", async () => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "webhook-secret";
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED = "true";
    mocks.process.mockRejectedValue(new Error("VTiger GET getchallenge failed with ECONNRESET; token=webhook-secret"));
    const res = response();

    await registeredHandler()(
      { header: () => undefined, body: { id: "5x702877", secret: "webhook-secret" } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "held",
      warning: "VTiger GET getchallenge failed with ECONNRESET; token=[REDACTED]",
      xeroWritesAttempted: 0,
    }));
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: "VTiger GET getchallenge failed with ECONNRESET; token=[REDACTED]",
    }));
  });

  it("redacts Bearer credentials and bounds an unexpected failure message", () => {
    expect(safeMainCustomerInvoiceWebhookFailure(new Error("upstream Authorization: Bearer token-value\nfailed")))
      .toBe("upstream Authorization: Bearer [REDACTED] failed");
    expect(safeMainCustomerInvoiceWebhookFailure(new Error("x".repeat(501)))).toHaveLength(500);
  });

  it.each(["disabled", "not_ready", "held", "reconciliation_required"])("durably alerts the exact deduction %s while keeping Main creation HTTP 200", async status => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED = "true";
    const reason = `Exact deduction ${status} reason`;
    mocks.process.mockResolvedValue({ ok: true, status: "drafts_created", mainDeduction: { status, reason, xeroWritesAttempted: 0 } });
    const res = response();
    await registeredHandler()({ header: () => undefined, body: { id: "5x702877", secret: "test-secret" } }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ workflowType: "deposit_main_deduction", errorMessage: reason, details: { dealId: "5x702877", status, reason, trigger: "main" } }));
  });

  it.each(["deducted", "already_deducted"])("does not alert a successful deduction outcome %s", async status => {
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED = "true";
    mocks.process.mockResolvedValue({ ok: true, status: "drafts_created", mainDeduction: { status, reason: "completed", xeroWritesAttempted: 0 } });
    const res = response();
    await registeredHandler()({ header: () => undefined, body: { id: "5x702877", secret: "test-secret" } }, res);
    expect(res.status).toHaveBeenCalledWith(200); expect(mocks.alert).not.toHaveBeenCalled();
  });
});
