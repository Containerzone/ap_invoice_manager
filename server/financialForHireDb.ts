import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  financialForHirePoEvents,
  financialForHireInitialProvenance,
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
import { assertForHireRecurringScopeForControl, authenticatedForHireInitialCreation, markNewAuthenticatedForHireInitial } from "./financialForHireFutureEligibilityDb";
import { buildForHireInitialReceiptSnapshot, buildVerifiedForHireFutureChainProof } from "./financialForHireFutureEligibility";
import type { ForHireReleasePolicy } from "./financialForHireRelease";
export { assertForHireRecurringScopeForControl } from "./financialForHireFutureEligibilityDb";

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
  const result = await db.transaction(async tx => {
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
    if (existing && (existing.processingToken || ["reserved", "drafts_created", "reconciliation_required"].includes(existing.status))) return { row: existing, created: false };
    const collisions = await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.proposedPoNumber, input.proposedPoNumber)).for("update");
    if (collisions.some(row => row.id !== existing?.id)) throw new Error("For Hire preview number already belongs to a different AP-local event; no receipt may be retargeted.");
    const { manualOpeningPoint: _manual, ...values } = input;
    // Unique insertion is a no-op on collision. Refresh still checks CURRENT
    // state/token atomically, never touching financial history or due metadata.
    if (!existing) await tx.insert(financialForHirePoEvents).values(values);
    else await tx.insert(financialForHirePoEvents).values(values).onDuplicateKeyUpdate({ set: { id: sql`${financialForHirePoEvents.id}` } });
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
    return { row, created: !existing && events.length === 0 && input.eventKind === "initial" };
  });
  if (result.created) markNewAuthenticatedForHireInitial(result.row.id);
  return result.row;
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
export async function dueForHireRecurringRoots(dueDate: string, limit = 10, afterEventId = 0, policyScope?: readonly string[] | ForHireReleasePolicy): Promise<FinancialForHirePoEvent[]> {
  const policy = policyScope && !Array.isArray(policyScope) ? policyScope as ForHireReleasePolicy : undefined;
  const approvedControlIds = policy ? policy.recurringControlIds : policyScope as readonly string[] | undefined;
  const future = policy?.recurringFutureInitialsEnabled === true && !!policy.recurringFutureInitialsFrom;
  if (approvedControlIds !== undefined && approvedControlIds.length === 0 && !future) return [];
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) throw new Error("Invalid AP-owned For Hire traversal cursor.");
  const futurePredicate = future ? sql`EXISTS (SELECT 1 FROM ${financialForHireInitialProvenance} WHERE ${financialForHireInitialProvenance.containerControlId} = ${financialForHirePoEvents.containerControlId} AND ${financialForHireInitialProvenance.origin} = 'authenticated_initial_for_hire_webhook' AND ${financialForHireInitialProvenance.initialCreatedAt} >= ${new Date(policy!.recurringFutureInitialsFrom!)} ${policy!.recurringFutureExcludedControlIds.length ? sql`AND ${financialForHireInitialProvenance.containerControlId} NOT IN (${sql.join(policy!.recurringFutureExcludedControlIds.map(id => sql`${id}`), sql`, `)})` : sql``})` : undefined;
  const rows = await db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.status, "drafts_created"),
    lte(financialForHirePoEvents.nextBillingDate, dueDate),
    afterEventId > 0 ? gt(financialForHirePoEvents.id, afterEventId) : undefined,
    approvedControlIds !== undefined ? or(approvedControlIds.length ? inArray(financialForHirePoEvents.containerControlId, [...approvedControlIds]) : undefined, futurePredicate) : futurePredicate,
    sql`NOT EXISTS (SELECT 1 FROM ${financialForHireManualHandovers} WHERE ${financialForHireManualHandovers.containerControlId} = ${financialForHirePoEvents.containerControlId} AND ${financialForHireManualHandovers.status} <> 'completed')`,
    // Even a partially closed opening cannot fall back to its old AP anchor.
    sql`NOT EXISTS (SELECT 1 FROM ${financialForHireManualHandovers} WHERE ${financialForHireManualHandovers.containerControlId} = ${financialForHirePoEvents.containerControlId} AND ${financialForHireManualHandovers.status} = 'completed' AND (${financialForHireManualHandovers.firstApEventId} IS NULL OR ${financialForHirePoEvents.id} < ${financialForHireManualHandovers.firstApEventId}))`,
  )).orderBy(asc(financialForHirePoEvents.id)).limit(Math.max(1, Math.min(limit, 10)));
  if (policy) for (const row of rows) {
    // Invalid candidates remain traversal-visible so a held root cannot starve
    // later controls. Execution repeats this exact guard before any preview.
    try { await assertForHireRecurringScopeForControl(policy, row.containerControlId, row.id); }
    catch { /* held by the live loop, with no preview, claim or transport */ }
  }
  return rows;
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
export async function claimForHirePreview(eventId: number, token: string, context: { expectedPreview: ForHirePreviewVersion; priorEventId?: number | null; manualHandoverId?: number; manualHandoverPlanHash?: string; futureProofHash?: string }): Promise<boolean> {
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
    if (event.eventKind === "recurring") await assertForHireRecurringScopeForControl(await getForHireReleasePolicy(), event.containerControlId, context.manualHandoverId === undefined ? context.priorEventId : undefined,
      { reader: tx as any, currentEvent: event, expectedProofHash: context.futureProofHash });
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

export async function bindForHirePayload(eventId: number, releaseKey: string, payload: FinancialDraftPayload, claim: { token: string; expectedPreview: ForHirePreviewVersion; preparedDocument: import("./financialWorkflowEngine").ProposedFinancialDocument; futureProofHash?: string }, manualOpeningPoint?: { id: number; planHash: string }, priorEventId?: number | null): Promise<void> {
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
    const scope = event.eventKind === "recurring" ? await assertForHireRecurringScopeForControl(await getForHireReleasePolicy(), event.containerControlId, manualOpeningPoint ? undefined : priorEventId,
      { reader: tx as any, currentEvent: event, expectedProofHash: claim.futureProofHash }) : undefined;
    const result: any = await tx.update(financialForHirePoEvents).set({ releaseKey,
      authorisedPayload: { hash: forHirePayloadHash(payload), number: payload.documentNumber, bodyHash: financialSha256(payload.body), expectedPreview: claim.expectedPreview, claimToken: claim.token,
        ...(scope?.branch === "future" ? { futureProofHash: scope.proofHash } : {}),
        ...(priorEventId ? { priorEventId } : {}), ...(manualOpeningPoint ? { manualHandoverId: manualOpeningPoint.id, manualHandoverPlanHash: manualOpeningPoint.planHash } : {}) },
    }).where(and(eq(financialForHirePoEvents.id, eventId), eq(financialForHirePoEvents.status, "reserved"), eq(financialForHirePoEvents.processingToken, claim.token)));
    if (Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) !== 1) throw new Error("For Hire payload binding lost its exact event claim.");
  });
}

