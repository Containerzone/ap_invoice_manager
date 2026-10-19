import { and, eq, inArray, isNull } from "drizzle-orm";
import { financialD702946DepositMainDeductionRecoveryEvents as events, financialWriterExecutions as writers, type FinancialD702946DepositMainDeductionRecoveryEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { readD702946RecoveryAnchors, assertNoD702946RecoveryCompetingPaths } from "./financialD702946DepositMainDeductionRecoveryDb";
import { assertD702946AuthorisedDepositMainDeductionRecoveryRelease, getD702946AuthorisedDepositMainDeductionRecoveryPolicy, type D702946AuthorisedDepositMainDeductionRecoveryPolicy } from "./financialD702946AuthorisedDepositMainDeductionRecoveryRelease";
import { D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY,
  assertD702946AuthorisedDepositRecoveryPayload, assertD702946AuthorisedDepositRecoveryReadback, assertD702946AuthorisedDepositRecoverySource,
  prepareD702946AuthorisedDepositMainDeductionRecoveryPayload, jsonEvidence } from "./financialD702946AuthorisedDepositMainDeductionRecoveryScope";

async function database() { const db = await getDb(); if (!db) throw new Error("D702946 Authorised-Deposit recovery ledger unavailable; migration requires separate approval/application."); return db; }
const affected = (result: any) => Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
export type D702946AuthorisedDepositRecoveryEvidence = {
  scopeKey: string; dealId: string; dealNumber: string; originalMainEventId: number; failedMainWriterExecutionId: number;
  mainRecoveryEventId: number; mainRecoveryWriterExecutionId: number; depositEventId: number; depositWriterExecutionId: number;
  mainInvoiceNumber: string; mainXeroInvoiceId: string; depositInvoiceNumber: string; depositXeroInvoiceId: string;
  anchorEvidenceHash: string; anchorEvidence: Record<string, any>; sourceSnapshotHash: string; sourceSnapshot: Record<string, any>;
  xeroEvidenceHash: string; mainXeroSnapshot: Record<string, any>; depositXeroSnapshot: Record<string, any>;
};
export async function getD702946AuthorisedDepositMainDeductionRecoveryEvent(id: number): Promise<FinancialD702946DepositMainDeductionRecoveryEvent | null> {
  return (await (await database()).select().from(events).where(eq(events.id, id)).limit(1))[0] ?? null;
}
/** The shared table's unique Main/pair keys make a V1/V2 concurrent claim fail closed. */
export async function reserveD702946AuthorisedDepositMainDeductionRecovery(input: { evidence: D702946AuthorisedDepositRecoveryEvidence; payload: FinancialDraftPayload; policy: D702946AuthorisedDepositMainDeductionRecoveryPolicy; token: string }) {
  assertD702946AuthorisedDepositMainDeductionRecoveryRelease(input.policy); assertD702946AuthorisedDepositRecoveryPayload(input.payload);
  const { evidence, payload, policy, token } = input;
  const fixed = { scopeKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber,
    originalMainEventId: scope.originalMainEventId, failedMainWriterExecutionId: scope.failedMainWriterExecutionId,
    mainRecoveryEventId: scope.mainRecoveryEventId, mainRecoveryWriterExecutionId: scope.mainRecoveryWriterExecutionId,
    depositEventId: scope.depositEventId, mainInvoiceNumber: scope.mainInvoiceNumber, mainXeroInvoiceId: scope.mainXeroInvoiceId,
    depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId };
  if (Object.entries(fixed).some(([key, value]) => (evidence as any)[key] !== value) || !token ||
    evidence.anchorEvidenceHash !== financialSha256(evidence.anchorEvidence) || evidence.sourceSnapshotHash !== financialSha256(evidence.sourceSnapshot) ||
    evidence.xeroEvidenceHash !== financialSha256({ main: evidence.mainXeroSnapshot, deposit: evidence.depositXeroSnapshot })) throw new Error("Exact immutable V2 recovery scope/evidence required.");
  // Reuse the V1 immutable ownership-anchor verifier without widening V1 status/policy scope.
  const anchors = await readD702946RecoveryAnchors();
  if (financialSha256(anchors) !== evidence.anchorEvidenceHash) throw new Error("Original D702946 creation/recovery ownership evidence changed.");
  assertD702946AuthorisedDepositRecoverySource(evidence.sourceSnapshot.mainFacts, evidence.sourceSnapshot.depositFacts);
  if (evidence.depositWriterExecutionId !== evidence.anchorEvidence.depositWriter.id ||
    financialSha256(prepareD702946AuthorisedDepositMainDeductionRecoveryPayload(evidence.mainXeroSnapshot, evidence.depositXeroSnapshot, financialSha256(evidence))) !== financialSha256(payload))
    throw new Error("Reservation must bind the independently rebuilt exact Authorised-Deposit payload.");
  await assertNoD702946RecoveryCompetingPaths();
  const db = await database();
  const values = { ...evidence, recoveryKey: financialSha256({ evidence, payload, policy }), payloadHash: financialSha256(payload),
    authorisedPayload: payload, releaseKey: policy.releaseKey, approvedBy: policy.approvedBy!, approvedAt: policy.approvedAt!, policyHash: financialSha256(policy),
    status: "reserved" as const, processingToken: token };
  let inserted = false;
  try { await db.insert(events).values(values); inserted = true; } catch (error: any) { if (error?.code !== "ER_DUP_ENTRY" && error?.cause?.code !== "ER_DUP_ENTRY") throw error; }
  // Query by Main identity, not V2 scope, so an improbable V1/V2 collision is safely reported as blocked.
  const event = (await db.select().from(events).where(eq(events.mainXeroInvoiceId, scope.mainXeroInvoiceId)).limit(1))[0];
  if (!event) throw new Error("D702946 Authorised-Deposit recovery receipt could not be read back.");
  if (!inserted || event.scopeKey !== D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY || event.status !== "reserved" || event.processingToken !== token || event.recoveryKey !== values.recoveryKey)
    return { state: event.scopeKey === D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY && event.status === "draft_updated" ? "completed" as const : "blocked" as const, event };
  return { state: "reserved" as const, event };
}
export async function assertD702946AuthorisedDepositRecoveryWriterReceipt(executionId: number, event: FinancialD702946DepositMainDeductionRecoveryEvent, allowed: string[]): Promise<void> {
  const receipts = await (await database()).select().from(writers).where(eq(writers.id, executionId)).limit(1);
  const writer = receipts[0], payload = event.authorisedPayload as FinancialDraftPayload;
  if (!writer || !allowed.includes(writer.status) || writer.workflowType !== scope.workflowType || writer.proposedAction !== "update_draft" ||
    writer.documentFamily !== "customer_invoice" || writer.proposedDocumentNumber !== scope.mainInvoiceNumber || writer.targetXeroDocumentId !== scope.mainXeroInvoiceId ||
    writer.idempotencyKey !== payload.idempotencyKey || writer.payloadFingerprint !== `${payload.idempotencyKey.slice(0, 24)}:POST:${payload.endpoint}` ||
    writer.method !== "POST" || writer.endpoint !== payload.endpoint || writer.approvalReference !== event.releaseKey || writer.preparedBy !== event.approvedBy || !writer.submittedAt)
    throw new Error("Authorised-Deposit recovery cannot exclude or adopt any other writer execution.");
}
export async function verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess(input: { eventId: number; token: string; releaseKey: string; preparedBy: number; payload: FinancialDraftPayload; executionId?: number; submitted?: boolean }): Promise<void> {
  const policy = await getD702946AuthorisedDepositMainDeductionRecoveryPolicy(); assertD702946AuthorisedDepositMainDeductionRecoveryRelease(policy);
  assertD702946AuthorisedDepositRecoveryPayload(input.payload);
  const event = await getD702946AuthorisedDepositMainDeductionRecoveryEvent(input.eventId);
  const stateMatches = event && event.scopeKey === D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY && (input.submitted === true
    ? event.status === "submitted" && Boolean(event.submittedAt) && event.executionId === input.executionId && input.executionId !== undefined
    : event.status === "reserved" && !event.submittedAt && !event.executionId);
  if (!event || !stateMatches || event.processingToken !== input.token || event.releaseKey !== input.releaseKey || input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy || event.policyHash !== financialSha256(policy) || event.payloadHash !== financialSha256(input.payload) ||
    financialSha256(event.authorisedPayload) !== event.payloadHash) throw new Error("Authorised-Deposit recovery requires the separate unconsumed exact-payload V2 reservation and approval.");
  if (input.executionId !== undefined) await assertD702946AuthorisedDepositRecoveryWriterReceipt(input.executionId, event, ["submitted"]);
  const { readD702946AuthorisedDepositMainDeductionRecoveryPreflight } = await import("./financialD702946AuthorisedDepositMainDeductionRecoveryService");
  const fresh = await readD702946AuthorisedDepositMainDeductionRecoveryPreflight(input.executionId);
  if (fresh.status !== "ready" || fresh.evidence.anchorEvidenceHash !== event.anchorEvidenceHash || fresh.evidence.sourceSnapshotHash !== event.sourceSnapshotHash ||
    fresh.evidence.xeroEvidenceHash !== event.xeroEvidenceHash || financialSha256(fresh.evidence) !== financialSha256(extractD702946AuthorisedDepositRecoveryEvidence(event)) ||
    financialSha256(fresh.payload) !== event.payloadHash) throw new Error("Final Authorised-Deposit recovery verifier: current source/receipts/Xero or rebuilt bounded payload changed.");
}
export function extractD702946AuthorisedDepositRecoveryEvidence(event: FinancialD702946DepositMainDeductionRecoveryEvent): D702946AuthorisedDepositRecoveryEvidence {
  const { scopeKey, dealId, dealNumber, originalMainEventId, failedMainWriterExecutionId, mainRecoveryEventId, mainRecoveryWriterExecutionId, depositEventId,
    depositWriterExecutionId, mainInvoiceNumber, mainXeroInvoiceId, depositInvoiceNumber, depositXeroInvoiceId, anchorEvidenceHash, anchorEvidence,
    sourceSnapshotHash, sourceSnapshot, xeroEvidenceHash, mainXeroSnapshot, depositXeroSnapshot } = event;
  return { scopeKey, dealId, dealNumber, originalMainEventId, failedMainWriterExecutionId, mainRecoveryEventId, mainRecoveryWriterExecutionId, depositEventId,
    depositWriterExecutionId, mainInvoiceNumber, mainXeroInvoiceId, depositInvoiceNumber, depositXeroInvoiceId, anchorEvidenceHash, anchorEvidence: anchorEvidence as any,
    sourceSnapshotHash, sourceSnapshot: sourceSnapshot as any, xeroEvidenceHash, mainXeroSnapshot: mainXeroSnapshot as any, depositXeroSnapshot: depositXeroSnapshot as any };
}
/** Consumed before Xero transport; no code can return a V2 receipt to reserved. */
export async function consumeD702946AuthorisedDepositMainDeductionRecoveryPayload(input: { eventId: number; token: string }, executionId: number): Promise<void> {
  const event = await getD702946AuthorisedDepositMainDeductionRecoveryEvent(input.eventId);
  if (!event || event.scopeKey !== D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY) throw new Error("Authorised-Deposit recovery receipt missing.");
  await assertD702946AuthorisedDepositRecoveryWriterReceipt(executionId, event, ["submitted"]);
  if (!affected(await (await database()).update(events).set({ status: "submitted", submittedAt: new Date(), executionId })
    .where(and(eq(events.id, input.eventId), eq(events.scopeKey, D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY), eq(events.status, "reserved"),
      eq(events.processingToken, input.token), isNull(events.submittedAt), isNull(events.executionId))))) throw new Error("Authorised-Deposit recovery reservation already consumed; never POST again.");
}
export async function holdD702946AuthorisedDepositMainDeductionRecovery(eventId: number, token: string, reason: string): Promise<void> {
  await (await database()).update(events).set({ status: "reconciliation_required", processingToken: null, holdReason: reason.slice(0, 2000) })
    .where(and(eq(events.id, eventId), eq(events.scopeKey, D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY), eq(events.processingToken, token), inArray(events.status, ["reserved", "submitted"])));
}
/** Completion follows a fresh source/Main/Authorised-Deposit full readback; original receipts are never changed. */
export async function completeD702946AuthorisedDepositMainDeductionRecovery(input: { eventId: number; payloadHash: string; executionId: number; readbackEvidence: unknown; token?: string }): Promise<void> {
  const event = await getD702946AuthorisedDepositMainDeductionRecoveryEvent(input.eventId), readback = input.readbackEvidence as Record<string, any>;
  if (!event || event.scopeKey !== D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY || !event.submittedAt || event.executionId !== input.executionId ||
    event.payloadHash !== input.payloadHash || !readback || readback.executionId !== input.executionId || readback.payloadHash !== event.payloadHash ||
    readback.anchorEvidenceHash !== event.anchorEvidenceHash || !readback.noXeroWrite || financialSha256(readback.deposit) !== financialSha256(event.depositXeroSnapshot) ||
    financialSha256(event.authorisedPayload) !== event.payloadHash) throw new Error("Authorised-Deposit recovery completion requires the retained exact full consumed-payload readback evidence.");
  assertD702946AuthorisedDepositRecoveryReadback(readback.main, event.authorisedPayload as FinancialDraftPayload);
  const conditions = [eq(events.id, input.eventId), eq(events.scopeKey, D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY), eq(events.payloadHash, input.payloadHash), eq(events.executionId, input.executionId)];
  if (input.token) conditions.push(eq(events.status, "submitted"), eq(events.processingToken, input.token));
  else conditions.push(eq(events.status, "reconciliation_required"), isNull(events.processingToken));
  if (!affected(await (await database()).update(events).set({ status: "draft_updated", processingToken: null, holdReason: null, readbackEvidence: input.readbackEvidence }).where(and(...conditions))))
    throw new Error("Authorised-Deposit recovery completion lost its exact submitted receipt; reconciliation required.");
}
