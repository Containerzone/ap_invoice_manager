import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { financialForHireInitialProvenance, financialForHirePoEvents, financialForHireManualHandovers, financialWriterExecutions, type FinancialForHirePoEvent, type FinancialWriterExecution } from "../drizzle/schema";
import { getDb } from "./db";
import { assertForHireRecurringControlAllowed, type ForHireReleasePolicy } from "./financialForHireRelease";
import { buildVerifiedForHireFutureChainProof, FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH, FOR_HIRE_FUTURE_INITIAL_ORIGIN } from "./financialForHireFutureEligibility";
import { financialSha256 } from "./financialProposalIntegrity";
import { assertForHireRecurringSuccessor } from "./financialForHireMixedAnchor";

export const AUTHENTICATED_INITIAL_FOR_HIRE_ORIGIN = "authenticated_initial_for_hire_webhook" as const;
/** Server-only argument. Never parsed, copied or reconstructed from webhook JSON. */
export type ForHireInitialServerContext = { origin: typeof AUTHENTICATED_INITIAL_FOR_HIRE_ORIGIN; receivedAt: Date };
const initialContext = new AsyncLocalStorage<{ context: ForHireInitialServerContext; newInitialEventIds: Set<number> }>();
export function withForHireInitialServerContext<T>(context: ForHireInitialServerContext | undefined, callback: () => Promise<T>): Promise<T> {
  if (!context) return callback();
  if (context.origin !== AUTHENTICATED_INITIAL_FOR_HIRE_ORIGIN || !(context.receivedAt instanceof Date) || !Number.isFinite(context.receivedAt.getTime())) throw new Error("Invalid trusted initial For Hire server context.");
  return initialContext.run({ context: Object.freeze({ ...context }), newInitialEventIds: new Set() }, callback);
}
export function markNewAuthenticatedForHireInitial(eventId: number): void { initialContext.getStore()?.newInitialEventIds.add(eventId); }
export function authenticatedForHireInitialCreation(eventId: number): ForHireInitialServerContext | undefined {
  const scope = initialContext.getStore();
  return scope?.newInitialEventIds.has(eventId) ? scope.context : undefined;
}

