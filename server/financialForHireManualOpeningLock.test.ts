import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ getDb: vi.fn(), policy: vi.fn(), assert: vi.fn(), opening: vi.fn(), verify: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.getDb }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: m.policy, assertForHireRelease: m.assert }));
vi.mock("./financialForHireManualHandoverDb", () => ({ getManualForHireHandover: m.opening }));
vi.mock("./financialForHireManualHandoverService", () => ({ verifyManualForHireFirstWrite: m.verify }));
import { forHirePayloadHash, verifyForHireAutomaticWriteAccess } from "./financialForHireDb";
const payload = { method: "POST", endpoint: "/PurchaseOrders", documentFamily: "purchase_order", documentNumber: "HC1929-3", idempotencyKey: "offline-key", expectedXeroDocumentId: null, body: { PurchaseOrders: [{ Status: "DRAFT" }] } } as any;
const event = { id: 41, status: "reserved", containerControlId: "24x1929", processingToken: "exclusive-token", releaseKey: "release", authorisedPayload: { hash: forHirePayloadHash(payload), number: payload.documentNumber } };
const request = (workflowType: "initial_for_hire" | "recurring_for_hire" = "recurring_for_hire") => ({ eventId: 41, releaseKey: "release", payload, workflowType, preparedBy: 7 });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "false");
  m.policy.mockResolvedValue({ releaseKey: "release", approvedBy: 7 }); m.assert.mockReturnValue(undefined);
  m.getDb.mockResolvedValue({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [event] }) }) }) });
  m.opening.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
describe("immutable manual opening locks survive feature rollback", () => {
  it.each(["approved", "reserved", "reconciliation_required", "dehired"])("blocks an unbound ordinary For Hire write for %s even when the manual gate is false", async status => {
    m.opening.mockResolvedValue({ id: 9, status });
    await expect(verifyForHireAutomaticWriteAccess(request())).rejects.toThrow("manual opening point");
    expect(m.opening).toHaveBeenCalledWith("24x1929"); expect(m.verify).not.toHaveBeenCalled();
  });
  it("allows only recurring AP successors after the opening point completed", async () => {
    m.opening.mockResolvedValue({ id: 9, status: "completed" });
    await expect(verifyForHireAutomaticWriteAccess(request())).resolves.toBeUndefined();
    await expect(verifyForHireAutomaticWriteAccess(request("initial_for_hire"))).rejects.toThrow("only verified AP recurring successors");
  });
  it("does not change a control without a manual opening point", async () => {
    await expect(verifyForHireAutomaticWriteAccess(request("initial_for_hire"))).resolves.toBeUndefined();
    expect(m.opening).toHaveBeenCalledOnce();
  });
});