type ForHireWriteAccessInput = {
  eventId: number;
  releaseKey: string;
  payload: FinancialDraftPayload;
  workflowType: "initial_for_hire" | "recurring_for_hire";
  preparedBy: number;
};
type ForHirePayloadAuthorisation = {
  hash?: string; number?: string; bodyHash?: string; expectedPreview?: ForHirePreviewVersion;
  claimToken?: string; manualHandoverId?: number; manualHandoverPlanHash?: string;
  priorEventId?: number; futureProofHash?: string;
};
/** Safe local identity captured before auth refresh/tenant FIFO; never a new approval. */
export type ForHireQueuedReservation = { claimToken: string; authorisationHash: string; preview: ForHirePreviewVersion };

/**
 * DB-only final guard inside the actual queued POST callback. Never invoke the
 * full source/Xero verifier here: its queued GETs would deadlock the tenant FIFO.
 */
export async function verifyForHireQueuedWriteAccess(input: ForHireWriteAccessInput & { reservation: ForHireQueuedReservation }): Promise<void> {
  if (!["initial_for_hire", "recurring_for_hire"].includes(input.workflowType)) throw new Error("For Hire queued access requires its exact workflow family.");
  const phase = input.workflowType === "initial_for_hire" ? "initial" : "recurring";
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, phase);
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const readEvent = () => db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, input.eventId)).limit(1);
  const event = (await readEvent())[0];
  const auth = event?.authorisedPayload as ForHirePayloadAuthorisation | null;
  const assertReservation = (row: FinancialForHirePoEvent | undefined, currentPolicy: ForHireReleasePolicy) => {
    const currentAuth = row?.authorisedPayload as ForHirePayloadAuthorisation | null;
    if (!row || row.id !== input.eventId || row.status !== "reserved" || !input.reservation?.claimToken ||
      row.processingToken !== input.reservation.claimToken || currentAuth?.claimToken !== input.reservation.claimToken ||
      row.releaseKey !== input.releaseKey || currentPolicy.releaseKey !== input.releaseKey || currentPolicy.approvedBy !== input.preparedBy ||
      row.eventKind !== phase || !currentAuth?.expectedPreview ||
      financialSha256(currentAuth) !== input.reservation.authorisationHash ||
      !matchesForHirePreviewVersion(row, input.reservation.preview) ||
      financialSha256(currentAuth.expectedPreview) !== financialSha256(input.reservation.preview) ||
      currentAuth.hash !== forHirePayloadHash(input.payload) || currentAuth.number !== input.payload.documentNumber ||
      currentAuth.bodyHash !== financialSha256(input.payload.body)) {
      throw new Error("For Hire queued transport lost its current release-backed exact reservation, preview or token.");
    }
  };
  assertReservation(event, policy);
  if (input.payload.method !== "POST" || input.payload.endpoint !== "/PurchaseOrders" || input.payload.documentFamily !== "purchase_order" || input.payload.expectedXeroDocumentId ||
    financialSha256(await expectedForHirePayload(event)) !== financialSha256(input.payload)) {
    throw new Error("For Hire queued transport body differs from its exact claimed Draft preview.");
  }
  const readOpening = () => db.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, event.containerControlId)).limit(1);
  const opening = (await readOpening())[0];
  const openingHash = financialSha256(opening ?? null);
  if (auth!.manualHandoverId !== undefined) {
    if (phase !== "recurring" || process.env.FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED !== "true" || !opening ||
      opening.id !== auth!.manualHandoverId || opening.planHash !== auth!.manualHandoverPlanHash || opening.status !== "reserved" ||
      opening.processingToken !== input.reservation.claimToken || opening.firstApEventId !== event.id || !opening.manualCreationStopped ||
      opening.acknowledgement !== "FUTURE_ONLY_MANUAL_PO_HANDOVER" || opening.approvedBy <= 0) {
      throw new Error("For Hire queued transport lost its exact reserved manual opening claim.");
    }
    const plan = opening.plan as MixedManualForHireHandoverPlan;
    if (!plan || plan.planHash !== opening.planHash || plan.containerControlId !== event.containerControlId ||
      (auth!.priorEventId ?? null) !== (plan.priorApAnchor?.id ?? null)) throw new Error("For Hire queued manual opening plan changed.");
    assertManualForHireApHistory(await getForHireEventsForControl(event.containerControlId), plan, { eventId: event.id, token: input.reservation.claimToken });
  } else if (opening) {
    if (phase !== "recurring" || !auth!.priorEventId) throw new Error("For Hire queued transport cannot bypass its manual opening point.");
    const events = await getForHireEventsForControl(event.containerControlId);
    assertForHireOpeningSuccessorChain(events, opening, auth!.priorEventId);
    const prior = events.find(row => row.id === auth!.priorEventId);
    if (!prior) throw new Error("For Hire queued manual successor predecessor is missing.");
    assertForHireRecurringSuccessor(event, prior, (opening.plan as MixedManualForHireHandoverPlan).containerControlNumber);
  }
  const scope = phase === "recurring" ? await assertForHireRecurringScopeForControl(policy, event.containerControlId,
    auth!.manualHandoverId === undefined ? auth!.priorEventId : undefined,
    { reader: db, currentEvent: event, expectedProofHash: auth!.futureProofHash }) : undefined;
  if (scope?.branch === "future" && (!auth!.futureProofHash || scope.proofHash !== auth!.futureProofHash)) {
    throw new Error("For Hire queued transport requires its exact stored future ancestor proof hash.");
  }
  // Last awaited reads share the smallest practical window. All checks below
  // are synchronous: no HTTP, further DB reads, or nested queue before POST.
  const [lastPolicy, lastEvents, lastOpenings] = await Promise.all([getForHireReleasePolicy(), readEvent(), readOpening()]);
  assertForHireRelease(lastPolicy, phase);
  if (financialSha256(lastPolicy) !== financialSha256(policy)) throw new Error("For Hire policy changed during queued transport revalidation.");
  assertReservation(lastEvents[0], lastPolicy);
  if (financialSha256(lastOpenings[0] ?? null) !== openingHash ||
    (auth!.manualHandoverId !== undefined && process.env.FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED !== "true")) {
    throw new Error("For Hire manual opening changed during queued transport revalidation.");
  }
  if (phase === "recurring") assertForHireRecurringControlAllowed(lastPolicy, event.containerControlId, scope?.branch === "future" ? scope.proof : undefined);
  if (phase === "recurring") {
    const today = Temporal.Now.zonedDateTimeISO("Australia/Sydney").toPlainDate().toString();
    const current = lastEvents[0];
    if (today < current.billingPeriodStart || today > current.billingPeriodEnd) throw new Error("For Hire queued recurring period is not currently due or has expired; no historical catch-up is permitted.");
  }
}

