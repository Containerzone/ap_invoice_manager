import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  financialForHirePoEvents,
  financialForHireManualHandovers,
  financialForHireManualHandoverAudits,
  financialWriterExecutions,
  workflowSchedules,
  type FinancialForHirePoEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import { assertForHireRelease, assertForHireRecurringControlAllowed, getForHireReleasePolicy } from "./financialForHireRelease";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { FOR_HIRE_RECURRING_CRON, FOR_HIRE_RECURRING_CADENCE, FOR_HIRE_RECURRING_TIMEZONE } from "./financialForHireSchedule";
import { assertForHireRecurringSuccessor, assertForHireOpeningSuccessorChain, assertManualForHireApHistory, forHireApAnchor, type MixedManualForHireHandoverPlan } from "./financialForHireMixedAnchor";
import { financialSha256 } from "./financialProposalIntegrity";

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
  manualOpeningPoint?: { id: number; planHash: string };
}): Promise<FinancialForHirePoEvent> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  return db.transaction(async tx => {
    // Same order as enrollment/claim: control AP rows, opening, unique number.
    const events = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.containerControlId, input.containerControlId)).orderBy(asc(financialForHirePoEvents.id)).for("update");
    const opening = (await tx.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, input.containerControlId)).for("update"))[0];
    const existing = events.find(row => row.eventKind === input.eventKind && row.billingPeriodStart === input.billingPeriodStart);
    if (opening && opening.status !== "completed") {
      const plan = opening.plan as MixedManualForHireHandoverPlan;
      const { planHash: _hash, ...unsignedPlan } = plan;
      if (opening.status !== "approved" || opening.processingToken || opening.firstApEventId ||
        input.manualOpeningPoint?.id !== opening.id || input.manualOpeningPoint.planHash !== opening.planHash ||
        plan.planHash !== opening.planHash || financialSha256(unsignedPlan) !== opening.planHash ||
        plan.containerControlId !== input.containerControlId || input.eventKind !== "recurring" ||
        input.billingPeriodStart !== plan.nextPeriodStart || input.billingPeriodEnd !== plan.nextPeriodEnd || input.proposedPoNumber !== plan.nextPoNumber) {
        throw new Error("Only the exact verified manual opening point may persist its own next-period preview; ordinary or stale previews cannot bypass it.");
      }
      assertManualForHireApHistory(events, plan);
    } else if (input.manualOpeningPoint) {
      throw new Error("Manual preview no longer has its exact approved opening point.");
    } else if (opening) {
      if (input.eventKind !== "recurring") throw new Error("A completed manual opening point cannot be bypassed by an initial preview.");
      const latest = events.filter(row => row.status === "drafts_created").sort((a, b) => b.billingPeriodEnd.localeCompare(a.billingPeriodEnd) || b.id - a.id)[0];
      assertForHireOpeningSuccessorChain(events, opening, latest?.id ?? 0);
      // A not-yet-inserted preview has no receipt ID. The actual monotonic ID
      // is checked again under the claim lock; here validate its exact fields.
      assertForHireRecurringSuccessor({ ...latest!, ...input, id: existing?.id ?? latest!.id + 1 }, latest!, (opening.plan as MixedManualForHireHandoverPlan).containerControlNumber);
    }
    if (existing && (existing.processingToken || ["reserved", "drafts_created", "reconciliation_required"].includes(existing.status))) return existing;
    const collisions = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.proposedPoNumber, input.proposedPoNumber)).for("update");
    if (collisions.some(row => row.id !== existing?.id)) throw new Error("For Hire preview number already belongs to a different AP-local event; no receipt may be retargeted.");
    const { manualOpeningPoint: _manual, ...values } = input;
    // Unique insertion is a no-op on collision. Refresh still checks CURRENT
    // state/token atomically, never touching financial history or due metadata.
    await tx.insert(financialForHirePoEvents).values(values).onDuplicateKeyUpdate({ set: { id: sql`${financialForHirePoEvents.id}` } });
    await tx.update(financialForHirePoEvents).set({ ...values, updatedAt: new Date() }).where(and(
      eq(financialForHirePoEvents.containerControlId, input.containerControlId),
      eq(financialForHirePoEvents.eventKind, input.eventKind),
      eq(financialForHirePoEvents.billingPeriodStart, input.billingPeriodStart),
      inArray(financialForHirePoEvents.status, ["previewed", "held", "dehired"]),
      isNull(financialForHirePoEvents.processingToken),
    ));
    const row = (await tx.select().from(financialForHirePoEvents).where(and(
      eq(financialForHirePoEvents.containerControlId, input.containerControlId),
      eq(financialForHirePoEvents.eventKind, input.eventKind),
      eq(financialForHirePoEvents.billingPeriodStart, input.billingPeriodStart),
    )).limit(1))[0];
    if (!row) throw new Error("AP For Hire preview receipt could not be read back from the local ledger.");
    return row;
  });
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
export async function dueForHireRecurringRoots(dueDate: string, limit = 10, afterEventId = 0, approvedControlIds?: readonly string[]): Promise<FinancialForHirePoEvent[]> {
  if (approvedControlIds !== undefined && approvedControlIds.length === 0) return [];
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) throw new Error("Invalid AP-owned For Hire traversal cursor.");
  return db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.status, "drafts_created"),
    lte(financialForHirePoEvents.nextBillingDate, dueDate),
    afterEventId > 0 ? gt(financialForHirePoEvents.id, afterEventId) : undefined,
    approvedControlIds !== undefined ? inArray(financialForHirePoEvents.containerControlId, [...approvedControlIds]) : undefined,
    sql`NOT EXISTS (SELECT 1 FROM ${financialForHireManualHandovers} WHERE ${financialForHireManualHandovers.containerControlId} = ${financialForHirePoEvents.containerControlId} AND ${financialForHireManualHandovers.status} <> 'completed')`,
    // Even a partially closed opening cannot fall back to its old AP anchor.
    sql`NOT EXISTS (SELECT 1 FROM ${financialForHireManualHandovers} WHERE ${financialForHireManualHandovers.containerControlId} = ${financialForHirePoEvents.containerControlId} AND ${financialForHireManualHandovers.status} = 'completed' AND (${financialForHireManualHandovers.firstApEventId} IS NULL OR ${financialForHirePoEvents.id} < ${financialForHireManualHandovers.firstApEventId}))`,
  )).orderBy(asc(financialForHirePoEvents.id)).limit(Math.max(1, Math.min(limit, 10)));
}

