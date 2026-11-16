import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ getDb: vi.fn(), policy: vi.fn(), assert: vi.fn(), opening: vi.fn(), verify: vi.fn(), ordinary: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.getDb }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: m.policy, assertForHireRelease: m.assert, assertForHireRecurringControlAllowed: m.assert }));
vi.mock("./financialForHireManualHandoverDb", () => ({ getManualForHireHandover: m.opening }));
vi.mock("./financialForHireManualHandoverService", () => ({ verifyManualForHireFirstWrite: m.verify }));
vi.mock("./financialForHireService", () => ({ verifyCurrentOrdinaryForHireDraft: m.ordinary }));
import { forHirePayloadHash, forHirePreviewVersion, verifyForHireAutomaticWriteAccess } from "./financialForHireDb";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { buildInitialForHirePo, buildRecurringForHirePo } from "./financialForHireDrafts";
import { financialSha256 } from "./financialProposalIntegrity";
const facts: any = { recordId: "24x1929", controlNumber: "C1929", acquisition: "FOR HIRE", status: "ON HIRE", containerNumber: "OFFLINE40", containerType: "40 FOOT", collectionDate: "2026-11-13", supplierVtigerId: "18x44", supplierName: "Offline supplier", monthlyCostInclusive: 264 };
let event: any;
function request(workflowType: "initial_for_hire" | "recurring_for_hire" = "recurring_for_hire") {
  const kind = workflowType === "initial_for_hire" ? "initial" : "recurring";
  const built = kind === "initial" ? buildInitialForHirePo(facts) : buildRecurringForHirePo({ facts, priorPeriodEnd: "2027-01-12", lastVerifiedExtensionSuffix: 2, purchaseRate: 12, now: "2027-01-13" });
  built.document!.partySourceId = "offline-contact";
  const payload = prepareFinancialDraftPayload(built.document!, `${facts.recordId}:${kind}:${built.periodStart}`);
  (payload.body.PurchaseOrders as any[])[0].CurrencyCode = "AUD";
  event = { id: 41, status: "reserved", containerControlId: facts.recordId, eventKind: kind, billingPeriodStart: built.periodStart, billingPeriodEnd: built.periodEnd,
    proposedPoNumber: built.proposedPoNumber, proposal: built.document, xeroPreflight: { offline: true }, xeroPreflightHash: financialSha256({ offline: true }),
    sourceSnapshotHash: "s".repeat(64), rulesSnapshotHash: "r".repeat(64), processingToken: "exclusive-token", releaseKey: "release" };
  event.authorisedPayload = { hash: forHirePayloadHash(payload), number: payload.documentNumber, bodyHash: financialSha256(payload.body),
    expectedPreview: forHirePreviewVersion(event), claimToken: event.processingToken };
  return { eventId: 41, releaseKey: "release", payload, workflowType, preparedBy: 7 };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "false");
  m.policy.mockResolvedValue({ releaseKey: "release", approvedBy: 7, recurringControlIds: ["24x1929"] }); m.assert.mockReturnValue(undefined);
  m.getDb.mockResolvedValue({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [event] }) }) }) });
  m.opening.mockResolvedValue(null); m.ordinary.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("immutable manual opening locks survive feature rollback", () => {
  it.each(["approved", "reserved", "reconciliation_required", "dehired"])("blocks an unbound ordinary For Hire write for %s even when the manual gate is false", async status => {
    m.opening.mockResolvedValue({ id: 9, status });
    await expect(verifyForHireAutomaticWriteAccess(request())).rejects.toThrow("manual opening point");
    expect(m.opening).toHaveBeenCalledWith("24x1929"); expect(m.verify).not.toHaveBeenCalled(); expect(m.ordinary).not.toHaveBeenCalled();
  });
  it("requires an exact AP successor link after the opening point completed", async () => {
    m.opening.mockResolvedValue({ id: 9, status: "completed" });
    await expect(verifyForHireAutomaticWriteAccess(request())).rejects.toThrow("exact verified AP successor link");
    await expect(verifyForHireAutomaticWriteAccess(request("initial_for_hire"))).rejects.toThrow("only verified AP recurring successors");
  });
  it("revalidates ordinary current facts/body evidence for a control without a manual opening point", async () => {
    const input = request("initial_for_hire");
    await expect(verifyForHireAutomaticWriteAccess(input)).resolves.toBeUndefined();
    expect(m.opening).toHaveBeenCalledOnce(); expect(m.ordinary).toHaveBeenCalledWith({ event, payload: input.payload, priorEventId: undefined });
  });
  it.each(["token", "proposal", "preflight", "body", "kind"])("rejects changed claimed %s despite an otherwise matching assigned payload hash", async field => {
    const input = request("initial_for_hire");
    if (field === "token") event.processingToken = "other";
    if (field === "proposal") event.proposal = { ...event.proposal, reference: "changed" };
    if (field === "preflight") event.xeroPreflight = { changed: true };
    if (field === "body") { (input.payload.body.PurchaseOrders as any[])[0].Reference = "changed"; event.authorisedPayload.hash = forHirePayloadHash(input.payload); }
    if (field === "kind") event.eventKind = "recurring";
    await expect(verifyForHireAutomaticWriteAccess(input)).rejects.toThrow(/claimed ledger preview/);
    expect(m.ordinary).not.toHaveBeenCalled();
  });
  it("rejects release of the claim during awaited final current-evidence checks", async () => {
    const input = request("initial_for_hire"); m.ordinary.mockImplementation(async () => { event.status = "held"; event.processingToken = null; });
    await expect(verifyForHireAutomaticWriteAccess(input)).rejects.toThrow(/changed during final/);
  });
  it("holds changed current-source/rate evidence at the transport guard, without adopting a new body", async () => {
    const input = request("initial_for_hire"); m.ordinary.mockRejectedValue(new Error("Current For Hire source changed before transport"));
    const before = structuredClone(input.payload);
    await expect(verifyForHireAutomaticWriteAccess(input)).rejects.toThrow(/source changed before transport/);
    expect(input.payload).toEqual(before);
  });
});
