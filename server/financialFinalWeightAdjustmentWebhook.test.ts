import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ process: vi.fn(), policy: vi.fn(), report: vi.fn(), candidate: vi.fn() }));
vi.mock("./financialFinalWeightAdjustmentService", () => ({ processAutomaticFinalWeightAdjustment: m.process }));
vi.mock("./financialFinalWeightAdjustmentRelease", async original => ({ ...(await original<any>()), getFinalWeightReleasePolicy: m.policy }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: m.report }));
vi.mock("./vtigerFinancialCandidateService", () => ({ findExactFinancialCandidate: m.candidate }));
import { parseFinalWeightEnvelope, registerFinalWeightAdjustmentWebhooks, resolveFinalWeightWebhookRecord } from "./financialFinalWeightAdjustmentWebhook";
import { assertFinalWeightRelease, resolveFinalWeightRelease } from "./financialFinalWeightAdjustmentRelease";
import { FINAL_WEIGHT_PATHS } from "./financialFinalWeightAdjustmentRules";
import { policy } from "./_test/finalWeightFixtures";
const response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() });
function handler(direction: "overweight" | "underweight") { const handlers = new Map<string, any>(); registerFinalWeightAdjustmentWebhooks({ post: (path: string, callback: any) => handlers.set(path, callback) } as any); return handlers.get(FINAL_WEIGHT_PATHS[direction]); }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "private-test"); m.policy.mockResolvedValue(policy()); m.process.mockResolvedValue({ ok: false, status: "held", xeroWritesAttempted: 0 }); m.candidate.mockResolvedValue({ outcome: "found", candidates: [{ recordId: "5x77" }], message: "exact" }); });
afterEach(() => vi.unstubAllEnvs());
describe("Final weight independent default-off dual release", () => {
  it("defaults off and never inherits Main/global release", () => {
    vi.stubEnv("FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED", "true"); vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true"); vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "");
    expect(resolveFinalWeightRelease(null).enabled).toBe(false);
    expect(() => assertFinalWeightRelease(policy(), "overweight")).toThrow(/release disabled/);
  });
  it.each(["enabled", "overweightVtigerBranch", "underweightVtigerBranch", "operationsOverweightHandoff", "operationsUnderweightHandoff", "sourceMappingsConfirmed", "draftOnlyUpdateApproved"])("requires %s for BOTH routes", key => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true");
    for (const direction of ["overweight", "underweight"] as const) expect(() => assertFinalWeightRelease(policy({ [key]: false }), direction)).toThrow();
  });
  it.each([{ rulesHash: "wrong" }, { releaseKey: "main-release" }, { approvedBy: null }, { approvedAt: "bad" }, { approvedAt: "2099-01-01" }, { effectiveFrom: "2099-01-01" }, { migrationScope: "historical" }])("fails shut on stale/incomplete approval %#", patch => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true");
    expect(() => assertFinalWeightRelease(resolveFinalWeightRelease(policy(patch)), "overweight")).toThrow();
  });
  it("accepts one unambiguous exact webservice Deal ID or D-number and ignores forged finance/direction", () => {
    expect(parseFinalWeightEnvelope({ id: "5x77", record_id: "5x77", total: -100, direction: "underweight", DueDate: "forged" })).toEqual({ recordId: "5x77", dealNumber: null });
    expect(parseFinalWeightEnvelope({ id: "d702915", amount: -1 })).toEqual({ recordId: null, dealNumber: "D702915" });
    for (const body of [{ id: "D-77" }, { id: "5x77", deal_id: "5x88" }, { id: 77 }, [], {}]) expect(() => parseFinalWeightEnvelope(body)).toThrow();
  });
  it("resolves a legacy D-number only through one exact bounded candidate lookup", async () => {
    await expect(resolveFinalWeightWebhookRecord({ recordId: null, dealNumber: "D702915" })).resolves.toBe("5x77");
    expect(m.candidate).toHaveBeenCalledWith({ sourceCategory: "deal", businessNumber: "D702915" });
    m.candidate.mockResolvedValueOnce({ outcome: "ambiguous", candidates: [{ recordId: "5x77" }, { recordId: "5x78" }], message: "multiple" });
    await expect(resolveFinalWeightWebhookRecord({ recordId: null, dealNumber: "D702915" })).rejects.toThrow(/ambiguous/);
  });
  it.each(["overweight", "underweight"] as const)("%s unauthenticated is 401 before policy/source/DB/Xero calls", async direction => {
    for (const secret of ["", "wrong", "private-tess"]) { const res = response(); await handler(direction)({ header: () => secret, body: { id: "5x77" } }, res); expect(res.status).toHaveBeenCalledWith(401); }
    expect(m.policy).not.toHaveBeenCalled(); expect(m.process).not.toHaveBeenCalled();
  });
  it.each(["overweight", "underweight"] as const)("%s accepts the existing VTiger JSON secret envelope and still holds while disabled", async direction => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", ""); const res = response();
    await handler(direction)({ header: () => "", body: { id: "5x77", secret: "private-test", dryRun: true, amount: -999 } }, res);
    expect(res.status).toHaveBeenCalledWith(503); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ direction, xeroWritesAttempted: 0 }));
    expect(m.policy).not.toHaveBeenCalled(); expect(m.process).not.toHaveBeenCalled(); expect(m.report).not.toHaveBeenCalled();
  });
  it.each(["overweight", "underweight"] as const)("%s rejects an incorrect VTiger JSON secret before policy/source/DB/Xero calls", async direction => {
    const res = response(); await handler(direction)({ header: () => "", body: { id: "5x77", secret: "wrong", dryRun: true } }, res);
    expect(res.status).toHaveBeenCalledWith(401); expect(m.policy).not.toHaveBeenCalled(); expect(m.process).not.toHaveBeenCalled();
  });
  it.each(["overweight", "underweight"] as const)("%s unset flag is authenticated 503 with zero DB/upstream impact", async direction => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", ""); const res = response();
    await handler(direction)({ header: () => "private-test", body: { deal_id: "5x77", amount: 999 } }, res);
    expect(res.status).toHaveBeenCalledWith(503); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ direction, xeroWritesAttempted: 0 }));
    expect(m.policy).not.toHaveBeenCalled(); expect(m.process).not.toHaveBeenCalled();
  });
  it("holds a legacy D-number while disabled before candidate lookup", async () => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", ""); const res = response();
    await handler("overweight")({ header: () => "private-test", body: { id: "D702915" } }, res);
    expect(res.status).toHaveBeenCalledWith(503); expect(m.candidate).not.toHaveBeenCalled(); expect(m.process).not.toHaveBeenCalled();
  });
  it.each(["overweight", "underweight"] as const)("%s missing policy holds 503 without ledger/upstream work even with flag true", async direction => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); m.policy.mockResolvedValue(resolveFinalWeightRelease(null)); const res = response();
    await handler(direction)({ header: () => "private-test", body: { id: "5x77" } }, res);
    expect(res.status).toHaveBeenCalledWith(503); expect(m.process).not.toHaveBeenCalled();
  });
  it.each(["overweight", "underweight"] as const)("%s protected receiver passes only current route direction and id", async direction => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); const res = response();
    await handler(direction)({ header: () => "private-test", body: { id: "5x77", direction: direction === "overweight" ? "underweight" : "overweight", total: -1 } }, res);
    expect(m.process).toHaveBeenCalledWith("5x77", direction); expect(res.status).toHaveBeenCalledWith(202);
    expect(m.report).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "final_weight_adjustment", recordKey: `final-weight:${direction}:5x77`, details: { direction, dealId: "5x77", status: "held" },
    }));
  });
  it("resolves an active legacy D-number before passing only the exact record ID to the protected writer", async () => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); const res = response();
    await handler("overweight")({ header: () => "private-test", body: { id: "D702915" } }, res);
    expect(m.candidate).toHaveBeenCalledWith({ sourceCategory: "deal", businessNumber: "D702915" });
    expect(m.process).toHaveBeenCalledWith("5x77", "overweight");
  });
  it("rejects malformed authenticated body without any policy/source read", async () => { const res = response(); await handler("overweight")({ header: () => "private-test", body: { id: "D-77" } }, res); expect(res.status).toHaveBeenCalledWith(400); expect(m.policy).not.toHaveBeenCalled(); });
});