export type ForHirePreviewVersion = {
  containerControlId: string;
  eventKind: ForHireEventKind;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  proposedPoNumber: string;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  proposalHash: string;
};

export function forHirePreviewVersion(event: Pick<FinancialForHirePoEvent, "containerControlId" | "eventKind" | "billingPeriodStart" | "billingPeriodEnd" | "proposedPoNumber" | "sourceSnapshotHash" | "rulesSnapshotHash" | "xeroPreflightHash" | "proposal">): ForHirePreviewVersion {
  return { containerControlId: event.containerControlId, eventKind: event.eventKind, billingPeriodStart: event.billingPeriodStart,
    billingPeriodEnd: event.billingPeriodEnd, proposedPoNumber: event.proposedPoNumber, sourceSnapshotHash: event.sourceSnapshotHash,
    rulesSnapshotHash: event.rulesSnapshotHash, xeroPreflightHash: event.xeroPreflightHash, proposalHash: financialSha256(event.proposal) };
}

function matchesForHirePreviewVersion(event: FinancialForHirePoEvent, expected: ForHirePreviewVersion): boolean {
  return financialSha256(forHirePreviewVersion(event)) === financialSha256(expected) &&
    !!event.proposal && !!event.xeroPreflight && !!event.xeroPreflightHash && financialSha256(event.xeroPreflight) === event.xeroPreflightHash;
}

