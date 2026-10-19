import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  financialD702946DepositMainDeductionRecoveryEvents as events,
  financialMainCustomerInvoiceEvents as originals, financialMainCustomerInvoiceReconciliationEvents as mainRecoveries,
  financialDepositInvoiceEvents as deposits, financialWriterExecutions as writers,
  financialBillingPartySyncLocks as billingLocks, financialFinalWeightAdjustmentEvents as finalWeights,
  financialFinalWeightReconciliationEvents as finalWeightRecoveries,
  financialFinalWeightReconciliationRemediationEvents as finalWeightRemediations,
  financialDepositMainDeductionEvents as deductions, financialWarrantyAvisoEvents as warranties,
  type FinancialD702946DepositMainDeductionRecoveryEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { classifyMainCustomerInvoiceReconciliationOrigin, mainCustomerInvoiceReconciliationOriginalHash,
  mainCustomerInvoiceReconciliationWriterEvidenceHash } from "./financialMainCustomerInvoiceReconciliationDb";
import { assertD702946DepositMainDeductionRecoveryRelease, getD702946DepositMainDeductionRecoveryPolicy,
  type D702946DepositMainDeductionRecoveryPolicy } from "./financialD702946DepositMainDeductionRecoveryRelease";
import { D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_RECOVERY_SCOPE_KEY,
  assertD702946RecoveryPayload, assertD702946RecoverySource, prepareD702946DepositMainDeductionRecoveryPayload,
  assertD702946RecoveryReadback, jsonEvidence } from "./financialD702946DepositMainDeductionRecoveryScope";

async function database() { const db = await getDb(); if (!db) throw new Error("D702946 recovery ledger unavailable; migration requires separate approval/application."); return db; }
const affected = (result: any) => Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
export type D702946RecoveryEvidence = {
  scopeKey: string; dealId: string; dealNumber: string; originalMainEventId: number; failedMainWriterExecutionId: number;
  mainRecoveryEventId: number; mainRecoveryWriterExecutionId: number; depositEventId: number; depositWriterExecutionId: number;
  mainInvoiceNumber: string; mainXeroInvoiceId: string; depositInvoiceNumber: string; depositXeroInvoiceId: string;
  anchorEvidenceHash: string; anchorEvidence: Record<string, any>; sourceSnapshotHash: string; sourceSnapshot: Record<string, any>;
  xeroEvidenceHash: string; mainXeroSnapshot: Record<string, any>; depositXeroSnapshot: Record<string, any>;
};
export async function getD702946DepositMainDeductionRecoveryEvent(id: number): Promise<FinancialD702946DepositMainDeductionRecoveryEvent | null> {
  return (await (await database()).select().from(events).where(eq(events.id, id)).limit(1))[0] ?? null;
}
/**
 * Read-only cross-writer lock: a reserved, submitted, or uncertain dedicated
 * recovery owns INV-702946 until its exact outcome is reconciled. It lets other
 * Draft amendments fail closed without granting them access to this recovery.
 */
