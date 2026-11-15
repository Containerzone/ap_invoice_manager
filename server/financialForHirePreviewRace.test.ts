import { beforeEach, describe, expect, it, vi } from "vitest";
import { financialForHirePoEvents as events, financialForHireManualHandovers as openings } from "../drizzle/schema";
import { offlineDb, offlineMixedFixture, offlinePreviewClaim } from "./financialForHireMixedTestSupport";
import { financialSha256 } from "./financialProposalIntegrity";
const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
import { claimForHirePreview, recordForHirePreview } from "./financialForHireDb";

const proposal = {
  containerControlId: "test-control", containerControlNumber: "C1929", eventKind: "recurring" as const,
  billingPeriodStart: "2026-12-14", billingPeriodEnd: "2027-01-12", proposedPoNumber: "HC1929-2",
  containerNumber: "TEST40", containerType: "40 Foot Standard", supplierVtigerId: "test-vendor", supplierName: "Test supplier",
  sourceRefreshedAt: null, sourceSnapshotHash: "new-source", rulesSnapshotHash: "test-rules", xeroPreflightHash: financialSha256({ offline: true }),
  proposal: { unitAmount: 20 }, xeroPreflight: { offline: true }, status: "previewed" as const, holdReason: null,
};
beforeEach(() => vi.resetAllMocks());

