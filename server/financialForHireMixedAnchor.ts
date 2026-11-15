import { Temporal } from "@js-temporal/polyfill";
import type { FinancialForHirePoEvent } from "../drizzle/schema";
import type { ManualForHireHandoverPlan } from "./financialForHireManualHandoverRules";
import { financialSha256 } from "./financialProposalIntegrity";
import { parseForHireReferenceSuffix } from "./financialForHireNumbering";

/** Immutable AP evidence only. Due markers, update times and claims are not signed history. */
export type PriorForHireApAnchor = {
  id: number;
  containerControlId: string;
  eventKind: "initial" | "recurring";
  proposedPoNumber: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  xeroPurchaseOrderId: string;
  executionId: number;
  proposalHash: string;
};
export type MixedManualForHireHandoverPlan = ManualForHireHandoverPlan & {
  mixedHistoryVersion: "manual-ap-mixed/v1";
  priorApAnchor: PriorForHireApAnchor | null;
  supplierHistory: {
    manualContactId: string;
    manualContactName: string | null;
    currentSupplierVtigerId: string;
    currentSupplierName: string;
    currentContactId: string;
  };
};
const fail = (): never => { throw new Error("AP-created, claimed or uncertain hire history differs from the exact approved prior AP anchor; reconcile before manual handover."); };
function strictDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Temporal.PlainDate.from(value).toString() !== value) fail();
  return value;
}
export function forHireApAnchor(event: FinancialForHirePoEvent): PriorForHireApAnchor {
  if (event.status !== "drafts_created" || event.processingToken || !Number.isSafeInteger(event.id) || event.id <= 0
    || !event.xeroPurchaseOrderId || !Number.isSafeInteger(event.executionId) || Number(event.executionId) <= 0
    || !event.proposal || !["initial", "recurring"].includes(event.eventKind)) fail();
  strictDate(event.billingPeriodStart); strictDate(event.billingPeriodEnd);
  if (event.billingPeriodStart > event.billingPeriodEnd) fail();
  return { id: event.id, containerControlId: event.containerControlId, eventKind: event.eventKind,
    proposedPoNumber: event.proposedPoNumber, billingPeriodStart: event.billingPeriodStart,
    billingPeriodEnd: event.billingPeriodEnd, xeroPurchaseOrderId: event.xeroPurchaseOrderId!,
    executionId: event.executionId!, proposalHash: financialSha256(event.proposal) };
}
export function latestForHireApAnchor(events: readonly FinancialForHirePoEvent[]): PriorForHireApAnchor | null {
  if (events.some(event => event.processingToken || ["reserved", "reconciliation_required"].includes(event.status))) fail();
  const completed = events.filter(event => event.status === "drafts_created")
    .sort((a, b) => b.billingPeriodEnd.localeCompare(a.billingPeriodEnd) || b.id - a.id);
  return completed.length ? forHireApAnchor(completed[0]!) : null;
}
/** Bind BEFORE approval: rebuild uses this same body rather than patching a signed hash. */
export function bindManualForHireMixedHistory(plan: ManualForHireHandoverPlan, anchor: PriorForHireApAnchor | null, manualContact: { ContactID?: string; Name?: string }): MixedManualForHireHandoverPlan {
  if (anchor) {
    const ordinal = parseForHireReferenceSuffix(plan.containerControlNumber, anchor.proposedPoNumber);
    if (anchor.containerControlId !== plan.containerControlId || ordinal === null || plan.manualSuffix <= ordinal
      || (anchor.eventKind === "initial" ? ordinal !== 0 : ordinal < 1)
      || anchor.billingPeriodEnd > plan.coveredThrough || anchor.xeroPurchaseOrderId === plan.manualPoId
      || (plan.manualPeriodStart !== null && anchor.billingPeriodEnd >= plan.manualPeriodStart)) fail();
  }
  if (manualContact.ContactID !== plan.supplierContactId) fail(); // No supplier identity override.
  const { planHash: _hash, ...unsigned } = plan;
  const body = { ...unsigned, mixedHistoryVersion: "manual-ap-mixed/v1" as const, priorApAnchor: anchor,
    supplierHistory: { manualContactId: manualContact.ContactID!, manualContactName: manualContact.Name ?? null,
      currentSupplierVtigerId: plan.supplierVtigerId, currentSupplierName: plan.supplierName, currentContactId: plan.supplierContactId } };
  return { ...body, planHash: financialSha256(body) };
}
/** Older immutable receipts may remain history; no later/uncertain/other reserved receipt may appear. */
export function assertManualForHireApHistory(events: readonly FinancialForHirePoEvent[], plan: MixedManualForHireHandoverPlan,
  ownReservation?: { eventId: number; token: string }) {
  const { planHash, ...unsignedPlan } = plan;
  if (plan.mixedHistoryVersion !== "manual-ap-mixed/v1" || !("priorApAnchor" in plan) || financialSha256(unsignedPlan) !== planHash) fail();
  let found = plan.priorApAnchor === null;
  for (const event of events) {
    if (event.containerControlId !== plan.containerControlId) fail();
    if (ownReservation?.eventId === event.id) {
      if (event.status !== "reserved" || event.processingToken !== ownReservation.token || event.eventKind !== "recurring"
        || event.proposedPoNumber !== plan.nextPoNumber || event.billingPeriodStart !== plan.nextPeriodStart || event.billingPeriodEnd !== plan.nextPeriodEnd) fail();
      continue;
    }
    if (event.processingToken || ["reserved", "reconciliation_required"].includes(event.status)) fail();
    if (event.status !== "drafts_created") continue;
    const anchor = forHireApAnchor(event);
    const approvedAnchor = plan.priorApAnchor;
    if (!approvedAnchor) return fail();
    if (event.id === approvedAnchor.id) {
      if (financialSha256(anchor) !== financialSha256(approvedAnchor)) fail();
      found = true;
    } else if (event.billingPeriodEnd >= approvedAnchor.billingPeriodStart || event.id > approvedAnchor.id) fail();
  }
  if (!found || (ownReservation && !events.some(event => event.id === ownReservation.eventId))) fail();
}
export function assertForHireRecurringSuccessor(current: FinancialForHirePoEvent, previous: FinancialForHirePoEvent, controlNumber: string) {
  const before = parseForHireReferenceSuffix(controlNumber, previous.proposedPoNumber);
  const after = parseForHireReferenceSuffix(controlNumber, current.proposedPoNumber);
  if (before === null || after === null || after !== before + 1 || current.id <= previous.id
    || current.eventKind !== "recurring" || current.containerControlId !== previous.containerControlId
    || previous.status !== "drafts_created" || previous.processingToken || !previous.xeroPurchaseOrderId || !previous.executionId
    || Temporal.PlainDate.from(previous.billingPeriodEnd).add({ days: 1 }).toString() !== current.billingPeriodStart
    || Temporal.PlainDate.from(current.billingPeriodStart).add({ days: 29 }).toString() !== current.billingPeriodEnd) {
    throw new Error("Completed manual opening point requires its exact consecutive verified AP successor period and number.");
  }
}
/** A completed opening is not permission to resume its older AP root. Links are AP-owned payload metadata. */
export function assertForHireOpeningSuccessorChain(events: readonly FinancialForHirePoEvent[], opening: {
  id: number; status: string; firstApEventId: number | null; planHash: string; plan: unknown;
}, priorEventId: number): void {
  if (opening.status !== "completed" || !opening.firstApEventId) throw new Error("This control's manual opening point blocks ordinary recurrence until its exact first AP Draft is completed.");
  const plan = opening.plan as MixedManualForHireHandoverPlan;
  const { planHash, ...unsignedPlan } = plan;
  if (plan.mixedHistoryVersion !== "manual-ap-mixed/v1" || financialSha256(unsignedPlan) !== planHash || planHash !== opening.planHash) throw new Error("Completed manual opening point integrity failed.");
  const seen = new Set<number>();
  let current = events.find(event => event.id === priorEventId);
  while (current) {
    if (seen.has(current.id) || current.status !== "drafts_created" || current.processingToken || !current.xeroPurchaseOrderId || !current.executionId) break;
    seen.add(current.id);
    const auth = current.authorisedPayload as { manualHandoverId?: number; manualHandoverPlanHash?: string; priorEventId?: number } | null;
    if (current.id === opening.firstApEventId) {
      if (auth?.manualHandoverId === opening.id && auth.manualHandoverPlanHash === opening.planHash
        && plan.planHash === opening.planHash && current.containerControlId === plan.containerControlId
        && current.eventKind === "recurring"
        && current.proposedPoNumber === plan.nextPoNumber && current.billingPeriodStart === plan.nextPeriodStart
        && current.billingPeriodEnd === plan.nextPeriodEnd) return;
      break;
    }
    const previous = events.find(event => event.id === auth?.priorEventId);
    if (!previous) break;
    try { assertForHireRecurringSuccessor(current, previous, plan.containerControlNumber); } catch { break; }
    current = previous;
  }
  throw new Error("Only verified AP recurring successors of the completed manual opening point may continue; the older AP anchor cannot resume.");
}