export async function getPendingD702946DepositMainDeductionRecovery(mainXeroInvoiceId: string): Promise<FinancialD702946DepositMainDeductionRecoveryEvent | null> {
  if (mainXeroInvoiceId !== scope.mainXeroInvoiceId) return null;
  return (await (await database()).select().from(events).where(and(
    eq(events.mainXeroInvoiceId, scope.mainXeroInvoiceId),
    inArray(events.status, ["reserved", "submitted", "reconciliation_required"]),
  )).limit(1))[0] ?? null;
}
function assertSuccessfulCreate(writer: any, payload: FinancialDraftPayload, workflow: string, id: string, releaseKey: string, preparedBy?: number): void {
  if (!writer || writer.status !== "succeeded" || writer.workflowType !== workflow || writer.documentFamily !== "customer_invoice" ||
    writer.proposedAction !== "create_draft" || writer.proposedDocumentNumber !== payload.documentNumber || writer.targetXeroDocumentId !== null ||
    writer.endpoint !== "/Invoices" || writer.method !== "POST" || writer.idempotencyKey !== payload.idempotencyKey ||
    writer.payloadFingerprint !== `${payload.idempotencyKey.slice(0, 24)}:POST:/Invoices` || writer.xeroDocumentId !== id ||
    writer.xeroDocumentStatus !== "DRAFT" || !writer.submittedAt || !writer.completedAt || writer.approvalReference !== releaseKey ||
    (preparedBy !== undefined && writer.preparedBy !== preparedBy) || writer.xeroResponseSummary?.documentNumber !== payload.documentNumber ||
    writer.xeroResponseSummary?.idempotencyKey !== payload.idempotencyKey || writer.xeroResponseSummary?.endpoint !== "/Invoices") {
    throw new Error("Completed exact Draft creation requires its matching successful production writer receipt.");
  }
}
/**
 * The two known D702946 create receipts were bound before JSON persistence
 * removed the creation-only `InvoiceID: undefined` property. The ledger stores
 * the exact resulting JSON, while its immutable hash reflects that original
 * in-memory wire shape. Accept only the direct hash or this one narrowly
 * reconstructed shape; any present/non-empty/other InvoiceID still fails.
 */
