import { Temporal } from "@js-temporal/polyfill";
import { readForHireContainerControl } from "./financialForHireService";
import { getForHireEventsForControl } from "./financialForHireDb";
import { readManualForHireHandoverXeroEvidence, preflightFinancialXeroIntents } from "./financialReadOnlyXeroService";
import { buildRecurringForHirePo, type ForHireContainerControlFacts } from "./financialForHireDrafts";
import { buildManualForHireHandoverPlan, manualForHireSourceIdentityHash, manualForHireEvidenceHash, MANUAL_FOR_HIRE_HANDOVER_RULES_HASH, type ManualForHireHandoverPlan } from "./financialForHireManualHandoverRules";
import { financialSha256 } from "./financialProposalIntegrity";
import { isManualForHireHandoverEnabled, getManualForHireHandover, approveManualForHireHandover } from "./financialForHireManualHandoverDb";
import type { FinancialDraftPayload } from "./financialProductionWriter";

export type ManualForHirePreviewInput = { recordId: string; manualPoNumber: string; coveredThrough: string; effectiveFrom: string; confirmedLatestCoverage: boolean; confirmedNoOtherFutureCoverage: boolean; reviewedBy: number; expectedControlNumber?: string };
const today = () => Temporal.Now.zonedDateTimeISO("Australia/Sydney").toPlainDate().toString();
const safeError = (error: unknown) => error instanceof Error ? error.message : "Manual hire coverage could not be verified; no financial write occurred.";

async function assertNoCompetingApReceipt(recordId: string, allowedEventId?: number | null) {
  const events = await getForHireEventsForControl(recordId);
  if (events.some(event => ["reserved", "drafts_created", "reconciliation_required"].includes(event.status) && event.id !== allowedEventId)) {
    throw new Error("An AP-created, claimed or uncertain hire receipt already exists. Use its verified lifecycle or reconcile it; do not replace it with manual history.");
  }
}
async function collectManualForHirePlan(input: ManualForHirePreviewInput, now = today()) {
  const facts = await readForHireContainerControl(input.recordId);
  if (input.expectedControlNumber && facts.controlNumber !== input.expectedControlNumber) throw new Error("Current Container Control number changed after the exact lookup; no handover was saved.");
  await assertNoCompetingApReceipt(input.recordId);
  const existing = await getManualForHireHandover(input.recordId);
  if (existing) throw new Error("This Container Control already has an immutable manual hire handover. It cannot be overwritten or re-enrolled.");
  const rawEvidence = await readManualForHireHandoverXeroEvidence({ manualPoNumber: input.manualPoNumber.trim().toUpperCase(), controlNumber: facts.controlNumber, supplierName: facts.supplierName });
  const evidence = { ...rawEvidence, coverageAttestation: input.confirmedLatestCoverage === true && input.confirmedNoOtherFutureCoverage === true && Number.isSafeInteger(input.reviewedBy) && input.reviewedBy > 0 ? { confirmedLatestCoverage: input.confirmedLatestCoverage, confirmedNoOtherFutureCoverage: input.confirmedNoOtherFutureCoverage, reviewedBy: input.reviewedBy } : undefined };
  const plan = buildManualForHireHandoverPlan({ facts, evidence, manualPoNumber: input.manualPoNumber, coveredThrough: input.coveredThrough, effectiveFrom: input.effectiveFrom, now });
  return { facts, evidence, plan };
}
async function indicativeNextProposal(facts: ForHireContainerControlFacts, plan: ManualForHireHandoverPlan) {
  const stub = buildRecurringForHirePo({ facts, priorPeriodEnd: plan.coveredThrough, lastVerifiedExtensionSuffix: plan.manualSuffix === 1 ? null : plan.manualSuffix, purchaseRate: 1, now: plan.nextPeriodStart });
  if (!stub.document) throw new Error(stub.holdReason ?? "Manual handover cannot form the next consecutive 30-day period.");
  const [preflight] = await preflightFinancialXeroIntents([stub.document]);
  const code = stub.document.lineItems[0]!.itemCode;
  const item = preflight?.itemChecks.find(candidate => candidate.itemCode === code && candidate.found);
  if (preflight?.duplicateState !== "not_found" || !preflight.contactCheck.found || preflight.contactCheck.contactId !== plan.supplierContactId || !item || !Number.isFinite(item.purchaseUnitPrice) || Number(item.purchaseUnitPrice) <= 0) {
    throw new Error("Next manual-handover PO number, exact supplier or current purchase-side daily rate is not clear. No collision bypass is allowed.");
  }
  const built = buildRecurringForHirePo({ facts, priorPeriodEnd: plan.coveredThrough, lastVerifiedExtensionSuffix: plan.manualSuffix === 1 ? null : plan.manualSuffix, purchaseRate: item.purchaseUnitPrice, itemNativeDescription: item.nativeDescription, now: plan.nextPeriodStart });
  if (!built.document || built.proposedPoNumber !== plan.nextPoNumber || built.periodStart !== plan.nextPeriodStart || built.periodEnd !== plan.nextPeriodEnd) throw new Error("Manual hire next-period proposal does not match the verified opening point.");
  built.document.partySourceId = plan.supplierContactId;
  return built.document;
}

