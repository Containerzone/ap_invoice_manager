import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ process: vi.fn(), policy: vi.fn(), assert: vi.fn(), source: vi.fn(), xero: vi.fn() }));
vi.mock("./financialWarrantyAvisoService", () => ({ WARRANTY_WEBHOOK_PATH: "/api/webhooks/vtiger/warranty-aviso", processAutomaticWarrantyAviso: m.process }));
vi.mock("./financialWarrantyAvisoRelease", () => ({ getWarrantyReleasePolicy: m.policy, assertWarrantyRelease: m.assert }));
vi.mock("./financialWarrantyAvisoSource", () => ({ readWarrantyFacts: m.source }));
vi.mock("./financialWarrantyAvisoXero", () => ({ readWarrantyXeroEvidence: m.xero, readWarrantyDocument: vi.fn() }));
import { parseWarrantyEnvelope, registerWarrantyAvisoWebhook } from "./financialWarrantyAvisoWebhook";

const envelope = { event: "warranty.aviso-requested", deal_id: "5x77" };
const handler = () => {
  let fn: any;
  registerWarrantyAvisoWebhook({ post: (path: string, cb: any) => {
    expect(path).toBe("/api/webhooks/vtiger/warranty-aviso"); fn = cb;
  } } as any);
  return fn;
};
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const blockedPaths = () => {
  expect(m.process).not.toHaveBeenCalled();
  expect(m.source).not.toHaveBeenCalled();
  expect(m.xero).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "synthetic-secret");
  vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "");
  m.policy.mockResolvedValue({ enabled: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("Warranty-only envelope parser", () => {
  it.each(["deal_id", "record_id", "id"])("accepts exact event and single %s", key => {
    expect(parseWarrantyEnvelope({ event: envelope.event, [key]: "5x77" })).toBe("5x77");
  });
  it("agreeing aliases identify only one Deal; financial payload and Warranty Confirmed grant nothing", () => {
    expect(parseWarrantyEnvelope({ ...envelope, record_id: "5x77", id: "5x77", total: 1, warrantyConfirmed: true })).toBe("5x77");
  });
  it.each([
    undefined, null, [], "warranty.aviso-requested", {}, { deal_id: "5x77" },
    { ...envelope, event: "warranty.confirmed" }, { ...envelope, event: "Warranty.aviso-requested" },
    { ...envelope, event: "warranty.aviso-requested " }, { ...envelope, deal_id: "D77" },
    { ...envelope, deal_id: 77 }, { ...envelope, deal_id: ["5x77"] }, { ...envelope, deal_id: "5x77,5x88" },
    { ...envelope, deal_id: "5x1234567890123" }, { ...envelope, record_id: "5x88" },
    { ...envelope, record_id: null }, { ...envelope, id: "5x88" },
  ])("rejects nonexact event, malformed or conflicting IDs %j", body => {
    expect(() => parseWarrantyEnvelope(body)).toThrow(/Warranty-only event and one exact/);
  });
});

describe("Warranty private default-off handler", () => {
  it.each([undefined, "", "bad", "synthetic-secreu"])("401 unauthenticated %s before any policy/service/source/Xero path", async secret => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    const res = response();
    await handler()({ header: () => secret, body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(m.policy).not.toHaveBeenCalled(); expect(m.assert).not.toHaveBeenCalled(); blockedPaths();
  });
  it("401 if the expected secret itself is absent", async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "");
    const res = response(); await handler()({ header: () => "", body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(401); expect(m.policy).not.toHaveBeenCalled(); blockedPaths();
  });
  it.each([undefined, "", "false", "TRUE", "1", " true "])("503 flag %s before even parsing body or reading policy", async flag => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", flag);
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    const req = { header: () => "synthetic-secret", get body() { throw new Error("Disabled handler must not parse body"); } };
    const res = response(); await handler()(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "held", xeroWritesAttempted: 0 }));
    expect(m.policy).not.toHaveBeenCalled(); expect(m.assert).not.toHaveBeenCalled(); blockedPaths();
  });
  it.each(["invalid", "unavailable"])("503 %s policy before service/source/Xero", async failure => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    if (failure === "invalid") m.assert.mockImplementation(() => { throw new Error("Disabled policy"); });
    else m.policy.mockRejectedValue(new Error("Local config unavailable"));
    const res = response(); await handler()({ header: () => "synthetic-secret", body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(503); blockedPaths();
  });
  it("400 invalid event after gates without processing", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    const res = response(); await handler()({ header: () => "synthetic-secret", body: { deal_id: "5x77" } }, res);
    expect(res.status).toHaveBeenCalledWith(400); blockedPaths();
  });
  it("passes only the exact Deal to the mocked service after both gates", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    m.process.mockResolvedValue({ ok: false, status: "held", xeroWritesAttempted: 0 });
    const res = response(); await handler()({ header: () => "synthetic-secret", body: { ...envelope, amount: 1, customer: "Forged" } }, res);
    expect(m.process).toHaveBeenCalledWith("5x77"); expect(res.status).toHaveBeenCalledWith(202);
  });
  it("uncertain service failure never falsely reports zero attempted writes", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    m.process.mockRejectedValue(new Error("Uncertain"));
    const res = response(); await handler()({ header: () => "synthetic-secret", body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json.mock.calls[0][0]).toMatchObject({ status: "reconciliation_required" });
    expect(res.json.mock.calls[0][0]).not.toHaveProperty("xeroWritesAttempted");
  });
});