function exactHistoricCreatePayloadHashMatches(storedHash: unknown, payload: FinancialDraftPayload, documentNumber: string): boolean {
  if (typeof storedHash !== "string") return false;
  if (storedHash === financialSha256(payload)) return true;
  const row = Array.isArray(payload.body.Invoices) && payload.body.Invoices.length === 1
    ? payload.body.Invoices[0] as Record<string, unknown>
    : null;
  if (!row || payload.method !== "POST" || payload.endpoint !== "/Invoices" ||
    payload.documentFamily !== "customer_invoice" || payload.expectedXeroDocumentId !== null ||
    payload.documentNumber !== documentNumber || row.InvoiceNumber !== documentNumber ||
    Object.prototype.hasOwnProperty.call(row, "InvoiceID")) return false;
  const historic = structuredClone(payload) as FinancialDraftPayload;
  ((historic.body.Invoices as Record<string, unknown>[])[0]!).InvoiceID = undefined;
  return storedHash === financialSha256(historic);
}
/** The original remains uncertain; ownership comes ONLY from its completed independent recovery. */
export function assertD702946RecoveryAnchors(anchor: Record<string, any>): void {
  const { originalMain, failedMainWriter, mainRecovery, mainRecoveryWriter, deposit, depositWriter } = anchor;
  classifyMainCustomerInvoiceReconciliationOrigin({ original: originalMain, failedExecution: failedMainWriter, originalEventId: scope.originalMainEventId });
  const originalHash = mainCustomerInvoiceReconciliationOriginalHash({ ...originalMain,
    sourceRefreshedAt: originalMain.sourceRefreshedAt ? new Date(originalMain.sourceRefreshedAt) : null });
  const failedHash = mainCustomerInvoiceReconciliationWriterEvidenceHash({ ...failedMainWriter,
    submittedAt: new Date(failedMainWriter.submittedAt), completedAt: new Date(failedMainWriter.completedAt) });
  const mainPayload = mainRecovery?.authorisedPayload?.payload as FinancialDraftPayload;
  const depositPayload = deposit?.authorisedPayload?.payload as FinancialDraftPayload;
  if (!mainRecovery || mainRecovery.id !== scope.mainRecoveryEventId || mainRecovery.originalEventId !== scope.originalMainEventId ||
    mainRecovery.failedWriterExecutionId !== scope.failedMainWriterExecutionId || mainRecovery.dealId !== scope.dealId ||
    mainRecovery.dealNumber !== scope.dealNumber || mainRecovery.invoiceNumber !== scope.mainInvoiceNumber ||
    mainRecovery.status !== "drafts_created" || mainRecovery.processingToken !== null || mainRecovery.executionId !== scope.mainRecoveryWriterExecutionId ||
    mainRecovery.originalEventHash !== originalHash || mainRecovery.failedWriterEvidenceHash !== failedHash ||
    !mainRecovery.submittedAt || !mainPayload || !exactHistoricCreatePayloadHashMatches(mainRecovery.authorisedPayload.hash, mainPayload, scope.mainInvoiceNumber) ||
    mainPayload.documentNumber !== scope.mainInvoiceNumber || mainPayload.endpoint !== "/Invoices" || mainPayload.expectedXeroDocumentId !== null ||
    mainRecovery.readbackEvidence?.xeroDocumentId !== scope.mainXeroInvoiceId || mainRecovery.readbackEvidence?.documentNumber !== scope.mainInvoiceNumber ||
    mainRecovery.readbackEvidence?.status !== "DRAFT" || mainRecoveryWriter?.id !== scope.mainRecoveryWriterExecutionId ||
    !deposit || deposit.id !== scope.depositEventId || deposit.dealId !== scope.dealId || deposit.dealNumber !== scope.dealNumber ||
    deposit.proposedInvoiceNumber !== scope.depositInvoiceNumber || deposit.claimedDealId !== scope.dealId || deposit.claimedInvoiceNumber !== scope.depositInvoiceNumber ||
    deposit.status !== "drafts_created" || deposit.processingToken !== null || deposit.xeroInvoiceId !== scope.depositXeroInvoiceId ||
    !Number.isInteger(deposit.executionId) || deposit.executionId <= 0 || deposit.executionId !== depositWriter?.id ||
    !depositPayload || !exactHistoricCreatePayloadHashMatches(deposit.authorisedPayload.hash, depositPayload, scope.depositInvoiceNumber) || depositPayload.documentNumber !== scope.depositInvoiceNumber ||
    depositPayload.endpoint !== "/Invoices" || depositPayload.expectedXeroDocumentId !== null) {
    throw new Error("Only exact D702946 original/recovery/Deposit immutable ownership receipts may authorise this exception.");
  }
  assertSuccessfulCreate(mainRecoveryWriter, mainPayload, "main_invoice_reconciliation", scope.mainXeroInvoiceId, mainRecovery.releaseKey);
  assertSuccessfulCreate(depositWriter, depositPayload, "deposit_invoice", scope.depositXeroInvoiceId, deposit.releaseKey);
}
export async function readD702946RecoveryAnchors(): Promise<Record<string, any>> {
  const db = await database();
  const [originalMain, failedMainWriter, mainRecovery, mainRecoveryWriter, deposit] = await Promise.all([
    db.select().from(originals).where(eq(originals.id, scope.originalMainEventId)).limit(1),
    db.select().from(writers).where(eq(writers.id, scope.failedMainWriterExecutionId)).limit(1),
    db.select().from(mainRecoveries).where(eq(mainRecoveries.id, scope.mainRecoveryEventId)).limit(1),
    db.select().from(writers).where(eq(writers.id, scope.mainRecoveryWriterExecutionId)).limit(1),
    db.select().from(deposits).where(eq(deposits.id, scope.depositEventId)).limit(1),
  ]);
  const depositWriter = deposit[0]?.executionId ? (await db.select().from(writers).where(eq(writers.id, deposit[0].executionId)).limit(1))[0] : null;
  const anchor = jsonEvidence({ originalMain: originalMain[0], failedMainWriter: failedMainWriter[0], mainRecovery: mainRecovery[0], mainRecoveryWriter: mainRecoveryWriter[0], deposit: deposit[0], depositWriter });
  assertD702946RecoveryAnchors(anchor); return anchor;
}
/** GET/SELECT-only. Own execution is excluded only after independently matching its bounded receipt. */
export async function assertNoD702946RecoveryCompetingPaths(ownExecutionId?: number): Promise<void> {
  const db = await database();
  const writerConditions = [or(inArray(writers.targetXeroDocumentId, [scope.mainXeroInvoiceId, scope.depositXeroInvoiceId]),
    inArray(writers.proposedDocumentNumber, [scope.mainInvoiceNumber, scope.depositInvoiceNumber]))!, inArray(writers.status, ["prepared", "submitted", "reconciliation_required"])];
  if (ownExecutionId !== undefined) writerConditions.push(ne(writers.id, ownExecutionId));
  const conflicts = await Promise.all([
    db.select().from(writers).where(and(...writerConditions)).limit(1),
    db.select().from(billingLocks).where(and(inArray(billingLocks.xeroInvoiceId, [scope.mainXeroInvoiceId, scope.depositXeroInvoiceId]), inArray(billingLocks.state, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(finalWeights).where(and(eq(finalWeights.dealId, scope.dealId), inArray(finalWeights.status, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(finalWeightRecoveries).where(and(eq(finalWeightRecoveries.dealId, scope.dealId), inArray(finalWeightRecoveries.status, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(finalWeightRemediations).where(and(eq(finalWeightRemediations.dealId, scope.dealId), inArray(finalWeightRemediations.status, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(deductions).where(and(or(eq(deductions.dealId, scope.dealId), eq(deductions.mainXeroInvoiceId, scope.mainXeroInvoiceId)), inArray(deductions.status, ["reserved", "draft_updated", "reconciliation_required"]))).limit(1),
    db.select().from(warranties).where(and(eq(warranties.dealId, scope.dealId), inArray(warranties.status, ["reserved", "main_submitted", "main_receipt", "po_submitted", "po_receipt", "reconciliation_required"]))).limit(1),
  ]);
  if (conflicts.some(rows => rows.length)) throw new Error("Competing Billing Party sync, writer, Final Weight, generic deduction or Warranty path holds D702946 recovery.");
}
export async function reserveD702946DepositMainDeductionRecovery(input: { evidence: D702946RecoveryEvidence; payload: FinancialDraftPayload; policy: D702946DepositMainDeductionRecoveryPolicy; token: string }) {
  assertD702946DepositMainDeductionRecoveryRelease(input.policy); assertD702946RecoveryPayload(input.payload);
  const { evidence, payload, policy, token } = input;
  const fixed = { scopeKey: D702946_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber,
    originalMainEventId: scope.originalMainEventId, failedMainWriterExecutionId: scope.failedMainWriterExecutionId,
    mainRecoveryEventId: scope.mainRecoveryEventId, mainRecoveryWriterExecutionId: scope.mainRecoveryWriterExecutionId,
    depositEventId: scope.depositEventId, mainInvoiceNumber: scope.mainInvoiceNumber, mainXeroInvoiceId: scope.mainXeroInvoiceId,
    depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId };
  if (Object.entries(fixed).some(([key, value]) => (evidence as any)[key] !== value) || !token ||
    evidence.anchorEvidenceHash !== financialSha256(evidence.anchorEvidence) || evidence.sourceSnapshotHash !== financialSha256(evidence.sourceSnapshot) ||
    evidence.xeroEvidenceHash !== financialSha256({ main: evidence.mainXeroSnapshot, deposit: evidence.depositXeroSnapshot })) throw new Error("Exact immutable recovery scope/evidence required.");
  assertD702946RecoveryAnchors(evidence.anchorEvidence);
  assertD702946RecoverySource(evidence.sourceSnapshot.mainFacts, evidence.sourceSnapshot.depositFacts);
  if (evidence.depositWriterExecutionId !== evidence.anchorEvidence.depositWriter.id ||
    financialSha256(prepareD702946DepositMainDeductionRecoveryPayload(evidence.mainXeroSnapshot, evidence.depositXeroSnapshot, financialSha256(evidence))) !== financialSha256(payload))
    throw new Error("Reservation must bind the independently rebuilt exact source/snapshot deduction payload.");
  const db = await database();
  const values = { ...evidence, recoveryKey: financialSha256({ evidence, payload, policy }), payloadHash: financialSha256(payload),
    authorisedPayload: payload, releaseKey: policy.releaseKey, approvedBy: policy.approvedBy!, approvedAt: policy.approvedAt!, policyHash: financialSha256(policy),
    status: "reserved" as const, processingToken: token };
  let inserted = false;
  try { await db.insert(events).values(values); inserted = true; } catch (error: any) { if (error?.code !== "ER_DUP_ENTRY" && error?.cause?.code !== "ER_DUP_ENTRY") throw error; }
  const event = (await db.select().from(events).where(eq(events.scopeKey, D702946_RECOVERY_SCOPE_KEY)).limit(1))[0];
  if (!event) throw new Error("D702946 recovery receipt could not be read back.");
  if (!inserted || event.status !== "reserved" || event.processingToken !== token || event.recoveryKey !== values.recoveryKey)
    return { state: event.status === "draft_updated" ? "completed" as const : "blocked" as const, event };
  return { state: "reserved" as const, event };
}
export async function assertD702946RecoveryWriterReceipt(executionId: number, event: FinancialD702946DepositMainDeductionRecoveryEvent, allowed: string[]): Promise<void> {
  const writer = (await (await database()).select().from(writers).where(eq(writers.id, executionId)).limit(1))[0];
  const payload = event.authorisedPayload as FinancialDraftPayload;
  if (!writer || !allowed.includes(writer.status) || writer.workflowType !== scope.workflowType || writer.proposedAction !== "update_draft" ||
    writer.documentFamily !== "customer_invoice" || writer.proposedDocumentNumber !== scope.mainInvoiceNumber || writer.targetXeroDocumentId !== scope.mainXeroInvoiceId ||
    writer.idempotencyKey !== payload.idempotencyKey || writer.payloadFingerprint !== `${payload.idempotencyKey.slice(0, 24)}:POST:${payload.endpoint}` ||
    writer.method !== "POST" || writer.endpoint !== payload.endpoint || writer.approvalReference !== event.releaseKey || writer.preparedBy !== event.approvedBy ||
    !writer.submittedAt) throw new Error("Recovery cannot exclude or adopt any other writer execution.");
}
export async function verifyD702946DepositMainDeductionRecoveryWriteAccess(input: { eventId: number; token: string; releaseKey: string; preparedBy: number; payload: FinancialDraftPayload; executionId?: number; submitted?: boolean }): Promise<void> {
  const policy = await getD702946DepositMainDeductionRecoveryPolicy(); assertD702946DepositMainDeductionRecoveryRelease(policy);
  assertD702946RecoveryPayload(input.payload);
  const event = await getD702946DepositMainDeductionRecoveryEvent(input.eventId);
  const stateMatches = event && (input.submitted === true
    ? event.status === "submitted" && Boolean(event.submittedAt) && event.executionId === input.executionId && input.executionId !== undefined
    : event.status === "reserved" && !event.submittedAt && !event.executionId);
  if (!event || !stateMatches || event.processingToken !== input.token ||
    event.releaseKey !== input.releaseKey || input.releaseKey !== policy.releaseKey || input.preparedBy !== policy.approvedBy ||
    event.policyHash !== financialSha256(policy) || event.payloadHash !== financialSha256(input.payload) ||
    financialSha256(event.authorisedPayload) !== event.payloadHash) throw new Error("Recovery requires the separate unconsumed exact-payload reservation and approval.");
  if (input.executionId !== undefined) await assertD702946RecoveryWriterReceipt(input.executionId, event, ["submitted"]);
  const { readD702946DepositMainDeductionRecoveryPreflight } = await import("./financialD702946DepositMainDeductionRecoveryService");
  const fresh = await readD702946DepositMainDeductionRecoveryPreflight(input.executionId);
  if (fresh.status !== "ready" || fresh.evidence.anchorEvidenceHash !== event.anchorEvidenceHash ||
    fresh.evidence.sourceSnapshotHash !== event.sourceSnapshotHash || fresh.evidence.xeroEvidenceHash !== event.xeroEvidenceHash ||
    financialSha256(fresh.evidence) !== financialSha256(extractD702946RecoveryEvidence(event)) ||
    financialSha256(fresh.payload) !== event.payloadHash) throw new Error("Final recovery verifier: current source/receipts/Xero or rebuilt bounded payload changed.");
}
export function extractD702946RecoveryEvidence(event: FinancialD702946DepositMainDeductionRecoveryEvent): D702946RecoveryEvidence {
  const { scopeKey, dealId, dealNumber, originalMainEventId, failedMainWriterExecutionId, mainRecoveryEventId, mainRecoveryWriterExecutionId, depositEventId,
    depositWriterExecutionId, mainInvoiceNumber, mainXeroInvoiceId, depositInvoiceNumber, depositXeroInvoiceId, anchorEvidenceHash, anchorEvidence,
    sourceSnapshotHash, sourceSnapshot, xeroEvidenceHash, mainXeroSnapshot, depositXeroSnapshot } = event;
  return { scopeKey, dealId, dealNumber, originalMainEventId, failedMainWriterExecutionId, mainRecoveryEventId, mainRecoveryWriterExecutionId, depositEventId,
    depositWriterExecutionId, mainInvoiceNumber, mainXeroInvoiceId, depositInvoiceNumber, depositXeroInvoiceId, anchorEvidenceHash, anchorEvidence: anchorEvidence as any,
    sourceSnapshotHash, sourceSnapshot: sourceSnapshot as any, xeroEvidenceHash, mainXeroSnapshot: mainXeroSnapshot as any, depositXeroSnapshot: depositXeroSnapshot as any };
}
/** Consumed before writer authentication/POST. No code can return it to reserved. */
export async function consumeD702946DepositMainDeductionRecoveryPayload(input: { eventId: number; token: string }, executionId: number): Promise<void> {
  const event = await getD702946DepositMainDeductionRecoveryEvent(input.eventId);
  if (!event) throw new Error("Recovery receipt missing.");
  await assertD702946RecoveryWriterReceipt(executionId, event, ["submitted"]);
  if (!affected(await (await database()).update(events).set({ status: "submitted", submittedAt: new Date(), executionId })
    .where(and(eq(events.id, input.eventId), eq(events.status, "reserved"), eq(events.processingToken, input.token), isNull(events.submittedAt), isNull(events.executionId)))))
    throw new Error("Recovery reservation already consumed; never POST again.");
}
export async function holdD702946DepositMainDeductionRecovery(eventId: number, token: string, reason: string): Promise<void> {
  await (await database()).update(events).set({ status: "reconciliation_required", processingToken: null, holdReason: reason.slice(0, 2000) })
    .where(and(eq(events.id, eventId), eq(events.processingToken, token), inArray(events.status, ["reserved", "submitted"])));
}
/** Only called after fresh full readback by the server-only service; writer/original receipts never rewritten. */
export async function completeD702946DepositMainDeductionRecovery(input: { eventId: number; payloadHash: string; executionId: number; readbackEvidence: unknown; token?: string }): Promise<void> {
  const event = await getD702946DepositMainDeductionRecoveryEvent(input.eventId);
  const readback = input.readbackEvidence as Record<string, any>;
  if (!event || !event.submittedAt || event.executionId !== input.executionId || event.payloadHash !== input.payloadHash ||
    !readback || readback.executionId !== input.executionId || readback.payloadHash !== event.payloadHash ||
    readback.anchorEvidenceHash !== event.anchorEvidenceHash || !readback.noXeroWrite ||
    financialSha256(readback.deposit) !== financialSha256(event.depositXeroSnapshot) ||
    financialSha256(event.authorisedPayload) !== event.payloadHash) throw new Error("Recovery completion requires the retained exact full consumed-payload readback evidence.");
  assertD702946RecoveryReadback(readback.main, event.authorisedPayload as FinancialDraftPayload);
  const conditions = [eq(events.id, input.eventId), eq(events.payloadHash, input.payloadHash), eq(events.executionId, input.executionId)];
  if (input.token) conditions.push(eq(events.status, "submitted"), eq(events.processingToken, input.token));
  else conditions.push(eq(events.status, "reconciliation_required"), isNull(events.processingToken));
  if (!affected(await (await database()).update(events).set({ status: "draft_updated", processingToken: null, holdReason: null, readbackEvidence: input.readbackEvidence })
    .where(and(...conditions)))) throw new Error("Recovery completion lost its exact submitted receipt; reconciliation required.");
}