describe("control-locked For Hire preview protection", () => {
  it.each(["reserved", "drafts_created", "reconciliation_required"])("cannot refresh a terminal/claimed %s row or re-claim it", async status => {
    const row = { ...proposal, id: 50, status, processingToken: status === "reserved" ? "owner-A" : null,
      executionId: 77, xeroPurchaseOrderId: status === "drafts_created" ? "verified-po" : null, proposal: { unitAmount: 10 },
      holdReason: status === "reconciliation_required" ? "Uncertain write evidence" : null };
    const h = offlineDb([row]); mocks.getDb.mockResolvedValue(h.db); const before = structuredClone(h.state);
    expect(await recordForHirePreview(proposal)).toEqual(row);
    expect(await claimForHirePreview(50, "owner-B", offlinePreviewClaim(row))).toBe(false);
    expect(h.state).toEqual(before);
    expect(h.log.filter(row => ["insert", "update"].includes(row.operation))).toEqual([]);
  });

  it("refreshes only unclaimed previews and leaves financial receipt/due fields outside the update", async () => {
    const h = offlineDb([{ ...proposal, id: 50, proposal: { unitAmount: 10 }, nextBillingDate: "2027-01-13", executionId: null }]); mocks.getDb.mockResolvedValue(h.db);
    expect((await recordForHirePreview(proposal)).proposal).toEqual({ unitAmount: 20 });
    const values = h.log.find(row => row.operation === "update")!.values;
    for (const field of ["executionId", "xeroPurchaseOrderId", "processingToken", "nextBillingDate", "manualOpeningPoint"]) expect(values).not.toHaveProperty(field);
    expect(h.state.events[0].nextBillingDate).toBe("2027-01-13");
    expect(h.log.filter(row => row.operation === "lock:update").map(row => row.table)).toEqual([events, openings, events]);
  });

  it.each(["initial", "recurring"] as const)("rejects caller A %s claim after preview B refresh, while B remains valid", async eventKind => {
    const a = { ...proposal, eventKind, proposal: { unitAmount: 10 }, sourceSnapshotHash: "source-A" };
    const h = offlineDb(); mocks.getDb.mockResolvedValue(h.db);
    const savedA = await recordForHirePreview(a); const expectedA = offlinePreviewClaim(savedA);
    const savedB = await recordForHirePreview({ ...a, sourceSnapshotHash: "source-B", proposal: { unitAmount: 20 } });
    expect(await claimForHirePreview(savedA.id, "A", expectedA)).toBe(false);
    expect(h.state.events[0].processingToken).toBeNull();
    expect(await claimForHirePreview(savedB.id, "B", offlinePreviewClaim(savedB))).toBe(true);
    expect(h.state.events[0]).toMatchObject({ status: "reserved", processingToken: "B", proposal: { unitAmount: 20 } });
  });

  it.each(["sourceSnapshotHash", "rulesSnapshotHash", "xeroPreflightHash", "proposalHash", "containerControlId", "eventKind", "billingPeriodStart", "billingPeriodEnd", "proposedPoNumber"])("rejects a mismatched expected %s before claim", async field => {
    const h = offlineDb([{ ...proposal, id: 50 }]); mocks.getDb.mockResolvedValue(h.db);
    const expected = offlinePreviewClaim(h.state.events[0]); (expected.expectedPreview as any)[field] = "different";
    expect(await claimForHirePreview(50, "wrong", expected)).toBe(false);
    expect(h.state.events[0].status).toBe("previewed");
  });

  it("rejects stale ordinary preview persistence after enrollment even when it would create a different period/number", async () => {
    const f = offlineMixedFixture(); const h = offlineDb([f.ap], [f.opening]); mocks.getDb.mockResolvedValue(h.db);
    const stale = { ...proposal, containerControlId: f.facts.recordId, proposedPoNumber: "HC1920-2", billingPeriodStart: "2026-11-16", billingPeriodEnd: "2026-12-15" };
    const before = structuredClone(h.state);
    await expect(recordForHirePreview(stale)).rejects.toThrow(/exact verified manual opening/);
    expect(h.state).toEqual(before); expect(h.log.filter(row => row.operation === "insert")).toEqual([]);
  });

  it.each(["id", "hash", "period", "number", "initial"])("rejects manual preview with wrong %s without inserts or history mutation", async kind => {
    const f = offlineMixedFixture(); const h = offlineDb([f.ap], [f.opening]); mocks.getDb.mockResolvedValue(h.db);
    const input: any = { ...proposal, containerControlId: f.facts.recordId, billingPeriodStart: f.plan.nextPeriodStart, billingPeriodEnd: f.plan.nextPeriodEnd,
      proposedPoNumber: f.plan.nextPoNumber, manualOpeningPoint: { id: f.opening.id, planHash: f.plan.planHash } };
    if (kind === "id") input.manualOpeningPoint.id++;
    if (kind === "hash") input.manualOpeningPoint.planHash = "wrong";
    if (kind === "period") input.billingPeriodEnd = "2027-01-01";
    if (kind === "number") input.proposedPoNumber = "HC1920-3";
    if (kind === "initial") input.eventKind = "initial";
    const before = structuredClone(h.state); await expect(recordForHirePreview(input)).rejects.toThrow(/exact verified manual opening/);
    expect(h.state).toEqual(before); expect(h.log.filter(row => row.operation === "insert")).toEqual([]);
  });

  it("allows only the verified manual opening's exact next preview and rejects any local number owned by another period", async () => {
    const f = offlineMixedFixture(); const h = offlineDb([f.ap], [f.opening]); mocks.getDb.mockResolvedValue(h.db);
    const input = { ...proposal, containerControlId: f.facts.recordId, billingPeriodStart: f.plan.nextPeriodStart, billingPeriodEnd: f.plan.nextPeriodEnd,
      proposedPoNumber: f.plan.nextPoNumber, manualOpeningPoint: { id: f.opening.id, planHash: f.plan.planHash } };
    const result = await recordForHirePreview(input); expect(result.proposedPoNumber).toBe("HC1920-2");
    expect(h.state.events[0]).toEqual(f.ap); expect(h.state.openings[0]).toEqual(f.opening);
    const h2 = offlineDb([{ ...proposal, id: 20, billingPeriodStart: "2026-11-14" }]); mocks.getDb.mockResolvedValue(h2.db);
    await expect(recordForHirePreview(proposal)).rejects.toThrow(/different AP-local event/);
    expect(h2.state.events).toHaveLength(1);
  });
});
