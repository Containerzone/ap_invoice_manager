import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { financialForHireManualHandovers, financialForHireManualHandoverAudits, financialForHirePoEvents } from "../drizzle/schema";
import { getDb } from "./db";
import type { ManualForHireEvidence } from "./financialForHireManualHandoverRules";
import { assertManualForHireApHistory, type MixedManualForHireHandoverPlan } from "./financialForHireMixedAnchor";

export function isManualForHireHandoverEnabled(): boolean {
  return process.env.FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED === "true";
}
export async function listManualForHireHandovers(limit = 100) {
  const db = await getDb(); if (!db) throw new Error("AP manual hire handover ledger is unavailable.");
  return db.select().from(financialForHireManualHandovers).orderBy(desc(financialForHireManualHandovers.id)).limit(Math.max(1, Math.min(limit, 200)));
}
export async function getManualForHireHandover(containerControlId: string) {
  const db = await getDb(); if (!db) throw new Error("AP manual hire handover ledger is unavailable.");
  return (await db.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, containerControlId)).limit(1))[0] ?? null;
}
export async function recordManualForHireHandoverAudit(input: { handoverId?: number; containerControlId: string; action: string; planHash?: string; actorId?: number; details?: unknown }) {
  const db = await getDb(); if (!db) throw new Error("AP manual hire audit ledger is unavailable.");
  await db.insert(financialForHireManualHandoverAudits).values({ ...input, details: input.details as any });
}
export async function approveManualForHireHandover(input: { plan: MixedManualForHireHandoverPlan; evidence: ManualForHireEvidence; approvedBy: number; manualCreationStopped: true; acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" }) {
  if (!isManualForHireHandoverEnabled()) throw new Error("Manual hire handover enrollment is disabled; preview remains read-only.");
  if (!Number.isSafeInteger(input.approvedBy) || input.approvedBy <= 0 || input.manualCreationStopped !== true || input.acknowledgement !== "FUTURE_ONLY_MANUAL_PO_HANDOVER") throw new Error("Exact administrator approval and stopped manual recurring creation are required.");
  const db = await getDb(); if (!db) throw new Error("AP manual hire handover ledger is unavailable.");
  const plan = input.plan;
  // Unique control and immutable Xero PO identity reject duplicate enrollment;
  // there is deliberately no onDuplicateKeyUpdate, reset or replacement path.
  await db.transaction(async tx => {
    // All enrollment/claims lock AP rows first, then the unique opening row.
    // The existing control-period index coordinates an anchor claim race.
    const events = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.containerControlId, plan.containerControlId)).orderBy(asc(financialForHirePoEvents.id)).for("update");
    const existing = await tx.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, plan.containerControlId)).for("update");
    if (existing.length) throw new Error("This control already has an immutable manual opening point.");
    assertManualForHireApHistory(events, plan);
    // Unclaimed previews/holds also own the unique AP-local number, even when
    // their period differs from this immutable opening. Never retarget history.
    const collision = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.proposedPoNumber, plan.nextPoNumber)).for("update");
    if (collision.length) throw new Error("The next manual opening PO number already belongs to an AP-local event; enrollment is rejected without changing that receipt.");
    await tx.insert(financialForHireManualHandovers).values({
      containerControlId: plan.containerControlId, containerControlNumber: plan.containerControlNumber,
      manualPoId: plan.manualPoId, manualPoNumber: plan.manualPoNumber, coveredThrough: plan.coveredThrough,
      nextBillingDate: plan.nextPeriodStart, status: "approved", plan, planHash: plan.planHash, evidence: input.evidence,
      approvedBy: input.approvedBy, manualCreationStopped: true, acknowledgement: input.acknowledgement,
    });
  });
  const row = await getManualForHireHandover(plan.containerControlId);
  if (!row || row.planHash !== plan.planHash || row.status !== "approved") throw new Error("Exact approved manual hire opening point could not be read back.");
  await recordManualForHireHandoverAudit({ handoverId: row.id, containerControlId: row.containerControlId, action: "approved_future_only", actorId: input.approvedBy, planHash: row.planHash, details: { manualPoNumber: row.manualPoNumber, coveredThrough: row.coveredThrough, nextBillingDate: row.nextBillingDate, xeroWritesAttempted: 0 } });
  return row;
}
export async function dueManualForHireHandovers(now: string, limit = 10, afterId = 0, approvedControlIds?: readonly string[]) {
  if (approvedControlIds !== undefined && approvedControlIds.length === 0) return [];
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error("Invalid AP-owned manual hire traversal cursor.");
  const db = await getDb(); if (!db) throw new Error("AP manual hire handover ledger is unavailable.");
  const { gt } = await import("drizzle-orm");
  return db.select().from(financialForHireManualHandovers).where(and(
    eq(financialForHireManualHandovers.status, "approved"),
    lte(financialForHireManualHandovers.nextBillingDate, now),
    afterId > 0 ? gt(financialForHireManualHandovers.id, afterId) : undefined,
    approvedControlIds !== undefined ? inArray(financialForHireManualHandovers.containerControlId, [...approvedControlIds]) : undefined,
  )).orderBy(asc(financialForHireManualHandovers.id)).limit(Math.max(1, Math.min(limit, 10)));
}
export async function claimManualForHireHandover(input: { id: number; planHash: string; token: string; eventId: number }) {
  if (!isManualForHireHandoverEnabled()) throw new Error("Manual hire handover execution is disabled.");
  const db = await getDb(); if (!db) throw new Error("AP manual hire handover ledger is unavailable.");
  const row = (await db.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.id, input.id)).limit(1))[0];
  if (!row) return false;
  return db.transaction(async tx => {
    const events = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.containerControlId, row.containerControlId)).orderBy(asc(financialForHirePoEvents.id)).for("update");
    const opening = (await tx.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.id, input.id)).for("update"))[0];
    if (!opening || opening.status !== "approved" || opening.planHash !== input.planHash || opening.processingToken || opening.firstApEventId) return false;
    assertManualForHireApHistory(events, opening.plan as MixedManualForHireHandoverPlan, { eventId: input.eventId, token: input.token });
    const result: any = await tx.update(financialForHireManualHandovers).set({ status: "reserved", processingToken: input.token, firstApEventId: input.eventId, updatedAt: new Date() }).where(and(
      eq(financialForHireManualHandovers.id, input.id), eq(financialForHireManualHandovers.planHash, input.planHash),
      eq(financialForHireManualHandovers.status, "approved"), isNull(financialForHireManualHandovers.processingToken), isNull(financialForHireManualHandovers.firstApEventId),
    ));
    return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
  });
}
/** Closure belongs to completeForHireDraft's event/opening/anchor transaction.
 * A standalone status change could unlock an old AP root after a partial write. */
