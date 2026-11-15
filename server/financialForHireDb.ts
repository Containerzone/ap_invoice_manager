import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  financialForHirePoEvents,
  financialWriterExecutions,
  workflowSchedules,
  type FinancialForHirePoEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import { assertForHireRelease, getForHireReleasePolicy } from "./financialForHireRelease";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { FOR_HIRE_RECURRING_CRON, FOR_HIRE_RECURRING_CADENCE, FOR_HIRE_RECURRING_TIMEZONE } from "./financialForHireSchedule";

export type ForHireEventKind = "initial" | "recurring";
export type ForHireEventStatus = "previewed" | "held" | "reserved" | "drafts_created" | "reconciliation_required" | "dehired";

export function forHirePayloadHash(payload: FinancialDraftPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function getForHirePoEvents(limit = 100): Promise<FinancialForHirePoEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialForHirePoEvents)
    .orderBy(desc(financialForHirePoEvents.updatedAt), desc(financialForHirePoEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}

export async function getForHireEventsForControl(containerControlId: string): Promise<FinancialForHirePoEvent[]> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  return db.select().from(financialForHirePoEvents)
    .where(eq(financialForHirePoEvents.containerControlId, containerControlId))
    .orderBy(desc(financialForHirePoEvents.billingPeriodEnd), desc(financialForHirePoEvents.id));
}

/** Exact AP-local lookup only; historical Operations POs are never imported. */
export async function getForHireEventForPeriod(input: {
  containerControlId: string;
  eventKind: ForHireEventKind;
  billingPeriodStart: string;
}): Promise<FinancialForHirePoEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  return (await db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.containerControlId, input.containerControlId),
    eq(financialForHirePoEvents.eventKind, input.eventKind),
    eq(financialForHirePoEvents.billingPeriodStart, input.billingPeriodStart),
  )).limit(1))[0] ?? null;
}

/**
 * Persists a non-writing preview or hold. Its unique identity makes repeated
 * manual previews and a future repeated webhook/schedule callback idempotent.
 */
export async function recordForHirePreview(input: {
  containerControlId: string;
  containerControlNumber: string;
  eventKind: ForHireEventKind;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  proposedPoNumber: string;
  containerNumber: string;
  containerType: string;
  supplierVtigerId: string | null;
  supplierName: string | null;
  sourceRefreshedAt: Date | null;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  proposal: unknown;
  xeroPreflight: unknown;
  status: Extract<ForHireEventStatus, "previewed" | "held" | "dehired">;
  holdReason: string | null;
}): Promise<FinancialForHirePoEvent> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const existing = await getForHireEventForPeriod({
    containerControlId: input.containerControlId,
    eventKind: input.eventKind,
    billingPeriodStart: input.billingPeriodStart,
  });
  if (existing && ["reserved", "drafts_created", "reconciliation_required"].includes(existing.status)) return existing;
  const values = {
    ...input,
    supplierVtigerId: input.supplierVtigerId,
    supplierName: input.supplierName,
    sourceRefreshedAt: input.sourceRefreshedAt,
    proposal: input.proposal as any,
    xeroPreflight: input.xeroPreflight as any,
  };
  // The initial read is only an optimisation, not the safety boundary. A
  // concurrent callback can claim/complete the receipt after that read. The
  // duplicate insert is therefore a no-op; preview refresh is a separate
  // conditional update checked atomically against the CURRENT row state.
  await db.insert(financialForHirePoEvents).values(values).onDuplicateKeyUpdate({
    set: { id: sql`${financialForHirePoEvents.id}` },
  });
  await db.update(financialForHirePoEvents).set({ ...values, updatedAt: new Date() }).where(and(
    eq(financialForHirePoEvents.containerControlId, input.containerControlId),
    eq(financialForHirePoEvents.eventKind, input.eventKind),
    eq(financialForHirePoEvents.billingPeriodStart, input.billingPeriodStart),
    inArray(financialForHirePoEvents.status, ["previewed", "held", "dehired"]),
    isNull(financialForHirePoEvents.processingToken),
  ));
  const row = await getForHireEventForPeriod({
    containerControlId: input.containerControlId,
    eventKind: input.eventKind,
    billingPeriodStart: input.billingPeriodStart,
  });
  if (!row) throw new Error("AP For Hire preview receipt could not be read back from the local ledger.");
  return row;
}

