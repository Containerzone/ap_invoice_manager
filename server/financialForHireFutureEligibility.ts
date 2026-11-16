import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { FinancialForHirePoEvent, FinancialWriterExecution } from "../drizzle/schema";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import { financialSha256 } from "./financialProposalIntegrity";
import { assertForHireRecurringSuccessor, forHireApAnchor } from "./financialForHireMixedAnchor";
import { forHireInitialReference } from "./financialForHireNumbering";

export const FOR_HIRE_FUTURE_INITIAL_ORIGIN = "authenticated_initial_for_hire_webhook" as const;
/** Existing AP receipt rules are independently versioned from the standing initial release policy. */
export const FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH = createHash("sha256").update("for-hire-container-control-v1-readiness").digest("hex");
export const FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH = 200;
/** These values must come from the immutable server-owned provenance table, never request input. */
export type ForHireInitialProvenance = Readonly<{
  containerControlId: string;
  initialEventId: number;
  origin: string;
  initialCreatedAt: Date | string;
  initialWriterExecutionId: number;
  initialXeroPurchaseOrderId: string;
  initialReleaseKey: string;
  initialRulesHash: string;
  initialSourceSnapshotHash: string;
  initialReceiptHash: string;
  initialReceipt: unknown;
  recordedAt: Date | string;
}>;
export type ForHireFutureChainEvidence = {
  provenance: ForHireInitialProvenance;
  /** DB-supplied bounded exact ancestry; independent current-control ambiguity checks remain in DB. */
  events: readonly FinancialForHirePoEvent[];
  writers: readonly FinancialWriterExecution[];
  priorEventId: number;
  currentEvent?: FinancialForHirePoEvent;
};
export type VerifiedForHireFutureChainProof = Readonly<{
  containerControlId: string;
  rootInitialEventId: number;
  initialCreatedAt: string;
  initialReleaseKey: string;
  initialRulesHash: string;
  initialApprovedBy: number;
  initialReceiptHash: string;
  currentPredecessorId: number;
  ancestryEventIds: readonly number[];
  ancestryReceiptHashes: readonly string[];
  ancestryWriterHashes: readonly string[];
}>;
// A boolean, JSON object or serialized proof cannot acquire this in-process capability.
const issuedProofs = new WeakSet<object>();
const fail = (): never => { throw new Error("Future For Hire eligibility requires immutable authenticated initial provenance, successful matching writer evidence and an exact verified AP successor chain; reconcile uncertain or historical roots."); };
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, any>;
};
const exactId = (value: unknown): value is string => typeof value === "string" && /^\d+x\d+$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value === value.trim();
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
function timestamp(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return fail();
  try { Temporal.Instant.from(value); return new Date(value).toISOString(); } catch { return fail(); }
}
function strictDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail();
  try { if (Temporal.PlainDate.from(value, { overflow: "reject" }).toString() !== value) return fail(); } catch { return fail(); }
  return value;
}
function immutableAuth(event: FinancialForHirePoEvent) {
  const auth = object(event.authorisedPayload);
  if (!hash(auth.hash) || !hash(auth.bodyHash) || auth.number !== event.proposedPoNumber || !auth.expectedPreview) return fail();
  return { hash: auth.hash, number: auth.number, bodyHash: auth.bodyHash, expectedPreview: auth.expectedPreview,
    ...(auth.priorEventId !== undefined ? { priorEventId: auth.priorEventId } : {}),
    ...(auth.manualHandoverId !== undefined ? { manualHandoverId: auth.manualHandoverId } : {}),
    ...(auth.manualHandoverPlanHash !== undefined ? { manualHandoverPlanHash: auth.manualHandoverPlanHash } : {}) };
}
/** Canonical receipt projection. Deliberately excludes update/due/claim tokens and other mutable housekeeping. */
export function buildForHireInitialReceiptSnapshot(event: FinancialForHirePoEvent) {
  forHireApAnchor(event);
  if (event.eventKind !== "initial" || !exactId(event.containerControlId) || !text(event.releaseKey)
    || !hash(event.sourceSnapshotHash) || !hash(event.rulesSnapshotHash) || !hash(event.xeroPreflightHash)) return fail();
  const authorisedPayload = immutableAuth(event);
  if (authorisedPayload.priorEventId !== undefined || authorisedPayload.manualHandoverId !== undefined || authorisedPayload.manualHandoverPlanHash !== undefined) return fail();
  return JSON.parse(JSON.stringify({ receiptVersion: "for-hire-authenticated-initial/v1", id: event.id,
    containerControlId: event.containerControlId, containerControlNumber: event.containerControlNumber,
    eventKind: event.eventKind, billingPeriodStart: strictDate(event.billingPeriodStart), billingPeriodEnd: strictDate(event.billingPeriodEnd),
    proposedPoNumber: event.proposedPoNumber, containerNumber: event.containerNumber, containerType: event.containerType,
    supplierVtigerId: event.supplierVtigerId, supplierName: event.supplierName,
    sourceSnapshotHash: event.sourceSnapshotHash, rulesSnapshotHash: event.rulesSnapshotHash,
    xeroPreflightHash: event.xeroPreflightHash, proposal: event.proposal, xeroPreflight: event.xeroPreflight,
    releaseKey: event.releaseKey, authorisedPayload, executionId: event.executionId,
    xeroPurchaseOrderId: event.xeroPurchaseOrderId, createdAt: timestamp(event.createdAt) }));
}
/** Reconstruct the existing writer's canonical PO payload without importing any live writer/DB code. */
function expectedPayload(event: FinancialForHirePoEvent): FinancialDraftPayload {
  const document = object(event.proposal) as ProposedFinancialDocument;
  const workflowType = event.eventKind === "initial" ? "initial_for_hire" : "recurring_for_hire";
  if (document.documentFamily !== "purchase_order" || document.documentType !== workflowType || document.proposedAction !== "create_draft"
    || document.proposedDocumentNumber !== event.proposedPoNumber || document.sourceRecordId !== event.containerControlId
    || document.sourceWorkflow !== (event.eventKind === "initial" ? "container_control_acquisition" : "recurring_for_hire")
    || document.reference !== event.containerControlNumber || document.validationStatus !== "valid" || document.currency !== "AUD"
    || !text(document.partySourceId) || !Array.isArray(document.lineItems) || document.lineItems.length === 0
    || !Number.isFinite(document.total)) return fail();
  const idempotencyKey = createHash("sha256").update(JSON.stringify({
    workflowIdempotencyKey: `${event.containerControlId}:${event.eventKind}:${event.billingPeriodStart}`,
    documentFamily: document.documentFamily, documentType: document.documentType, number: event.proposedPoNumber,
    action: document.proposedAction, targetId: null, total: document.total.toFixed(2),
    lines: document.lineItems.map(line => ({ itemCode: line.itemCode, description: line.description,
      quantity: line.quantity, unitAmount: line.unitAmount, accountCode: line.accountCode, gstTreatment: line.gstTreatment })),
  })).digest("hex");
  const issueDate = document.issueDate ? timestamp(document.issueDate) : null;
  return { endpoint: "/PurchaseOrders", method: "POST", documentFamily: "purchase_order", documentNumber: event.proposedPoNumber,
    expectedXeroDocumentId: null, idempotencyKey, body: { PurchaseOrders: [{ PurchaseOrderID: undefined,
      PurchaseOrderNumber: event.proposedPoNumber, ...(document.reference?.trim() ? { Reference: document.reference.trim() } : {}),
      Contact: { ContactID: document.partySourceId!.trim() }, Status: "DRAFT", Date: issueDate?.slice(0, 10),
      LineAmountTypes: "Exclusive", LineItems: document.lineItems.map(line => ({ ItemCode: line.itemCode || undefined,
        Description: line.description, Quantity: line.quantity, UnitAmount: line.unitAmount,
        AccountCode: line.accountCode || document.accountCode || undefined, TaxType: "INPUT" })), CurrencyCode: "AUD" }] } };
}
function assertWriterMatches(event: FinancialForHirePoEvent, execution: FinancialWriterExecution, approvedBy: number) {
  forHireApAnchor(event);
  strictDate(event.billingPeriodStart); strictDate(event.billingPeriodEnd);
  if (execution.id !== event.executionId || execution.status !== "succeeded" || execution.errorMessage
    || execution.workflowType !== (event.eventKind === "initial" ? "initial_for_hire" : "recurring_for_hire")
    || execution.documentFamily !== "purchase_order" || execution.proposedAction !== "create_draft" || execution.method !== "POST"
    || execution.endpoint !== "/PurchaseOrders" || execution.targetXeroDocumentId !== null
    || execution.proposedDocumentNumber !== event.proposedPoNumber || execution.approvalReference !== event.releaseKey
    || execution.preparedBy !== approvedBy || execution.xeroDocumentId !== event.xeroPurchaseOrderId || execution.xeroDocumentStatus !== "DRAFT") return fail();
  const created = timestamp(event.createdAt), prepared = timestamp(execution.createdAt), submitted = timestamp(execution.submittedAt), completed = timestamp(execution.completedAt);
  if (Date.parse(prepared) < Date.parse(created) || Date.parse(submitted) < Date.parse(prepared) || Date.parse(completed) < Date.parse(submitted)) return fail();
  const payload = expectedPayload(event), auth = immutableAuth(event), summary = object(execution.safePayloadSummary), response = object(execution.xeroResponseSummary);
  const po = (payload.body.PurchaseOrders as Record<string, any>[])[0]!;
  if (auth.hash !== createHash("sha256").update(JSON.stringify(payload)).digest("hex") || auth.bodyHash !== financialSha256(payload.body)
    || execution.idempotencyKey !== payload.idempotencyKey || execution.payloadFingerprint !== `${payload.idempotencyKey.slice(0, 24)}:POST:/PurchaseOrders`
    || summary.documentFamily !== "purchase_order" || summary.documentNumber !== event.proposedPoNumber || summary.method !== "POST" || summary.endpoint !== "/PurchaseOrders"
    || summary.targetXeroDocumentId !== null || summary.lineCount !== po.LineItems.length || summary.lineAmountTypes !== po.LineAmountTypes || summary.reference !== (po.Reference ?? null)
    || response.documentNumber !== event.proposedPoNumber || response.endpoint !== "/PurchaseOrders" || response.idempotencyKey !== payload.idempotencyKey) return fail();
  const expected = object(auth.expectedPreview);
  if (expected.containerControlId !== event.containerControlId || expected.eventKind !== event.eventKind || expected.billingPeriodStart !== event.billingPeriodStart
    || expected.billingPeriodEnd !== event.billingPeriodEnd || expected.proposedPoNumber !== event.proposedPoNumber || expected.sourceSnapshotHash !== event.sourceSnapshotHash
    || expected.rulesSnapshotHash !== event.rulesSnapshotHash || expected.xeroPreflightHash !== event.xeroPreflightHash || expected.proposalHash !== financialSha256(event.proposal)
    || !hash(event.xeroPreflightHash) || financialSha256(event.xeroPreflight) !== event.xeroPreflightHash) return fail();
}
/** Pure evidence validation; caller must obtain all inputs through server DB reads. No boolean is accepted as proof. */
export function buildVerifiedForHireFutureChainProof(input: ForHireFutureChainEvidence): VerifiedForHireFutureChainProof {
  const root = input?.provenance;
  if (!root || root.origin !== FOR_HIRE_FUTURE_INITIAL_ORIGIN || !exactId(root.containerControlId)
    || !positiveId(root.initialEventId) || !positiveId(root.initialWriterExecutionId) || !positiveId(input.priorEventId)
    || !text(root.initialXeroPurchaseOrderId) || !text(root.initialReleaseKey) || !hash(root.initialRulesHash)
    || !hash(root.initialSourceSnapshotHash) || !hash(root.initialReceiptHash)
    || !Array.isArray(input.events) || !Array.isArray(input.writers) || input.events.length === 0
    || input.events.length > FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH || input.writers.length > FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH) return fail();
  const initialCreatedAt = timestamp(root.initialCreatedAt), recordedAt = timestamp(root.recordedAt);
  const events = new Map<number, FinancialForHirePoEvent>(), executions = new Map<number, FinancialWriterExecution>();
  for (const event of input.events) {
    if (!positiveId(event.id) || events.has(event.id) || event.containerControlId !== root.containerControlId
      || event.processingToken || ["reserved", "reconciliation_required"].includes(event.status)) return fail();
    events.set(event.id, event);
  }
  for (const execution of input.writers) { if (!positiveId(execution.id) || executions.has(execution.id)) return fail(); executions.set(execution.id, execution); }
  const initial = events.get(root.initialEventId), initialWriter = executions.get(root.initialWriterExecutionId);
  if (!initial || !initialWriter || initial.eventKind !== "initial" || timestamp(initial.createdAt) !== initialCreatedAt
    || initial.executionId !== root.initialWriterExecutionId || initial.xeroPurchaseOrderId !== root.initialXeroPurchaseOrderId
    || initial.rulesSnapshotHash !== root.initialRulesHash || root.initialRulesHash !== FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH
    || initial.releaseKey !== root.initialReleaseKey || initial.sourceSnapshotHash !== root.initialSourceSnapshotHash
    || initial.proposedPoNumber !== forHireInitialReference(initial.containerControlNumber)
    || Temporal.PlainDate.from(initial.billingPeriodStart).add({ days: 30 }).toString() !== initial.billingPeriodEnd
    || Date.parse(recordedAt) < Date.parse(timestamp(initialWriter.completedAt)) || Date.parse(recordedAt) > Date.now()
    || financialSha256(root.initialReceipt) !== root.initialReceiptHash || financialSha256(buildForHireInitialReceiptSnapshot(initial)) !== root.initialReceiptHash
    || !positiveId(initialWriter.preparedBy)) return fail();
  const ancestry: number[] = [], receiptHashes: string[] = [], writerHashes: string[] = [], seen = new Set<number>();
  let current = events.get(input.priorEventId);
  while (current) {
    if (seen.has(current.id) || ancestry.length >= FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH || current.releaseKey !== root.initialReleaseKey
      || current.containerControlNumber !== initial.containerControlNumber || current.rulesSnapshotHash !== root.initialRulesHash
      || Date.parse(timestamp(current.createdAt)) < Date.parse(initialCreatedAt)) return fail();
    seen.add(current.id); ancestry.push(current.id);
    const execution = executions.get(current.executionId!);
    if (!execution) return fail();
    assertWriterMatches(current, execution, initialWriter.preparedBy!);
    receiptHashes.push(financialSha256({ anchor: forHireApAnchor(current), containerControlNumber: current.containerControlNumber,
      containerNumber: current.containerNumber, containerType: current.containerType, supplierVtigerId: current.supplierVtigerId,
      supplierName: current.supplierName, sourceSnapshotHash: current.sourceSnapshotHash, rulesSnapshotHash: current.rulesSnapshotHash,
      xeroPreflightHash: current.xeroPreflightHash, releaseKey: current.releaseKey, authorisedPayload: immutableAuth(current),
      createdAt: timestamp(current.createdAt) }));
    writerHashes.push(financialSha256({ id: execution.id, workflowType: execution.workflowType, documentFamily: execution.documentFamily,
      proposedAction: execution.proposedAction, proposedDocumentNumber: execution.proposedDocumentNumber, endpoint: execution.endpoint,
      method: execution.method, idempotencyKey: execution.idempotencyKey, payloadFingerprint: execution.payloadFingerprint,
      approvalReference: execution.approvalReference, safePayloadSummary: execution.safePayloadSummary, xeroDocumentId: execution.xeroDocumentId,
      xeroDocumentStatus: execution.xeroDocumentStatus, xeroResponseSummary: execution.xeroResponseSummary, preparedBy: execution.preparedBy,
      submittedAt: timestamp(execution.submittedAt), completedAt: timestamp(execution.completedAt), createdAt: timestamp(execution.createdAt) }));
    if (Date.parse(timestamp(execution.completedAt)) > Date.parse(recordedAt) && current.id === initial.id) return fail();
    if (Date.parse(timestamp(execution.completedAt)) > Date.now()) return fail();
    if (current.id === initial.id) break;
    const auth = immutableAuth(current);
    if (auth.manualHandoverId !== undefined || auth.manualHandoverPlanHash !== undefined || !positiveId(auth.priorEventId)) return fail();
    const previous = events.get(auth.priorEventId);
    if (!previous) return fail();
    assertFutureSuccessor(current, previous, initial.containerControlNumber);
    current = previous;
  }
  if (!current || current.id !== initial.id || input.events.some(event => event.status === "drafts_created" && !seen.has(event.id))) return fail();
  if (input.currentEvent) {
    const candidate = input.currentEvent, predecessor = events.get(input.priorEventId)!;
    const candidateAuth = candidate.authorisedPayload ? object(candidate.authorisedPayload) : null;
    if (events.has(candidate.id) || !["previewed", "reserved"].includes(candidate.status)
      || (candidate.releaseKey !== null && candidate.releaseKey !== root.initialReleaseKey)
      || candidate.containerControlNumber !== initial.containerControlNumber || (candidateAuth && (candidateAuth.priorEventId !== input.priorEventId
        || candidateAuth.manualHandoverId !== undefined || candidateAuth.manualHandoverPlanHash !== undefined))) return fail();
    strictDate(candidate.billingPeriodStart); strictDate(candidate.billingPeriodEnd);
    assertFutureSuccessor(candidate, predecessor, initial.containerControlNumber);
  }
  const proof = Object.freeze({ containerControlId: root.containerControlId, rootInitialEventId: initial.id, initialCreatedAt,
    initialReleaseKey: root.initialReleaseKey, initialRulesHash: root.initialRulesHash, initialReceiptHash: root.initialReceiptHash,
    initialApprovedBy: initialWriter.preparedBy!, currentPredecessorId: input.priorEventId, ancestryEventIds: Object.freeze(ancestry),
    ancestryReceiptHashes: Object.freeze(receiptHashes), ancestryWriterHashes: Object.freeze(writerHashes) });
  issuedProofs.add(proof);
  return proof;
}
function assertFutureSuccessor(current: FinancialForHirePoEvent, previous: FinancialForHirePoEvent, controlNumber: string) {
  // Existing AP numbering treats its unsuffixed initial as ordinal one; the first AP extension is -2.
  // Mixed-anchor's helper models unsuffixed legacy opening as ordinal zero. Adapt ONLY that verified
  // initial comparison; never change the stored receipt, signed body, or accept a skipped recurring ordinal.
  const ordinalPrevious = previous.eventKind === "initial"
    ? { ...previous, proposedPoNumber: `${forHireInitialReference(controlNumber)}-1` } : previous;
  assertForHireRecurringSuccessor(current, ordinalPrevious, controlNumber);
}
export function isVerifiedForHireFutureChainProof(value: unknown): value is VerifiedForHireFutureChainProof {
  return !!value && typeof value === "object" && issuedProofs.has(value);
}