/** Claims only the caller's exact freshly revalidated preview, never another callback's version. */
export async function claimForHirePreview(eventId: number, token: string, context: { expectedPreview: ForHirePreviewVersion; priorEventId?: number | null; manualHandoverId?: number; manualHandoverPlanHash?: string }): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const candidate = (await db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, eventId)).limit(1))[0];
  if (!candidate || candidate.status !== "previewed" || candidate.processingToken) return false;
  return db.transaction(async tx => {
    const events = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.containerControlId, candidate.containerControlId)).orderBy(asc(financialForHirePoEvents.id)).for("update");
    const opening = (await tx.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, candidate.containerControlId)).for("update"))[0];
    const event = events.find(row => row.id === eventId);
    if (!event || event.status !== "previewed" || event.processingToken || !token || !context?.expectedPreview || !matchesForHirePreviewVersion(event, context.expectedPreview)) return false;
    if (context?.manualHandoverId !== undefined) {
      if (!opening || opening.id !== context.manualHandoverId || opening.planHash !== context.manualHandoverPlanHash || opening.status !== "approved" || opening.processingToken || opening.firstApEventId) return false;
      const plan = opening.plan as MixedManualForHireHandoverPlan;
      assertManualForHireApHistory(events, plan);
      if (event.eventKind !== "recurring" || event.billingPeriodStart !== plan.nextPeriodStart || event.billingPeriodEnd !== plan.nextPeriodEnd || event.proposedPoNumber !== plan.nextPoNumber) return false;
    } else {
      if (opening) {
        if (event.eventKind !== "recurring" || !context?.priorEventId) return false;
        assertForHireOpeningSuccessorChain(events, opening, context.priorEventId);
        const previous = events.find(row => row.id === context.priorEventId);
        if (!previous) return false;
        assertForHireRecurringSuccessor(event, previous, (opening.plan as MixedManualForHireHandoverPlan).containerControlNumber);
      }
      if (context?.priorEventId) {
        const latest = events.filter(row => row.status === "drafts_created").sort((a, b) => b.billingPeriodEnd.localeCompare(a.billingPeriodEnd) || b.id - a.id)[0];
        if (!latest || latest.id !== context.priorEventId || latest.processingToken) return false;
      }
      if (events.some(row => row.id !== eventId && (row.processingToken || ["reserved", "reconciliation_required"].includes(row.status)))) return false;
    }
    const result: any = await tx.update(financialForHirePoEvents).set({ status: "reserved", processingToken: token, holdReason: null })
      .where(and(eq(financialForHirePoEvents.id, eventId), eq(financialForHirePoEvents.status, "previewed"), isNull(financialForHirePoEvents.processingToken),
        eq(financialForHirePoEvents.containerControlId, context.expectedPreview.containerControlId), eq(financialForHirePoEvents.eventKind, context.expectedPreview.eventKind),
        eq(financialForHirePoEvents.billingPeriodStart, context.expectedPreview.billingPeriodStart), eq(financialForHirePoEvents.billingPeriodEnd, context.expectedPreview.billingPeriodEnd),
        eq(financialForHirePoEvents.proposedPoNumber, context.expectedPreview.proposedPoNumber), eq(financialForHirePoEvents.sourceSnapshotHash, context.expectedPreview.sourceSnapshotHash),
        eq(financialForHirePoEvents.rulesSnapshotHash, context.expectedPreview.rulesSnapshotHash), eq(financialForHirePoEvents.xeroPreflightHash, context.expectedPreview.xeroPreflightHash!)));
    return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
  });
}

async function expectedForHirePayload(event: FinancialForHirePoEvent): Promise<FinancialDraftPayload> {
  // MySQL JSON returns ISO strings; restore only the proposal's typed dates.
  const document = event.proposal as import("./financialWorkflowEngine").ProposedFinancialDocument;
  if (!document) throw new Error("Claimed For Hire event has no persisted proposed Draft snapshot.");
  const { prepareFinancialDraftPayload } = await import("./financialProductionWriter");
  const payload = prepareFinancialDraftPayload({ ...document, issueDate: document.issueDate ? new Date(document.issueDate) : null, dueDate: document.dueDate ? new Date(document.dueDate) : null }, `${event.containerControlId}:${event.eventKind}:${event.billingPeriodStart}`);
  (payload.body.PurchaseOrders as Record<string, unknown>[])[0].CurrencyCode = "AUD";
  return payload;
}