/** Returns the last exact AP receipt period; it deliberately ignores Operations history. */
export async function lastVerifiedForHirePeriod(containerControlId: string): Promise<{ periodEnd: string; suffix: number | null } | null> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const rows = await db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.containerControlId, containerControlId),
    eq(financialForHirePoEvents.status, "drafts_created"),
  )).orderBy(desc(financialForHirePoEvents.billingPeriodEnd), desc(financialForHirePoEvents.id)).limit(30);
  const latest = rows[0];
  if (!latest) return null;
  const match = latest.proposedPoNumber.match(/-(\d+)$/);
  return { periodEnd: latest.billingPeriodEnd, suffix: match ? Number(match[1]) : null };
}

export async function latestVerifiedForHireEvent(containerControlId: string): Promise<FinancialForHirePoEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  return (await db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.containerControlId, containerControlId),
    eq(financialForHirePoEvents.status, "drafts_created"),
  )).orderBy(desc(financialForHirePoEvents.billingPeriodEnd), desc(financialForHirePoEvents.id)).limit(1))[0] ?? null;
}

/** Bounded daily traversal: only verified AP predecessors due by Sydney date, after a server-owned cursor. */
export async function dueForHireRecurringRoots(dueDate: string, limit = 10, afterEventId = 0): Promise<FinancialForHirePoEvent[]> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) throw new Error("Invalid AP-owned For Hire traversal cursor.");
  return db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.status, "drafts_created"),
    lte(financialForHirePoEvents.nextBillingDate, dueDate),
    afterEventId > 0 ? gt(financialForHirePoEvents.id, afterEventId) : undefined,
  )).orderBy(asc(financialForHirePoEvents.id)).limit(Math.max(1, Math.min(limit, 10)));
}

/** Claims only a freshly revalidated AP preview; an existing receipt remains an idempotent replay. */
export async function claimForHirePreview(eventId: number, token: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const result: any = await db.update(financialForHirePoEvents).set({ status: "reserved", processingToken: token, holdReason: null })
    .where(and(eq(financialForHirePoEvents.id, eventId), eq(financialForHirePoEvents.status, "previewed"), isNull(financialForHirePoEvents.processingToken)));
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}

export async function bindForHirePayload(eventId: number, releaseKey: string, payload: FinancialDraftPayload, manualOpeningPoint?: { id: number; planHash: string }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  await db.update(financialForHirePoEvents).set({
    releaseKey,
    authorisedPayload: { hash: forHirePayloadHash(payload), number: payload.documentNumber, bodyHash: createHash("sha256").update(JSON.stringify(payload.body)).digest("hex"), ...(manualOpeningPoint ? { manualHandoverId: manualOpeningPoint.id, manualHandoverPlanHash: manualOpeningPoint.planHash } : {}) },
  }).where(eq(financialForHirePoEvents.id, eventId));
}

