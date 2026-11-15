import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { financialForHireManualHandovers as openings, financialForHirePoEvents as events } from "../drizzle/schema";
import { offlineDb, offlineMixedFixture, offlinePreviewClaim } from "./financialForHireMixedTestSupport";
const m = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
import { claimForHirePreview, completeForHireDraft, dueForHireRecurringRoots, holdForHireExecution } from "./financialForHireDb";
import { claimManualForHireHandover, holdManualForHireHandover } from "./financialForHireManualHandoverDb";
const dialect = new MySqlDialect();
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "true"); });
afterEach(() => vi.unstubAllEnvs());
async function reservedFixture(withAnchor = true) {
  const f = offlineMixedFixture(withAnchor); const h = offlineDb(withAnchor ? [f.ap, f.first] : [f.first], [f.opening]); m.db.mockResolvedValue(h.db);
  expect(await claimForHirePreview(f.first.id, "token", offlinePreviewClaim(f.first, { manualHandoverId: 9, manualHandoverPlanHash: f.plan.planHash }))).toBe(true);
  expect(await claimManualForHireHandover({ id: 9, planHash: f.plan.planHash, token: "token", eventId: f.first.id })).toBe(true);
  const input = { eventId: f.first.id, executionId: 101, xeroPurchaseOrderId: "offline-next", nextBillingDate: "2027-01-15", priorEventId: f.plan.priorApAnchor?.id ?? null,
    token: "token", manualOpeningPoint: { id: 9, planHash: f.plan.planHash, token: "token" } };
  return { ...f, ...h, input };
}

describe("mixed AP/manual first-success closure", () => {
  it("atomically completes the first AP Draft/opening and clears only signed-anchor due metadata after success", async () => {
    const f = await reservedFixture(); const anchorBefore = structuredClone(f.state.events[0]);
    await completeForHireDraft(f.input);
    expect(f.state.events[1]).toMatchObject({ status: "drafts_created", processingToken: null, xeroPurchaseOrderId: "offline-next", executionId: 101, nextBillingDate: "2027-01-15" });
    expect(f.state.openings[0]).toMatchObject({ status: "completed", processingToken: null, nextBillingDate: null, firstApEventId: f.first.id, plan: f.plan });
    expect(f.state.events[0]).toEqual({ ...anchorBefore, nextBillingDate: null, updatedAt: expect.any(Date) });
    const updates = f.log.filter(row => row.operation === "update");
    expect(updates.at(-2)?.table).toBe(events); expect(Object.keys(updates.at(-2)!.values).sort()).toEqual(["nextBillingDate", "updatedAt"]);
    expect(updates.at(-1)?.table).toBe(openings); expect(updates.at(-1)?.params).toEqual([9, f.plan.planHash, "reserved", "token", f.first.id]);
    expect(f.state.audits.at(-1)).toMatchObject({ action: "first_ap_draft_verified", details: { eventId: f.first.id, priorApEventId: f.ap.id } });
    const beforeReplay = structuredClone(f.state);
    await expect(completeForHireDraft(f.input)).rejects.toThrow(/exact event claim/); expect(f.state).toEqual(beforeReplay);
    const normalNext = { ...f.first, id: f.first.id + 1, proposedPoNumber: "HC1920-3", billingPeriodStart: "2027-01-15", billingPeriodEnd: "2027-02-13", status: "previewed", processingToken: null, authorisedPayload: { priorEventId: f.first.id } };
    f.state.events.push(normalNext);
    await expect(claimForHirePreview(normalNext.id, "new", offlinePreviewClaim(normalNext, { priorEventId: f.ap.id }))).rejects.toThrow(/older AP anchor/);
    expect(await claimForHirePreview(normalNext.id, "new", offlinePreviewClaim(normalNext, { priorEventId: f.first.id }))).toBe(true);
  });
  it("retains manual-only first-success behavior with no invented predecessor", async () => {
    const f = await reservedFixture(false); await completeForHireDraft(f.input);
    expect(f.state.events).toHaveLength(1); expect(f.state.openings[0].status).toBe("completed");
    expect(f.log.filter(row => row.operation === "update" && row.values.nextBillingDate === null && row.table === events)).toHaveLength(0);
  });
  it.each(["eventToken", "openingToken", "openingStatus", "anchorBody", "wrongAnchor", "wrongPlan", "openingCas"])("rolls back all closure changes on %s", async kind => {
    const f = await reservedFixture();
    if (kind === "eventToken") f.state.events[1].processingToken = "other";
    if (kind === "openingToken") f.state.openings[0].processingToken = "other";
    if (kind === "openingStatus") f.state.openings[0].status = "reconciliation_required";
    if (kind === "anchorBody") f.state.events[0].proposal = { changed: true };
    if (kind === "wrongAnchor") f.input.priorEventId = 999;
    if (kind === "wrongPlan") f.input.manualOpeningPoint.planHash = "wrong";
    if (kind === "openingCas") {
      const update = f.db.update;
      f.db.update = (table: any) => table !== openings ? update(table) : { set: () => ({ where: async () => [{ affectedRows: 0 }] }) };
    }
    const before = structuredClone(f.state); await expect(completeForHireDraft(f.input)).rejects.toThrow(); expect(f.state).toEqual(before);
    expect(f.log.at(-1)?.operation).toBe("rollback"); expect(f.state.events[0].nextBillingDate).toBe("2026-11-16");
  });
  it("uncertainty locks both ledgers and prevents replay or fallback without a PO retry", async () => {
    const f = await reservedFixture();
    await holdForHireExecution(f.first.id, "offline uncertain POST", true);
    await holdManualForHireHandover({ id: 9, containerControlId: f.ap.containerControlId, token: "token", reason: "uncertain" });
    expect(f.state.openings[0]).toMatchObject({ status: "reconciliation_required", processingToken: "token" });
    expect(f.state.events[1].status).toBe("reconciliation_required"); expect(f.state.events[0].nextBillingDate).toBe("2026-11-16");
    expect(await claimForHirePreview(f.first.id, "retry", offlinePreviewClaim(f.first, { manualHandoverId: 9, manualHandoverPlanHash: f.plan.planHash }))).toBe(false);
    await expect(completeForHireDraft(f.input)).rejects.toThrow();
    expect(f.state.openings[0].status).toBe("reconciliation_required");
  });
});

describe("bounded normal recurring due selector cannot bypass an opening", () => {
  it("uses a gate-independent pending-opening anti-join and excludes older roots even after completion", async () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "false");
    const where = vi.fn(); const limit = vi.fn(async () => []); where.mockReturnValue({ orderBy: () => ({ limit }) });
    m.db.mockResolvedValue({ select: () => ({ from: () => ({ where }) }) });
    await dueForHireRecurringRoots("2026-12-16", 99, 120000, ["79x489745"]);
    const q = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(q.sql).toContain("NOT EXISTS"); expect(q.sql).toContain("financial_for_hire_manual_handovers"); expect(q.sql).toContain("<> 'completed'");
    expect(q.sql).toContain("`firstApEventId`"); expect(q.sql).toContain("`containerControlId` in (?)");
    expect(q.params).toEqual(["drafts_created", "2026-12-16", 120000, "79x489745"]); expect(limit).toHaveBeenCalledWith(10);
    await dueForHireRecurringRoots("2026-12-16", 10, 0); // old calls remain supported
  });
  it("returns an explicitly empty allowlist before any DB query", async () => {
    expect(await dueForHireRecurringRoots("2026-12-16", 10, 0, [])).toEqual([]); expect(m.db).not.toHaveBeenCalled();
  });
});