export async function bindForHirePayload(eventId: number, releaseKey: string, payload: FinancialDraftPayload, claim: { token: string; expectedPreview: ForHirePreviewVersion; preparedDocument: import("./financialWorkflowEngine").ProposedFinancialDocument }, manualOpeningPoint?: { id: number; planHash: string }, priorEventId?: number | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const candidate = (await db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, eventId)).limit(1))[0];
  if (!candidate) throw new Error("For Hire payload binding lost its exact event claim.");
  await db.transaction(async tx => {
    const events = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.containerControlId, candidate.containerControlId)).orderBy(asc(financialForHirePoEvents.id)).for("update");
    const opening = (await tx.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, candidate.containerControlId)).for("update"))[0];
    const event = events.find(row => row.id === eventId);
    if (!event || event.status !== "reserved" || event.processingToken !== claim.token || !claim.token || !matchesForHirePreviewVersion(event, claim.expectedPreview) ||
      financialSha256(event.proposal) !== financialSha256(claim.preparedDocument) || financialSha256(await expectedForHirePayload(event)) !== financialSha256(payload)) {
      throw new Error("For Hire prepared Draft or wire body does not match its exact claimed preview version/token.");
    }
    if (manualOpeningPoint ? !opening || opening.id !== manualOpeningPoint.id || opening.planHash !== manualOpeningPoint.planHash || opening.status !== "reserved" || opening.processingToken !== claim.token || opening.firstApEventId !== event.id : opening && opening.status !== "completed") {
      throw new Error("For Hire payload binding cannot bypass its immutable manual opening claim.");
    }
    const result: any = await tx.update(financialForHirePoEvents).set({ releaseKey,
      authorisedPayload: { hash: forHirePayloadHash(payload), number: payload.documentNumber, bodyHash: financialSha256(payload.body), expectedPreview: claim.expectedPreview, claimToken: claim.token,
        ...(priorEventId ? { priorEventId } : {}), ...(manualOpeningPoint ? { manualHandoverId: manualOpeningPoint.id, manualHandoverPlanHash: manualOpeningPoint.planHash } : {}) },
    }).where(and(eq(financialForHirePoEvents.id, eventId), eq(financialForHirePoEvents.status, "reserved"), eq(financialForHirePoEvents.processingToken, claim.token)));
    if (Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) !== 1) throw new Error("For Hire payload binding lost its exact event claim.");
  });
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
  if (event && phase === "recurring") assertForHireRecurringControlAllowed(policy, event.containerControlId);
  const auth = event?.authorisedPayload as { hash?: string; number?: string; bodyHash?: string; expectedPreview?: ForHirePreviewVersion; claimToken?: string; manualHandoverId?: number; manualHandoverPlanHash?: string; priorEventId?: number } | null;
  if (!event || event.status !== "reserved" || !event.processingToken || event.releaseKey !== policy.releaseKey || input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy || !auth || auth.hash !== forHirePayloadHash(input.payload) || auth.number !== input.payload.documentNumber) {
    throw new Error("For Hire event has no current release-backed, exact-payload reservation.");
  }
  if (input.payload.method !== "POST" || input.payload.documentFamily !== "purchase_order" || input.payload.expectedXeroDocumentId) {
    throw new Error("For Hire automatic release permits only a new Draft Purchase Order POST.");
  }
  if (event.eventKind !== phase || !auth.expectedPreview || auth.claimToken !== event.processingToken || !matchesForHirePreviewVersion(event, auth.expectedPreview) ||
    auth.bodyHash !== financialSha256(input.payload.body) || financialSha256(await expectedForHirePayload(event)) !== financialSha256(input.payload)) {
    throw new Error("For Hire transport body no longer matches its exact claimed ledger preview version/token.");
  }
  if (auth.manualHandoverId !== undefined) {
    if (input.workflowType !== "recurring_for_hire" || !auth.manualHandoverPlanHash) throw new Error("Manual opening points may authorize only the first recurring hire Draft.");
    const { verifyManualForHireFirstWrite } = await import("./financialForHireManualHandoverService");
    await verifyManualForHireFirstWrite({ recordId: event.containerControlId, handoverId: auth.manualHandoverId, planHash: auth.manualHandoverPlanHash, eventId: event.id, token: event.processingToken, payload: input.payload });
  } else {
    const { getManualForHireHandover } = await import("./financialForHireManualHandoverDb");
    const opening = await getManualForHireHandover(event.containerControlId);
    if (opening && (opening.status !== "completed" || input.workflowType !== "recurring_for_hire")) throw new Error("This control's manual opening point requires its exact first-period authorization; only verified AP recurring successors may continue after completion.");
    if (opening) {
      if (!auth.priorEventId) throw new Error("Completed manual opening point requires an exact verified AP successor link; the older AP anchor cannot resume.");
      const events = await getForHireEventsForControl(event.containerControlId);
      assertForHireOpeningSuccessorChain(events, opening, auth.priorEventId);
      const prior = events.find(row => row.id === auth.priorEventId);
      if (!prior) throw new Error("Manual opening point successor predecessor is missing.");
      assertForHireRecurringSuccessor(event, prior, (opening.plan as MixedManualForHireHandoverPlan).containerControlNumber);
    }
    const { verifyCurrentOrdinaryForHireDraft } = await import("./financialForHireService");
    await verifyCurrentOrdinaryForHireDraft({ event, payload: input.payload, priorEventId: auth.priorEventId });
  }
  // Recheck the reservation after awaited current-source/Xero reads. Never
  // authorize a released/reconciled token or adopt a refreshed ledger body.
  const current = (await db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, input.eventId)).limit(1))[0];
  if (!current || current.status !== "reserved" || current.processingToken !== auth.claimToken || current.releaseKey !== input.releaseKey ||
    financialSha256(current.authorisedPayload) !== financialSha256(auth) || !matchesForHirePreviewVersion(current, auth.expectedPreview)) {
    throw new Error("For Hire exact reservation changed during final transport revalidation.");
  }
}