/** Checks release, exclusive local claim and immutable payload immediately before Xero transport. */
export async function verifyForHireAutomaticWriteAccess(input: {
  eventId: number;
  releaseKey: string;
  payload: FinancialDraftPayload;
  workflowType: "initial_for_hire" | "recurring_for_hire";
  preparedBy: number;
}): Promise<void> {
  const phase = input.workflowType === "initial_for_hire" ? "initial" : "recurring" as const;
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, phase);
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const event = (await db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, input.eventId)).limit(1))[0];
  const auth = event?.authorisedPayload as { hash?: string; number?: string; manualHandoverId?: number; manualHandoverPlanHash?: string } | null;
  if (!event || event.status !== "reserved" || !event.processingToken || event.releaseKey !== policy.releaseKey || input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy || !auth || auth.hash !== forHirePayloadHash(input.payload) || auth.number !== input.payload.documentNumber) {
    throw new Error("For Hire event has no current release-backed, exact-payload reservation.");
  }
  if (input.payload.method !== "POST" || input.payload.documentFamily !== "purchase_order" || input.payload.expectedXeroDocumentId) {
    throw new Error("For Hire automatic release permits only a new Draft Purchase Order POST.");
  }
  if (auth.manualHandoverId !== undefined) {
    if (input.workflowType !== "recurring_for_hire" || !auth.manualHandoverPlanHash) throw new Error("Manual opening points may authorize only the first recurring hire Draft.");
    const { verifyManualForHireFirstWrite } = await import("./financialForHireManualHandoverService");
    await verifyManualForHireFirstWrite({ recordId: event.containerControlId, handoverId: auth.manualHandoverId, planHash: auth.manualHandoverPlanHash, eventId: event.id, token: event.processingToken, payload: input.payload });
  } else {
    const { getManualForHireHandover } = await import("./financialForHireManualHandoverDb");
    const opening = await getManualForHireHandover(event.containerControlId);
    if (opening && (opening.status !== "completed" || input.workflowType !== "recurring_for_hire")) throw new Error("This control's manual opening point requires its exact first-period authorization; only verified AP recurring successors may continue after completion.");
  }
}

export async function completeForHireDraft(input: { eventId: number; executionId: number; xeroPurchaseOrderId: string; nextBillingDate: string | null; priorEventId?: number | null }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  await db.update(financialForHirePoEvents).set({
    status: "drafts_created",
    executionId: input.executionId,
    xeroPurchaseOrderId: input.xeroPurchaseOrderId,
    nextBillingDate: input.nextBillingDate,
    processingToken: null,
    holdReason: null,
    updatedAt: new Date(),
  }).where(eq(financialForHirePoEvents.id, input.eventId));
  if (input.priorEventId && input.priorEventId !== input.eventId) {
    await db.update(financialForHirePoEvents).set({ nextBillingDate: null, updatedAt: new Date() })
      .where(eq(financialForHirePoEvents.id, input.priorEventId));
  }
}

export async function holdForHireExecution(eventId: number, reason: string, uncertain = false): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  await db.update(financialForHirePoEvents).set({
    status: uncertain ? "reconciliation_required" : "held",
    processingToken: null,
    holdReason: reason.slice(0, 2000),
    updatedAt: new Date(),
  }).where(eq(financialForHirePoEvents.id, eventId));
}

export async function clearForHireNextBillingDate(eventId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  await db.update(financialForHirePoEvents).set({ nextBillingDate: null, updatedAt: new Date() })
    .where(eq(financialForHirePoEvents.id, eventId));
}

/** After the separately approved cutover only; this never creates or enables a Heartbeat. */
export async function bindApprovedForHireSchedule(taskUid: string, approvedBy: number): Promise<void> {
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, "recurring");
  if (!taskUid.trim() || policy.approvedBy !== approvedBy) throw new Error("For Hire schedule binding requires the exact approved task UID and approver.");
  const db = await getDb();
  if (!db) throw new Error("AP schedule ledger is unavailable.");
  const values = {
    workflowType: "recurring_for_hire",
    taskUid,
    enabled: true,
    cronExpression: FOR_HIRE_RECURRING_CRON,
    lastOutcome: "approved_for_hire_release",
    auditData: { releaseKey: policy.releaseKey, approvedBy, cadence: FOR_HIRE_RECURRING_CADENCE, businessTimezone: FOR_HIRE_RECURRING_TIMEZONE },
  };
  await db.insert(workflowSchedules).values(values).onDuplicateKeyUpdate({ set: { ...values, updatedAt: new Date() } });
}

export async function forHirePriorExecution(payload: FinancialDraftPayload) {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire execution ledger is unavailable.");
  return (await db.select().from(financialWriterExecutions).where(eq(financialWriterExecutions.idempotencyKey, payload.idempotencyKey)).limit(1))[0] ?? null;
}
