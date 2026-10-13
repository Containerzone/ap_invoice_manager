import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ process: vi.fn(), policy: vi.fn(), assert: vi.fn(), candidate: vi.fn(), report: vi.fn() }));
vi.mock("./financialWarrantyAvisoService", () => ({ WARRANTY_WEBHOOK_PATH: "/api/webhooks/vtiger/warranty-aviso", processAutomaticWarrantyAviso: m.process }));
vi.mock("./financialWarrantyAvisoRelease", () => ({ getWarrantyReleasePolicy: m.policy, assertWarrantyRelease: m.assert }));
vi.mock("./vtigerFinancialCandidateService", () => ({ findExactFinancialCandidate: m.candidate }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: m.report }));
import { parseWarrantyEnvelope, registerWarrantyAvisoWebhook } from "./financialWarrantyAvisoWebhook";

const envelope = { id: "5x77" };
const handler = () => {
  let fn: any;
  registerWarrantyAvisoWebhook({ post: (path: string, cb: any) => { expect(path).toBe("/api/webhooks/vtiger/warranty-aviso"); fn = cb; } } as any);
  return fn;
};
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
const blockedPaths = () => expect(m.process).not.toHaveBeenCalled();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "synthetic-secret");
  vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "");
  m.policy.mockResolvedValue({ enabled: false });
  m.candidate.mockResolvedValue({ outcome: "found", candidates: [{ recordId: "5x77" }] });
});
afterEach(() => vi.unstubAllEnvs());

describe("Warranty canonical id/secret envelope parser", () => {
  it.each(["deal_id", "record_id", "id"])("accepts one exact %s without an event claim", key => {
    expect(parseWarrantyEnvelope({ [key]: "5x77" })).toBe("5x77");
  });
  it("accepts an exact D-number for bounded lookup after the release gate", () => expect(parseWarrantyEnvelope({ id: "D77" })).toBe("D77"));
  it("accepts agreeing aliases and ignores non-authoritative body claims", () => {
    expect(parseWarrantyEnvelope({ deal_id: "5x77", record_id: "5x77", id: "5x77", event: "anything", amount: 1, customer: "forged" })).toBe("5x77");
  });
  it.each([undefined, null, [], "warranty.aviso-requested", {}, { id: 77 }, { id: ["5x77"] }, { id: "5x77,5x88" }, { id: "5x1234567890123" }, { deal_id: "5x77", record_id: "5x88" }, { deal_id: "5x77", record_id: null }, { id: "D77", record_id: "D78" }])("rejects malformed or conflicting ids %j", body => {
    expect(() => parseWarrantyEnvelope(body)).toThrow(/One unambiguous exact Deal/);
  });
});

describe("Warranty protected default-off handler", () => {
  it.each([undefined, "", "bad", "synthetic-secreu"])("401 unauthenticated %s before any policy/service path", async secret => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    const res = response(); await handler()({ header: () => secret, body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(401); expect(m.policy).not.toHaveBeenCalled(); blockedPaths();
  });
  it("401 if the expected secret itself is absent", async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "");
    const res = response(); await handler()({ header: () => "", body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(401); expect(m.policy).not.toHaveBeenCalled(); blockedPaths();
  });
  it.each([undefined, "", "false", "TRUE", "1", " true "])("503 flag %s before parsing body or reading policy", async flag => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", flag);
    const req = { header: () => "synthetic-secret", get body() { throw new Error("Disabled handler must not parse body"); } };
    const res = response(); await handler()(req, res);
    expect(res.status).toHaveBeenCalledWith(503); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: "held", xeroWritesAttempted: 0 })); expect(m.policy).not.toHaveBeenCalled(); blockedPaths();
  });
  it.each(["invalid", "unavailable"])("503 %s policy before service", async failure => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    if (failure === "invalid") m.assert.mockImplementation(() => { throw new Error("Disabled policy"); });
    else m.policy.mockRejectedValue(new Error("Local config unavailable"));
    const res = response(); await handler()({ header: () => "synthetic-secret", body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(503); blockedPaths();
  });
  it("400 invalid id after both gates without processing", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    const res = response(); await handler()({ header: () => "synthetic-secret", body: { id: "bad" } }, res);
    expect(res.status).toHaveBeenCalledWith(400); blockedPaths();
  });
  it("resolves one exact D-number through the bounded candidate reader", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true"); m.process.mockResolvedValue({ ok: false, status: "held", xeroWritesAttempted: 0, warning: "mapping held" });
    const res = response(); await handler()({ header: () => "synthetic-secret", body: { id: "D77" } }, res);
    expect(m.candidate).toHaveBeenCalledWith({ sourceCategory: "deal", businessNumber: "D77" }); expect(m.process).toHaveBeenCalledWith("5x77"); expect(res.status).toHaveBeenCalledWith(202);
  });
  it("passes only an exact Deal to the service after both gates", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true"); m.process.mockResolvedValue({ ok: false, status: "held", xeroWritesAttempted: 0, warning: "source held" });
    const res = response(); await handler()({ header: () => "synthetic-secret", body: { id: "5x77", amount: 1, customer: "Forged" } }, res);
    expect(m.process).toHaveBeenCalledWith("5x77"); expect(res.status).toHaveBeenCalledWith(202); expect(m.report).toHaveBeenCalledWith(expect.objectContaining({ workflowType: "warranty-aviso", details: { dealId: "5x77", status: "held" } }));
  });
  it("uncertain service failure never falsely reports zero attempted writes", async () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true"); m.process.mockRejectedValue(new Error("Uncertain"));
    const res = response(); await handler()({ header: () => "synthetic-secret", body: envelope }, res);
    expect(res.status).toHaveBeenCalledWith(202); expect(res.json.mock.calls[0][0]).toMatchObject({ status: "reconciliation_required" }); expect(res.json.mock.calls[0][0]).not.toHaveProperty("xeroWritesAttempted");
  });
});
