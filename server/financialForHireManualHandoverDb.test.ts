import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect, getTableConfig } from "drizzle-orm/mysql-core";
import { financialForHireManualHandovers as openings, financialForHirePoEvents as events } from "../drizzle/schema";
import { offlineDb, offlineMixedFixture, offlinePreviewClaim } from "./financialForHireMixedTestSupport";
const m = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
import { approveManualForHireHandover, claimManualForHireHandover, completeManualForHireHandover, dueManualForHireHandovers, holdManualForHireHandover, isManualForHireHandoverEnabled } from "./financialForHireManualHandoverDb";
import { claimForHirePreview } from "./financialForHireDb";
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "true"); });
afterEach(() => vi.unstubAllEnvs());

describe("immutable manual opening enrollment coordinates AP control locks", () => {
  it("defaults strictly off and requires exact admin acknowledgement before DB reads", async () => {
    const f = offlineMixedFixture();
    for (const value of [undefined, "false", "TRUE", "1", " true", "true ", ""]) {
      vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", value); expect(isManualForHireHandoverEnabled()).toBe(false);
      await expect(approveManualForHireHandover(f.input)).rejects.toThrow(/disabled/);
      await expect(claimManualForHireHandover({ id: 9, planHash: f.plan.planHash, token: "token", eventId: f.first.id })).rejects.toThrow(/disabled/);
    }
    vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "true");
    for (const patch of [{ approvedBy: 0 }, { approvedBy: 1.5 }, { manualCreationStopped: false }, { acknowledgement: "YES" }])
      await expect(approveManualForHireHandover({ ...f.input, ...patch } as any)).rejects.toThrow();
    expect(m.db).not.toHaveBeenCalled();
  });
  it("locks AP rows before opening, inserts once, and leaves historical next-due/body/status untouched", async () => {
    const f = offlineMixedFixture(); const h = offlineDb([f.ap]); m.db.mockResolvedValue(h.db);
    const before = structuredClone(h.state.events[0]); const row = await approveManualForHireHandover(f.input);
    expect(row).toMatchObject({ status: "approved", planHash: f.plan.planHash, evidence: { complete: false } });
    expect(h.state.events[0]).toEqual(before);
    expect(h.log.filter(row => row.operation === "lock:update").map(row => row.table)).toEqual([events, openings, events]);
    expect(h.state.audits[0]).toMatchObject({ action: "approved_future_only", actorId: 7, details: { xeroWritesAttempted: 0 } });
    expect(getTableConfig(openings).indexes.filter(index => index.config.unique).length).toBeGreaterThanOrEqual(2);
    await expect(approveManualForHireHandover(f.input)).rejects.toThrow(/immutable/);
    expect(h.state.openings).toHaveLength(1);
  });
  it("rejects AP claims or newer completions appearing between preview and locked approval", async () => {
    const f = offlineMixedFixture();
    for (const status of ["reserved", "reconciliation_required", "drafts_created"]) {
      const h = offlineDb([f.ap, { ...f.first, status, processingToken: status === "reserved" ? "other" : null, executionId: 101, xeroPurchaseOrderId: "other" }]); m.db.mockResolvedValue(h.db);
      await expect(approveManualForHireHandover(f.input)).rejects.toThrow(/anchor|uncertain/);
      expect(h.state.openings).toEqual([]); expect(h.log.at(-1)?.operation).toBe("rollback");
    }
  });
  it("serializes normal claim versus enrollment: enrollment first blocks claim; claim first blocks enrollment", async () => {
    const f = offlineMixedFixture();
    // A noncolliding ordinary row still cannot claim through the pending opening.
    const normal = { ...f.first, billingPeriodStart: "2026-11-16", billingPeriodEnd: "2026-12-15", proposedPoNumber: "HC1920-99", authorisedPayload: null };
    const a = offlineDb([f.ap, normal]); m.db.mockResolvedValue(a.db);
    const outcomesA = await Promise.allSettled([approveManualForHireHandover(f.input), claimForHirePreview(normal.id, "normal", offlinePreviewClaim(normal, { priorEventId: f.ap.id }))]);
    expect(outcomesA[0].status).toBe("fulfilled"); expect(outcomesA[1]).toMatchObject({ status: "rejected" });
    expect(a.state.events[1].status).toBe("previewed"); expect(a.state.openings[0].status).toBe("approved");
    const b = offlineDb([f.ap, normal]); m.db.mockResolvedValue(b.db);
    expect(await claimForHirePreview(normal.id, "normal", offlinePreviewClaim(normal, { priorEventId: f.ap.id }))).toBe(true);
    await expect(approveManualForHireHandover(f.input)).rejects.toThrow(/anchor|uncertain/);
    expect(b.state.openings).toEqual([]); expect(b.state.events[1].processingToken).toBe("normal");
  });
  it("preserves the manual-only no-anchor path and prevents unbound initial claims", async () => {
    const f = offlineMixedFixture(false); const h = offlineDb(); m.db.mockResolvedValue(h.db);
    await approveManualForHireHandover(f.input);
    h.state.events.push({ ...f.first, eventKind: "initial" });
    expect(await claimForHirePreview(f.first.id, "normal", offlinePreviewClaim(h.state.events[0]))).toBe(false);
    expect(h.state.openings[0].status).toBe("approved");
  });
  it.each(["previewed", "held", "dehired"])("rejects wrong-period AP-local %s ownership of HC1920-2 with no opening/audit or history changes", async status => {
    const f = offlineMixedFixture();
    const wrongPeriod = { ...f.first, status, billingPeriodStart: "2026-11-16", billingPeriodEnd: "2026-12-15", authorisedPayload: null };
    const h = offlineDb([f.ap, wrongPeriod]); m.db.mockResolvedValue(h.db);
    const before = structuredClone(h.state);
    await expect(approveManualForHireHandover(f.input)).rejects.toThrow(/number already belongs/);
    expect(h.state).toEqual(before); expect(h.state.openings).toEqual([]); expect(h.state.audits).toEqual([]);
    expect(h.log.filter(row => row.operation === "lock:update").map(row => row.table)).toEqual([events, openings, events]);
    expect(h.log.at(-1)?.operation).toBe("rollback");
  });
  it("requires exact first event, token and opening hash, then never overwrites immutable plan", async () => {
    const f = offlineMixedFixture(); f.first.status = "reserved"; f.first.processingToken = "token";
    const h = offlineDb([f.ap, f.first], [f.opening]); m.db.mockResolvedValue(h.db);
    expect(await claimManualForHireHandover({ id: 9, planHash: f.plan.planHash, token: "wrong", eventId: f.first.id }).catch(() => false)).toBe(false);
    expect(await claimManualForHireHandover({ id: 9, planHash: f.plan.planHash, token: "token", eventId: f.first.id })).toBe(true);
    expect(h.state.openings[0]).toMatchObject({ status: "reserved", firstApEventId: f.first.id, processingToken: "token", plan: f.plan });
    expect(await claimManualForHireHandover({ id: 9, planHash: f.plan.planHash, token: "token", eventId: f.first.id })).toBe(false);
  });
  it("prohibits standalone partial closure and preserves uncertainty/dehire locks with CAS", async () => {
    const f = offlineMixedFixture(); const h = offlineDb([f.ap], [f.opening]); m.db.mockResolvedValue(h.db);
    await expect(completeManualForHireHandover({ containerControlId: f.ap.containerControlId, id: 9, token: "token", eventId: f.first.id })).rejects.toThrow(/atomic/);
    await holdManualForHireHandover({ id: 9, containerControlId: f.ap.containerControlId, reason: "preclaim" }); expect(h.state.openings[0].status).toBe("approved");
    Object.assign(h.state.openings[0], { status: "reserved", processingToken: "token" });
    await holdManualForHireHandover({ id: 9, containerControlId: f.ap.containerControlId, reason: "uncertain", token: "token" });
    expect(h.state.openings[0]).toMatchObject({ status: "reconciliation_required", processingToken: "token", nextBillingDate: null });
    await holdManualForHireHandover({ id: 9, containerControlId: f.ap.containerControlId, reason: "dehire", dehired: true });
    expect(h.state.openings[0].status).toBe("reconciliation_required");
  });
  it("filters allowlisted controls in SQL before a bounded limit; empty list never queries DB", async () => {
    expect(await dueManualForHireHandovers("2026-12-16", 10, 0, [])).toEqual([]); expect(m.db).not.toHaveBeenCalled();
    const where = vi.fn(); const limit = vi.fn(async () => []); where.mockReturnValue({ orderBy: () => ({ limit }) });
    m.db.mockResolvedValue({ select: () => ({ from: () => ({ where }) }) });
    await dueManualForHireHandovers("2026-12-16", 99, 8, ["79x489745"]);
    const q = new MySqlDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(q.sql).toContain("`containerControlId` in (?)"); expect(q.params).toEqual(["approved", "2026-12-16", 8, "79x489745"]); expect(limit).toHaveBeenCalledWith(10);
    await dueManualForHireHandovers("2026-12-16", 10, 0); // Old absent optional argument stays compatible.
  });
});