export type ForHireRecurringScope = { branch: "explicit" } | { branch: "future"; proof: ReturnType<typeof buildVerifiedForHireFutureChainProof>; proofHash: string };
/** A hard resource ceiling fails closed rather than truncating an ancestor chain. */
export const FOR_HIRE_FUTURE_CHAIN_MAX_EVENTS = FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH;
type DbReader = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Loads ONLY exact control provenance, exact ancestor IDs and exact writer IDs. */
export async function loadForHireFutureChainProof(controlId: string, priorEventId: number, reader?: DbReader, currentEvent?: FinancialForHirePoEvent) {
  if (!/^\d+x\d+$/.test(controlId) || !Number.isSafeInteger(priorEventId) || priorEventId <= 0) throw new Error("Future For Hire scope requires an exact verified AP predecessor.");
  const db = reader ?? await getDb();
  if (!db) throw new Error("AP For Hire future provenance ledger is unavailable.");
  const opening = (await db.select().from(financialForHireManualHandovers).where(eq(financialForHireManualHandovers.containerControlId, controlId)).limit(1))[0];
  if (opening) throw new Error("A reviewed manual overlay requires explicit recurring control authority; it cannot use automatic future provenance.");
  const uncertain = (await db.select().from(financialForHirePoEvents).where(and(eq(financialForHirePoEvents.containerControlId, controlId),
    currentEvent ? ne(financialForHirePoEvents.id, currentEvent.id) : undefined,
    or(isNotNull(financialForHirePoEvents.processingToken), inArray(financialForHirePoEvents.status, ["reserved", "reconciliation_required"])))).limit(1))[0];
  if (uncertain) throw new Error("Future For Hire control has claimed or uncertain AP history; reconcile before recurrence.");
  const latest = (await db.select().from(financialForHirePoEvents).where(and(eq(financialForHirePoEvents.containerControlId, controlId), eq(financialForHirePoEvents.status, "drafts_created")))
    .orderBy(desc(financialForHirePoEvents.billingPeriodEnd), desc(financialForHirePoEvents.id)).limit(1))[0];
  if (!latest || latest.id !== priorEventId) throw new Error("Future For Hire selected predecessor is no longer the latest verified AP Draft.");
  const provenance = (await db.select().from(financialForHireInitialProvenance).where(eq(financialForHireInitialProvenance.containerControlId, controlId)).limit(1))[0];
  if (!provenance || provenance.origin !== FOR_HIRE_FUTURE_INITIAL_ORIGIN) throw new Error("No authenticated new initial For Hire provenance exists for this control.");
  const events: FinancialForHirePoEvent[] = [];
  const writers: FinancialWriterExecution[] = [];
  const seen = new Set<number>();
  let eventId = priorEventId;
  while (true) {
    if (events.length >= FOR_HIRE_FUTURE_CHAIN_MAX_EVENTS || seen.has(eventId)) throw new Error("Future For Hire ancestor chain is cyclic, incomplete or exceeds its verification bound.");
    seen.add(eventId);
    const event = (await db.select().from(financialForHirePoEvents).where(eq(financialForHirePoEvents.id, eventId)).limit(1))[0];
    if (!event || event.containerControlId !== controlId) throw new Error("Future For Hire ancestor is missing or belongs to another control.");
    events.push(event);
    if (!event.executionId) throw new Error("Future For Hire ancestor has no successful exact writer.");
    const writer = (await db.select().from(financialWriterExecutions).where(eq(financialWriterExecutions.id, event.executionId)).limit(1))[0];
    if (!writer) throw new Error("Future For Hire exact writer evidence is missing.");
    writers.push(writer);
    if (event.id === provenance.initialEventId) break;
    const auth = event.authorisedPayload as { priorEventId?: number } | null;
    if (!Number.isSafeInteger(auth?.priorEventId) || Number(auth?.priorEventId) <= 0) throw new Error("Future For Hire successor has no exact AP-owned ancestor link.");
    eventId = auth!.priorEventId!;
  }
  const completedHistory = await db.select().from(financialForHirePoEvents).where(and(eq(financialForHirePoEvents.containerControlId, controlId),
    eq(financialForHirePoEvents.status, "drafts_created"))).limit(FOR_HIRE_FUTURE_CHAIN_MAX_EVENTS + 1);
  if (completedHistory.length > FOR_HIRE_FUTURE_CHAIN_MAX_EVENTS || completedHistory.some(event => !seen.has(event.id))) throw new Error("Future For Hire control contains disconnected or excessive verified AP history outside its exact chain.");
  if (currentEvent) {
    if (!["previewed", "reserved"].includes(currentEvent.status)) throw new Error("Future For Hire candidate is not an exact current preview or reservation.");
    const previous = events[0]!;
    // Ordinary AP unsuffixed INITIAL is ordinal one, unlike manual overlays.
    assertForHireRecurringSuccessor(currentEvent, previous.eventKind === "initial" ? { ...previous, proposedPoNumber: `${previous.proposedPoNumber}-1` } : previous, events.at(-1)!.containerControlNumber);
  }
  return buildVerifiedForHireFutureChainProof({ provenance: { ...provenance, origin: FOR_HIRE_FUTURE_INITIAL_ORIGIN }, events, writers, priorEventId,
    // Unbound previews intentionally have no release/auth yet; the exact
    // successor fields above are checked before claim, then full auth at wire.
    ...(currentEvent?.authorisedPayload && currentEvent.releaseKey ? { currentEvent } : {}) });
}

/** No predecessor means explicit-only authority, used for reviewed manual openings. */
export async function assertForHireRecurringScopeForControl(policy: ForHireReleasePolicy, controlId: string, priorEventId?: number | null,
  options?: { reader?: DbReader; currentEvent?: FinancialForHirePoEvent; expectedProofHash?: string }): Promise<ForHireRecurringScope> {
  if (policy.recurringControlIds?.includes(controlId)) {
    assertForHireRecurringControlAllowed(policy, controlId);
    return { branch: "explicit" };
  }
  // Reject disabled/invalid future scope before touching the database.
  if (!policy.recurringFutureInitialsEnabled || !priorEventId || !policy.recurringFutureInitialsFrom ||
    !Number.isFinite(Date.parse(policy.recurringFutureInitialsFrom)) || policy.recurringFutureExcludedControlIds?.includes(controlId)) {
    assertForHireRecurringControlAllowed(policy, controlId);
    throw new Error("This control has no explicit reviewed recurring For Hire authority.");
  }
  const proof = await loadForHireFutureChainProof(controlId, priorEventId, options?.reader, options?.currentEvent);
  assertForHireRecurringControlAllowed(policy, controlId, proof);
  const proofHash = financialSha256(proof);
  if (options?.expectedProofHash && options.expectedProofHash !== proofHash) throw new Error("Future For Hire exact ancestor proof changed after selection or claim.");
  return { branch: "future", proof, proofHash };
}
