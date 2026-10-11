import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  process: vi.fn(),
  policy: vi.fn(),
  assert: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("./financialExtraHireInvoiceService", () => ({
  EXTRA_HIRE_WEBHOOK_PATH: "/api/webhooks/vtiger/extra-hire-invoice",
  processAutomaticExtraHireInvoice: m.process,
}));
vi.mock("./financialExtraHireInvoiceRelease", () => ({
  getExtraHireReleasePolicy: m.policy,
  assertExtraHireRelease: m.assert,
}));
vi.mock("./workflowAlertService", () => ({
  reportWorkflowFailureSafely: m.alert,
}));
import {
  hasExtraHireSecret,
  parseExtraHireWebhookEnvelope,
  registerExtraHireInvoiceWebhook,
} from "./financialExtraHireInvoiceWebhook";
const handler = () => {
  let fn: any;
  registerExtraHireInvoiceWebhook({
    post: (path: string, cb: any) => {
      expect(path).toBe("/api/webhooks/vtiger/extra-hire-invoice");
      fn = cb;
    },
  } as any);
  return fn;
};
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
beforeEach(() => {
  vi.clearAllMocks();
  m.assert.mockReset();
  m.policy.mockResolvedValue({ enabled: false });
  vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "synthetic-secret");
});
afterEach(() => vi.unstubAllEnvs());
describe("Extra Hire dedicated private route", () => {
  it.each(["", "bad", "synthetic-secreu"])(
    "401 before policy/source/ledger/alerts for %s",
    async secret => {
      const res = response();
      await handler()({ header: () => secret, body: { deal_id: "5x77" } }, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(m.policy).not.toHaveBeenCalled();
      expect(m.process).not.toHaveBeenCalled();
      expect(m.alert).not.toHaveBeenCalled();
    }
  );
  it("accepts the existing VTiger JSON body secret and ignores dryRun", async () => {
    const res = response();
    await handler()(
      {
        header: () => undefined,
        body: { id: "5x77", secret: "synthetic-secret", dryRun: true },
      },
      res
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(m.policy).not.toHaveBeenCalled();
    expect(m.process).not.toHaveBeenCalled();
  });
  it("compares the legacy body secret without trusting other body values", () => {
    expect(
      hasExtraHireSecret({
        header: () => undefined,
        body: { secret: "synthetic-secret", amount: 9999, customer: "forged" },
      } as any)
    ).toBe(true);
    expect(
      hasExtraHireSecret({
        header: () => undefined,
        body: { secret: "wrong" },
      } as any)
    ).toBe(false);
  });
  it.each(["", "false", "TRUE", "1"])(
    "503 before any body/source/ledger/alert work while flag %s",
    async flag => {
      vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", flag);
      vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
      vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
      const res = response();
      await handler()(
        { header: () => "synthetic-secret", body: { amount: 999 } },
        res
      );
      expect(res.status).toHaveBeenCalledWith(503);
      expect(m.policy).not.toHaveBeenCalled();
      expect(m.process).not.toHaveBeenCalled();
      expect(m.alert).not.toHaveBeenCalled();
    }
  );
  it("flag true but invalid/missing policy returns 503 without source/local ledger/alerts", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.assert.mockImplementation(() => {
      throw new Error("Policy held");
    });
    const res = response();
    await handler()(
      { header: () => "synthetic-secret", body: { deal_id: "5x77" } },
      res
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(m.process).not.toHaveBeenCalled();
    expect(m.alert).not.toHaveBeenCalled();
  });
  it("policy lookup failure returns 503 without processing or alerts", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.policy.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = response();
    await handler()({ header: () => "synthetic-secret", body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(m.process).not.toHaveBeenCalled();
    expect(m.alert).not.toHaveBeenCalled();
  });
  it("passes exact ID only after valid flag and policy, ignores finance inputs", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.process.mockResolvedValue({
      ok: false,
      status: "held",
      xeroWritesAttempted: 0,
    });
    const res = response();
    await handler()(
      {
        header: () => "synthetic-secret",
        body: {
          deal_id: "5x77",
          total: 1,
          customer: "Forged",
          suffix: "D",
          hireEndDate: "2099-01-01",
        },
      },
      res
    );
    expect(m.process).toHaveBeenCalledWith("5x77");
    expect(res.status).toHaveBeenCalledWith(202);
  });
  it.each([
    {},
    [],
    { deal_id: "D77" },
    { deal_id: 77 },
    { id: "5x77", deal_id: "5x88" },
  ])("rejects ambiguous/non-ID envelope %j", body =>
    expect(() => parseExtraHireWebhookEnvelope(body)).toThrow(/exact named/)
  );
  it("unknown failure never falsely asserts zero transport attempts", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.process.mockRejectedValue(new Error("timeout"));
    const res = response();
    await handler()(
      { header: () => "synthetic-secret", body: { id: "5x77" } },
      res
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json.mock.calls[0][0]).not.toHaveProperty("xeroWritesAttempted");
  });
});