/** Read-only financial preview; unlike the normal preview, this creates no AP PO event. */
export async function previewManualForHireHandover(input: ManualForHirePreviewInput) {
  try {
    const { facts, evidence, plan } = await collectManualForHirePlan(input);
    const proposal = await indicativeNextProposal(facts, plan);
    return { state: "ready" as const, plan, proposal, holdReason: null, noFinancialWrites: true as const, enrollmentEnabled: isManualForHireHandoverEnabled(), evidence };
  } catch (error) {
    return { state: "held" as const, plan: null, proposal: null, holdReason: safeError(error), noFinancialWrites: true as const, enrollmentEnabled: isManualForHireHandoverEnabled(), evidence: null };
  }
}
export async function enrollManualForHireHandover(input: ManualForHirePreviewInput & { expectedPlanHash: string; approvedBy: number; manualCreationStopped: true; acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" }) {
  if (!isManualForHireHandoverEnabled()) throw new Error("Manual hire handover enrollment is disabled. This release does not activate recurring billing.");
  if (!Number.isSafeInteger(input.approvedBy) || input.approvedBy <= 0 || input.reviewedBy !== input.approvedBy || input.confirmedLatestCoverage !== true || input.confirmedNoOtherFutureCoverage !== true || input.manualCreationStopped !== true || input.acknowledgement !== "FUTURE_ONLY_MANUAL_PO_HANDOVER") throw new Error("Exact administrator approval and stopped manual recurring creation are required before handover reads.");
  const { facts, evidence, plan } = await collectManualForHirePlan(input);
  if (plan.planHash !== input.expectedPlanHash) throw new Error("Manual hire handover evidence changed since preview. Preview and approve the exact current opening point again.");
  await indicativeNextProposal(facts, plan);
  return approveManualForHireHandover({ plan, evidence, approvedBy: input.approvedBy, manualCreationStopped: input.manualCreationStopped, acknowledgement: input.acknowledgement });
}

/** Only the approved opening point may supply a first predecessor; it is never a drafts_created event. */
export async function revalidateManualForHireOpeningPoint(input: { recordId: string; handoverId: number; facts?: ForHireContainerControlFacts; now?: string; allowReservedEventId?: number; token?: string }) {
  if (!isManualForHireHandoverEnabled()) throw new Error("Manual hire handover execution is disabled.");
  const row = await getManualForHireHandover(input.recordId);
  if (!row || row.id !== input.handoverId || !row.manualCreationStopped || row.acknowledgement !== "FUTURE_ONLY_MANUAL_PO_HANDOVER" || row.approvedBy <= 0) throw new Error("No exact approved manual hire opening point exists.");
  const reserved = input.allowReservedEventId !== undefined;
  if (reserved ? row.status !== "reserved" || row.firstApEventId !== input.allowReservedEventId || row.processingToken !== input.token : row.status !== "approved" || row.processingToken || row.firstApEventId) {
    throw new Error("Manual hire opening point is claimed, completed, dehired or awaiting reconciliation; it cannot be replayed.");
  }
  const plan = row.plan as ManualForHireHandoverPlan;
  const { planHash: _planHash, ...unsignedPlan } = plan;
  if (plan.planHash !== row.planHash || financialSha256(unsignedPlan) !== row.planHash || plan.rulesHash !== MANUAL_FOR_HIRE_HANDOVER_RULES_HASH || plan.manualPoId !== row.manualPoId || plan.manualPoNumber !== row.manualPoNumber || plan.coveredThrough !== row.coveredThrough || (row.status === "approved" && row.nextBillingDate !== plan.nextPeriodStart)) throw new Error("Manual hire opening point integrity verification failed.");
  const facts = input.facts ?? await readForHireContainerControl(input.recordId);
  if (facts.acquisition.trim().toUpperCase() !== "FOR HIRE" || !["ON HIRE", "IDLE"].includes(facts.status.trim().toUpperCase()) || manualForHireSourceIdentityHash(facts) !== plan.sourceIdentityHash) throw new Error("Current container, acquisition or assigned supplier differs from the approved opening point.");
  await assertNoCompetingApReceipt(input.recordId, input.allowReservedEventId);
  const now = input.now ?? today();
  if (now < plan.effectiveFrom || now > plan.nextPeriodEnd) throw new Error("Manual hire handover is not effective or its first period has expired. No historical catch-up is permitted.");
  const rawEvidence = await readManualForHireHandoverXeroEvidence({ manualPoNumber: plan.manualPoNumber, controlNumber: facts.controlNumber, supplierName: facts.supplierName });
  const evidence = { ...rawEvidence, coverageAttestation: (row.evidence as any)?.coverageAttestation };
  if (evidence.supplierContactId !== plan.supplierContactId || manualForHireEvidenceHash(evidence) !== plan.xeroEvidenceHash) throw new Error("Manual PO coverage, current Xero supplier or retained Accounts confirmation changed after approval; hold for reconciliation.");
  // Rebuild at the approved date to prove business evidence, without interpreting
  // a delayed due callback as authorisation to create older catch-up periods.
  const rebuilt = buildManualForHireHandoverPlan({ facts, evidence, manualPoNumber: plan.manualPoNumber, coveredThrough: plan.coveredThrough, effectiveFrom: plan.effectiveFrom, now: plan.effectiveFrom });
  if (rebuilt.planHash !== plan.planHash) throw new Error("Manual opening point no longer reconstructs the exact approved plan.");
  return { row, plan, facts };
}
export async function verifyManualForHireFirstWrite(input: { recordId: string; handoverId: number; planHash: string; eventId: number; token: string; payload: FinancialDraftPayload }) {
  const { plan, facts } = await revalidateManualForHireOpeningPoint({ recordId: input.recordId, handoverId: input.handoverId, allowReservedEventId: input.eventId, token: input.token });
  if (today() < plan.nextPeriodStart) throw new Error("The first manual-handover 30-day period is not due; no early PO is permitted.");
  const orders = input.payload.body.PurchaseOrders;
  const order: any = Array.isArray(orders) && orders.length === 1 ? orders[0] : null;
  if (plan.planHash !== input.planHash || input.payload.method !== "POST" || input.payload.endpoint !== "/PurchaseOrders" || input.payload.expectedXeroDocumentId || input.payload.documentNumber !== plan.nextPoNumber || !order || order.Status !== "DRAFT" || order.CurrencyCode !== "AUD" || order.Contact?.ContactID !== plan.supplierContactId || order.Date !== plan.nextPeriodStart || !Array.isArray(order.LineItems) || order.LineItems.length !== 1 || order.LineItems[0].Quantity !== 30 || String(order.LineItems[0].AccountCode) !== "312" || order.LineItems[0].TaxType !== "INPUT" || !["HC 20 E", "HC 40 E"].includes(order.LineItems[0].ItemCode)) throw new Error("Manual hire opening point permits only its exact next AUD 30-day Draft PO.");
  const expectedDocument = await indicativeNextProposal(facts, plan);
  const { prepareFinancialDraftPayload } = await import("./financialProductionWriter");
  const expected = prepareFinancialDraftPayload(expectedDocument, "manual-opening-current-body-check");
  (expected.body.PurchaseOrders as any[])[0].CurrencyCode = "AUD";
  if (financialSha256(expected.body) !== financialSha256(input.payload.body)) throw new Error("Current supplier, daily purchase rate, description, dates or exact first Draft body changed before transport.");
}