export async function completeManualForHireHandover(_input: { containerControlId: string; id: number; token: string; eventId: number }): Promise<never> {
  throw new Error("Manual hire opening point requires atomic verified AP Draft completion; standalone or partial closure is prohibited.");
}

export async function holdManualForHireHandover(input: { id: number; containerControlId: string; reason: string; token?: string; dehired?: boolean }) {
  const db = await getDb(); if (!db) throw new Error("AP manual hire handover ledger is unavailable.");
  if (input.token || input.dehired) await db.update(financialForHireManualHandovers).set({
    status: input.dehired ? "dehired" : "reconciliation_required", holdReason: input.reason.slice(0, 2000), nextBillingDate: null, updatedAt: new Date(),
  }).where(and(eq(financialForHireManualHandovers.id, input.id),
    eq(financialForHireManualHandovers.status, input.dehired ? "approved" : "reserved"),
    input.token ? eq(financialForHireManualHandovers.processingToken, input.token) : isNull(financialForHireManualHandovers.processingToken)));
  await recordManualForHireHandoverAudit({ handoverId: input.id, containerControlId: input.containerControlId, action: input.dehired ? "dehired_no_extension" : input.token ? "reconciliation_required" : "preclaim_held", details: { reason: input.reason.slice(0, 2000) } });
}