/** Full current-source/Xero verification stays outside the tenant transport FIFO. */
export async function verifyForHireAutomaticWriteAccess(input: ForHireWriteAccessInput,
  captureReservation?: (reservation: ForHireQueuedReservation) => void): Promise<void> {
  const phase = input.workflowType === "initial_for_hire" ? "initial" : "recurring" as const;
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, phase);
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const event = (await db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, input.eventId)).limit(1))[0];
  const auth = event?.authorisedPayload as { hash?: string; number?: string; bodyHash?: string; expectedPreview?: ForHirePreviewVersion; claimToken?: string; manualHandoverId?: number; manualHandoverPlanHash?: string; priorEventId?: number; futureProofHash?: string } | null;
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
  if (phase === "recurring") await assertForHireRecurringScopeForControl(policy, event.containerControlId, auth.manualHandoverId === undefined ? auth.priorEventId : undefined,
    { currentEvent: event, expectedProofHash: auth.futureProofHash });
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
  // Reload policy AFTER all current source/contact/rate reads. An old policy
  // object or previously valid future proof is never revocation authority.
  const finalPolicy = await getForHireReleasePolicy();
  assertForHireRelease(finalPolicy, phase);
  if (finalPolicy.releaseKey !== input.releaseKey || finalPolicy.approvedBy !== input.preparedBy) throw new Error("For Hire release changed during final transport revalidation.");
  if (phase === "recurring") await assertForHireRecurringScopeForControl(finalPolicy, current.containerControlId, auth.manualHandoverId === undefined ? auth.priorEventId : undefined,
    { currentEvent: current, expectedProofHash: auth.futureProofHash });
  const lastPolicy = await getForHireReleasePolicy();
  if (financialSha256(lastPolicy) !== financialSha256(finalPolicy)) throw new Error("For Hire scope changed during final ancestor proof revalidation.");
  assertForHireRelease(lastPolicy, phase);
  captureReservation?.({ claimToken: auth.claimToken!, authorisationHash: financialSha256(auth), preview: { ...auth.expectedPreview! } });
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
    const trustedInitial = authenticatedForHireInitialCreation(event.id);
    if (trustedInitial) {
      if (event.eventKind !== "initial" || input.priorEventId || input.manualOpeningPoint || opening || events.some(row => row.id !== event.id)) throw new Error("Authenticated initial provenance cannot promote existing AP or manual hire history.");
      const completed = (await tx.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, event.id)).limit(1))[0];
      const writer = (await tx.select().from(financialWriterExecutions).where(eq(financialWriterExecutions.id, input.executionId)).limit(1))[0];
      if (!completed || !writer) throw new Error("Authenticated initial provenance requires exact durable successful writer readback.");
      const initialReceipt = buildForHireInitialReceiptSnapshot(completed);
      const collision = (await tx.select().from(financialForHireInitialProvenance).where(or(
        eq(financialForHireInitialProvenance.containerControlId, event.containerControlId), eq(financialForHireInitialProvenance.initialEventId, event.id),
      )).for("update"))[0];
      if (collision) throw new Error("Immutable authenticated initial For Hire provenance already exists; reconcile without overwriting or retrying.");
      const provenance = { containerControlId: completed.containerControlId, initialEventId: completed.id,
        origin: trustedInitial.origin, initialCreatedAt: completed.createdAt, initialWriterExecutionId: writer.id,
        initialXeroPurchaseOrderId: input.xeroPurchaseOrderId, initialReleaseKey: completed.releaseKey!, initialRulesHash: completed.rulesSnapshotHash,
        initialSourceSnapshotHash: completed.sourceSnapshotHash, initialReceiptHash: financialSha256(initialReceipt), initialReceipt, recordedAt: new Date() };
      buildVerifiedForHireFutureChainProof({ provenance, events: [completed], writers: [writer], priorEventId: completed.id });
      await tx.insert(financialForHireInitialProvenance).values(provenance);
    }
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