export async function completeForHireDraft(input: { eventId: number; executionId: number; xeroPurchaseOrderId: string; nextBillingDate: string | null; priorEventId?: number | null; token?: string; manualOpeningPoint?: { id: number; planHash: string; token: string } }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const candidate = (await db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, input.eventId)).limit(1))[0];
  if (!candidate || !input.xeroPurchaseOrderId || !Number.isSafeInteger(input.executionId) || input.executionId <= 0) throw new Error("Exact verified For Hire Draft result is required.");
  await db.transaction(async tx => {
    const events = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.containerControlId, candidate.containerControlId)).orderBy(asc(financialForHirePoEvents.id)).for("update");
    const opening = (await tx.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, candidate.containerControlId)).for("update"))[0];
    const event = events.find(row => row.id === input.eventId);
    const token = input.token ?? input.manualOpeningPoint?.token;
    if (!event || event.status !== "reserved" || !event.processingToken || (token && event.processingToken !== token)) throw new Error("For Hire completion lost its exact event claim.");
    const auth = event.authorisedPayload as { manualHandoverId?: number; manualHandoverPlanHash?: string; priorEventId?: number } | null;
    if (input.manualOpeningPoint) {
      const manual = input.manualOpeningPoint;
      if (!opening || opening.id !== manual.id || opening.planHash !== manual.planHash || opening.status !== "reserved"
        || opening.processingToken !== manual.token || event.processingToken !== manual.token || opening.firstApEventId !== event.id
        || auth?.manualHandoverId !== manual.id || auth.manualHandoverPlanHash !== manual.planHash) throw new Error("Manual hire opening point completion lost its exact exclusive claim.");
      const plan = opening.plan as MixedManualForHireHandoverPlan;
      assertManualForHireApHistory(events, plan, { eventId: event.id, token: manual.token });
      if ((input.priorEventId ?? null) !== (plan.priorApAnchor?.id ?? null)) throw new Error("Manual completion may clear only its signed prior AP anchor.");
    } else if (opening) {
      if (opening.status !== "completed" || !input.priorEventId || auth?.priorEventId !== input.priorEventId) throw new Error("Manual opening point blocks unbound or partially closed recurrence.");
      assertForHireOpeningSuccessorChain(events, opening, input.priorEventId);
      const prior = events.find(row => row.id === input.priorEventId);
      if (!prior) throw new Error("Manual opening point successor predecessor is missing.");
      assertForHireRecurringSuccessor(event, prior, (opening.plan as MixedManualForHireHandoverPlan).containerControlNumber);
    }
    const result: any = await tx.update(financialForHirePoEvents).set({
      status: "drafts_created", executionId: input.executionId, xeroPurchaseOrderId: input.xeroPurchaseOrderId,
      nextBillingDate: input.nextBillingDate, processingToken: null, holdReason: null, updatedAt: new Date(),
    }).where(and(eq(financialForHirePoEvents.id, input.eventId), eq(financialForHirePoEvents.status, "reserved"), eq(financialForHirePoEvents.processingToken, event.processingToken)));
    if (Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) !== 1) throw new Error("For Hire completion lost its exact event claim.");
    if (input.priorEventId && input.priorEventId !== input.eventId) {
      const prior = events.find(row => row.id === input.priorEventId);
      if (!prior || prior.status !== "drafts_created" || prior.processingToken) throw new Error("For Hire predecessor is no longer an exact verified Draft.");
      if (input.manualOpeningPoint && financialSha256(forHireApAnchor(prior)) !== financialSha256((opening!.plan as MixedManualForHireHandoverPlan).priorApAnchor)) throw new Error("Signed prior AP anchor changed before closure.");
      // Only scheduling metadata is cleared. No historical proposal/status/body is changed.
      await tx.update(financialForHirePoEvents).set({ nextBillingDate: null, updatedAt: new Date() })
        .where(and(eq(financialForHirePoEvents.id, prior.id), eq(financialForHirePoEvents.status, "drafts_created"), isNull(financialForHirePoEvents.processingToken)));
    }
    if (input.manualOpeningPoint) {
      const manual = input.manualOpeningPoint;
      const closed: any = await tx.update(financialForHireManualHandovers).set({ status: "completed", processingToken: null, nextBillingDate: null, updatedAt: new Date() }).where(and(
        eq(financialForHireManualHandovers.id, manual.id), eq(financialForHireManualHandovers.planHash, manual.planHash),
        eq(financialForHireManualHandovers.status, "reserved"), eq(financialForHireManualHandovers.processingToken, manual.token), eq(financialForHireManualHandovers.firstApEventId, input.eventId),
      ));
      if (Number(closed?.[0]?.affectedRows ?? closed?.rowsAffected ?? 0) !== 1) throw new Error("Manual hire opening point completion lost its exact exclusive claim.");
      await tx.insert(financialForHireManualHandoverAudits).values({ handoverId: manual.id, containerControlId: candidate.containerControlId,
        action: "first_ap_draft_verified", planHash: manual.planHash, details: { eventId: input.eventId, priorApEventId: input.priorEventId ?? null } });
    }
  });
}

export async function holdForHireExecution(eventId: number, reason: string, uncertain = false): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  await db.update(financialForHirePoEvents).set({
    status: uncertain ? "reconciliation_required" : "held",
    processingToken: null,
    holdReason: reason.slice(0, 2000),
    updatedAt: new Date(),
  }).where(and(eq(financialForHirePoEvents.id, eventId), inArray(financialForHirePoEvents.status, uncertain ? ["reserved", "held", "reconciliation_required"] : ["reserved", "held"])));
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
