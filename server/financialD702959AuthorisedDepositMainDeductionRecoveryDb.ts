import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  financialD702959AuthorisedDepositMainDeductionRecoveryEvents as events,
  financialMainCustomerInvoiceEvents as originals,
  financialDepositInvoiceEvents as deposits,
  financialWriterExecutions as writers,
  financialBillingPartySyncLocks as billingLocks,
  financialFinalWeightAdjustmentEvents as finalWeights,
  financialFinalWeightReconciliationEvents as finalWeightRecoveries,
  financialFinalWeightReconciliationRemediationEvents as finalWeightRemediations,
  financialDepositMainDeductionEvents as deductions,
  financialWarrantyAvisoEvents as warranties,
  type FinancialD702959AuthorisedDepositMainDeductionRecoveryEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import {
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease,
  getD702959AuthorisedDepositMainDeductionRecoveryPolicy,
  type D702959AuthorisedDepositMainDeductionRecoveryPolicy,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryRelease";
import {
  D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope,
  D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY,
  assertD702959AuthorisedDepositRecoveryPayload,
  assertD702959AuthorisedDepositRecoveryReadback,
  assertD702959AuthorisedDepositRecoverySource,
  assertD702959DepositMatchesSource,
  prepareD702959AuthorisedDepositMainDeductionRecoveryPayload,
  jsonEvidence,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryScope";

async function database() {
  const db = await getDb();
  if (!db) throw new Error("D702959 recovery ledger unavailable; its separate migration requires explicit review/application.");
  return db;
}
const affected = (result: any) => Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;

export type D702959AuthorisedDepositRecoveryEvidence = {
  scopeKey: string; dealId: string; dealNumber: string; originalMainEventId: number; failedMainWriterExecutionId: number;
  depositEventId: number; depositWriterExecutionId: number; mainInvoiceNumber: string; mainXeroInvoiceId: string;
  depositInvoiceNumber: string; depositXeroInvoiceId: string; anchorEvidenceHash: string; anchorEvidence: Record<string, any>;
  sourceSnapshotHash: string; sourceSnapshot: Record<string, any>; xeroEvidenceHash: string;
  mainXeroSnapshot: Record<string, any>; depositXeroSnapshot: Record<string, any>;
};

export async function getD702959AuthorisedDepositMainDeductionRecoveryEvent(id: number): Promise<FinancialD702959AuthorisedDepositMainDeductionRecoveryEvent | null> {
  return (await (await database()).select().from(events).where(eq(events.id, id)).limit(1))[0] ?? null;
}

/** Read-only cross-writer lock for the one current D702959 Main resource. */
export async function getPendingD702959AuthorisedDepositMainDeductionRecovery(mainXeroInvoiceId: string): Promise<FinancialD702959AuthorisedDepositMainDeductionRecoveryEvent | null> {
  if (mainXeroInvoiceId !== scope.mainXeroInvoiceId) return null;
  return (await (await database()).select().from(events).where(and(
    eq(events.mainXeroInvoiceId, scope.mainXeroInvoiceId),
    inArray(events.status, ["reserved", "submitted", "reconciliation_required"]),
  )).limit(1))[0] ?? null;
}

/**
 * Historic event JSON omitted undefined payload properties before hashing. Do
 * not recompute its in-memory hash from the stored JSON: require instead the
 * retained SHA-shaped event hash, complete exact structural payload and the
 * independent exact writer idempotency/fingerprint below. The whole immutable
 * anchor object is hashed again into every new recovery receipt.
 */
function exactStoredDepositPayload(value: any, expectedNumber: string): boolean {
  const payload = value?.payload as FinancialDraftPayload | undefined;
  return /^[a-f0-9]{64}$/i.test(String(value?.hash ?? "")) && value?.number === expectedNumber && !!payload &&
    payload.method === "POST" && payload.endpoint === "/Invoices" && payload.documentFamily === "customer_invoice" &&
    payload.expectedXeroDocumentId === null && payload.documentNumber === expectedNumber &&
    /^[a-f0-9]{64}$/i.test(String(payload.idempotencyKey ?? ""));
}
function assertSuccessfulDepositCreate(writer: any, payload: FinancialDraftPayload): void {
  if (!writer || writer.id !== scope.depositWriterExecutionId || writer.status !== "succeeded" || writer.workflowType !== "deposit_invoice" ||
    writer.documentFamily !== "customer_invoice" || writer.proposedAction !== "create_draft" || writer.proposedDocumentNumber !== scope.depositInvoiceNumber ||
    writer.targetXeroDocumentId !== null || writer.endpoint !== "/Invoices" || writer.method !== "POST" ||
    writer.idempotencyKey !== payload.idempotencyKey || writer.payloadFingerprint !== `${payload.idempotencyKey.slice(0, 24)}:POST:/Invoices` ||
    writer.xeroDocumentId !== scope.depositXeroInvoiceId || writer.xeroDocumentStatus !== "DRAFT" || !writer.submittedAt || !writer.completedAt ||
    !writer.approvalReference || writer.xeroResponseSummary?.documentNumber !== scope.depositInvoiceNumber ||
    writer.xeroResponseSummary?.endpoint !== "/Invoices" || writer.xeroResponseSummary?.idempotencyKey !== payload.idempotencyKey) {
    throw new Error("D702959 recovery requires the exact successful immutable Deposit creation writer receipt.");
  }
}

/**
 * The original Main receipt is immutable reconciliation evidence only, while the
 * successful Deposit receipt establishes the sole permitted Deposit evidence.
 * Neither receipt is ever updated, completed, or adopted by this recovery.
 */
export function assertD702959AuthorisedDepositRecoveryAnchors(anchor: Record<string, any>): void {
  const { originalMain, failedMainWriter, deposit, depositWriter } = anchor;
  const depositPayload = deposit?.authorisedPayload?.payload as FinancialDraftPayload;
  const depositRow = Array.isArray((depositPayload?.body as any)?.Invoices) && (depositPayload.body as any).Invoices.length === 1
    ? (depositPayload.body as any).Invoices[0] as Record<string, any>
    : null;
  if (!originalMain || originalMain.id !== scope.originalMainEventId || originalMain.dealId !== scope.dealId ||
    originalMain.dealNumber !== scope.dealNumber || originalMain.proposedInvoiceNumber !== scope.mainInvoiceNumber ||
    originalMain.status !== "reconciliation_required" || originalMain.processingToken !== null || originalMain.xeroInvoiceId !== null ||
    originalMain.executionId !== null || originalMain.authorisedPayload?.number !== scope.mainInvoiceNumber ||
    !/^[a-f0-9]{64}$/.test(String(originalMain.authorisedPayload?.hash ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(originalMain.authorisedPayload?.bodyHash ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(originalMain.sourceSnapshotHash ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(originalMain.xeroPreflightHash ?? "")) || !originalMain.proposal ||
    originalMain.proposal?.sourceRecordId !== scope.dealId || originalMain.proposal?.proposedDocumentNumber !== scope.mainInvoiceNumber ||
    originalMain.proposal?.documentType !== "main_customer_invoice" || originalMain.proposal?.documentFamily !== "customer_invoice" ||
    originalMain.proposal?.proposedAction !== "create_draft" || originalMain.proposal?.gstTreatment !== "GST_EXCLUSIVE" ||
    originalMain.proposal?.currency !== "AUD" || !originalMain.proposal?.partySourceId ||
    !failedMainWriter || failedMainWriter.id !== scope.failedMainWriterExecutionId || failedMainWriter.workflowType !== "main_customer_invoice" ||
    failedMainWriter.documentFamily !== "customer_invoice" || failedMainWriter.proposedAction !== "create_draft" ||
    failedMainWriter.proposedDocumentNumber !== scope.mainInvoiceNumber || failedMainWriter.targetXeroDocumentId !== null ||
    failedMainWriter.endpoint !== "/Invoices" || failedMainWriter.method !== "POST" || failedMainWriter.status !== "reconciliation_required" ||
    failedMainWriter.xeroDocumentId !== null || failedMainWriter.xeroDocumentStatus !== null || failedMainWriter.xeroResponseSummary !== null ||
    failedMainWriter.errorMessage !== scope.originalMainWriterError || !/^[a-f0-9]{64}$/.test(String(failedMainWriter.idempotencyKey ?? "")) ||
    failedMainWriter.payloadFingerprint !== `${String(failedMainWriter.idempotencyKey).slice(0, 24)}:POST:/Invoices` || !failedMainWriter.submittedAt || !failedMainWriter.completedAt ||
    !deposit || deposit.id !== scope.depositEventId || deposit.dealId !== scope.dealId || deposit.dealNumber !== scope.dealNumber ||
    deposit.proposedInvoiceNumber !== scope.depositInvoiceNumber || deposit.claimedDealId !== scope.dealId || deposit.claimedInvoiceNumber !== scope.depositInvoiceNumber ||
    deposit.status !== "drafts_created" || deposit.processingToken !== null || deposit.xeroInvoiceId !== scope.depositXeroInvoiceId ||
    deposit.executionId !== scope.depositWriterExecutionId || !exactStoredDepositPayload(deposit.authorisedPayload, scope.depositInvoiceNumber) ||
    depositRow?.InvoiceNumber !== scope.depositInvoiceNumber || depositRow?.Type !== "ACCREC" || depositRow?.Status !== "DRAFT" ||
    depositRow?.LineAmountTypes !== "Inclusive" || depositRow?.CurrencyCode !== "AUD" || depositRow?.LineItems?.length !== 1 ||
    depositRow?.LineItems?.[0]?.ItemCode !== "Deposit Required" || !depositRow?.Contact?.ContactID) {
    throw new Error("Only the exact immutable D702959 Main failure and successful Deposit creation receipts may anchor this recovery.");
  }
  assertSuccessfulDepositCreate(depositWriter, depositPayload);
}

export async function readD702959AuthorisedDepositRecoveryAnchors(): Promise<Record<string, any>> {
  const db = await database();
  const [originalMainRows, failedWriterRows, depositRows, depositWriterRows] = await Promise.all([
    db.select().from(originals).where(eq(originals.id, scope.originalMainEventId)).limit(1),
    db.select().from(writers).where(eq(writers.id, scope.failedMainWriterExecutionId)).limit(1),
    db.select().from(deposits).where(eq(deposits.id, scope.depositEventId)).limit(1),
    db.select().from(writers).where(eq(writers.id, scope.depositWriterExecutionId)).limit(1),
  ]);
  const anchor = jsonEvidence({ originalMain: originalMainRows[0], failedMainWriter: failedWriterRows[0], deposit: depositRows[0], depositWriter: depositWriterRows[0] });
  assertD702959AuthorisedDepositRecoveryAnchors(anchor);
  return anchor;
}

/** GET/SELECT-only. The recovery cannot reserve while any competing Main amendment is pending. */
export async function assertNoD702959AuthorisedDepositRecoveryCompetingPaths(ownExecutionId?: number): Promise<void> {
  const db = await database();
  const writerConditions = [or(eq(writers.targetXeroDocumentId, scope.mainXeroInvoiceId), eq(writers.proposedDocumentNumber, scope.mainInvoiceNumber))!,
    inArray(writers.status, ["prepared", "submitted", "reconciliation_required"]),
    // The sole named original validation/readback mismatch is immutable anchor
    // evidence, not a competing amendment; no other historical writer is exempt.
    ne(writers.id, scope.failedMainWriterExecutionId)];
  if (ownExecutionId !== undefined) writerConditions.push(ne(writers.id, ownExecutionId));
  const conflicts = await Promise.all([
    db.select().from(writers).where(and(...writerConditions)).limit(1),
    db.select().from(billingLocks).where(and(eq(billingLocks.xeroInvoiceId, scope.mainXeroInvoiceId), inArray(billingLocks.state, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(finalWeights).where(and(or(eq(finalWeights.dealId, scope.dealId), eq(finalWeights.xeroInvoiceId, scope.mainXeroInvoiceId)), inArray(finalWeights.status, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(finalWeightRecoveries).where(and(or(eq(finalWeightRecoveries.dealId, scope.dealId), eq(finalWeightRecoveries.xeroInvoiceId, scope.mainXeroInvoiceId)), inArray(finalWeightRecoveries.status, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(finalWeightRemediations).where(and(or(eq(finalWeightRemediations.dealId, scope.dealId), eq(finalWeightRemediations.xeroInvoiceId, scope.mainXeroInvoiceId)), inArray(finalWeightRemediations.status, ["reserved", "submitted", "reconciliation_required"]))).limit(1),
    db.select().from(deductions).where(and(or(eq(deductions.dealId, scope.dealId), eq(deductions.mainXeroInvoiceId, scope.mainXeroInvoiceId)), inArray(deductions.status, ["reserved", "draft_updated", "reconciliation_required"]))).limit(1),
    db.select().from(warranties).where(and(eq(warranties.dealId, scope.dealId), inArray(warranties.status, ["reserved", "main_submitted", "main_receipt", "po_submitted", "po_receipt", "reconciliation_required"]))).limit(1),
  ]);
  if (conflicts.some(rows => rows.length)) throw new Error("A competing writer, billing-party, Final Weight, generic deduction, or Warranty path holds D702959 recovery.");
}

export async function reserveD702959AuthorisedDepositMainDeductionRecovery(input: { evidence: D702959AuthorisedDepositRecoveryEvidence; payload: FinancialDraftPayload; policy: D702959AuthorisedDepositMainDeductionRecoveryPolicy; token: string }) {
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease(input.policy);
  assertD702959AuthorisedDepositRecoveryPayload(input.payload);
  const { evidence, payload, policy, token } = input;
  const fixed = { scopeKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber,
    originalMainEventId: scope.originalMainEventId, failedMainWriterExecutionId: scope.failedMainWriterExecutionId,
    depositEventId: scope.depositEventId, depositWriterExecutionId: scope.depositWriterExecutionId,
    mainInvoiceNumber: scope.mainInvoiceNumber, mainXeroInvoiceId: scope.mainXeroInvoiceId,
    depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId };
  if (!token || Object.entries(fixed).some(([key, value]) => (evidence as any)[key] !== value) ||
    evidence.anchorEvidenceHash !== financialSha256(evidence.anchorEvidence) || evidence.sourceSnapshotHash !== financialSha256(evidence.sourceSnapshot) ||
    evidence.xeroEvidenceHash !== financialSha256({ main: evidence.mainXeroSnapshot, deposit: evidence.depositXeroSnapshot })) {
    throw new Error("Exact immutable D702959 recovery scope/evidence is required.");
  }
  const anchors = await readD702959AuthorisedDepositRecoveryAnchors();
  if (financialSha256(anchors) !== evidence.anchorEvidenceHash) throw new Error("D702959 immutable original/Deposit ownership evidence changed.");
  assertD702959AuthorisedDepositRecoverySource(evidence.sourceSnapshot.mainFacts, evidence.sourceSnapshot.depositFacts);
  assertD702959DepositMatchesSource(evidence.sourceSnapshot.depositFacts, evidence.depositXeroSnapshot);
  if (financialSha256(prepareD702959AuthorisedDepositMainDeductionRecoveryPayload(evidence.mainXeroSnapshot, evidence.depositXeroSnapshot, financialSha256(evidence))) !== financialSha256(payload)) {
    throw new Error("D702959 reservation must bind its independently rebuilt exact Main-only append payload.");
  }
  await assertNoD702959AuthorisedDepositRecoveryCompetingPaths();
  const values = { ...evidence, recoveryKey: financialSha256({ evidence, payload, policy }), payloadHash: financialSha256(payload),
    authorisedPayload: payload, releaseKey: policy.releaseKey, approvedBy: policy.approvedBy!, approvedAt: policy.approvedAt!,
    policyHash: financialSha256(policy), status: "reserved" as const, processingToken: token };
  const db = await database();
  let inserted = false;
  try { await db.insert(events).values(values); inserted = true; }
  catch (error: any) { if (error?.code !== "ER_DUP_ENTRY" && error?.cause?.code !== "ER_DUP_ENTRY") throw error; }
  const event = (await db.select().from(events).where(eq(events.mainXeroInvoiceId, scope.mainXeroInvoiceId)).limit(1))[0];
  if (!event) throw new Error("D702959 recovery receipt could not be read back.");
  if (!inserted || event.scopeKey !== D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY || event.status !== "reserved" ||
    event.processingToken !== token || event.recoveryKey !== values.recoveryKey) {
    return { state: event.scopeKey === D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY && event.status === "draft_updated" ? "completed" as const : "blocked" as const, event };
  }
  return { state: "reserved" as const, event };
}

export async function assertD702959AuthorisedDepositRecoveryWriterReceipt(executionId: number, event: FinancialD702959AuthorisedDepositMainDeductionRecoveryEvent, allowed: string[]): Promise<void> {
  const writer = (await (await database()).select().from(writers).where(eq(writers.id, executionId)).limit(1))[0];
  const payload = event.authorisedPayload as FinancialDraftPayload;
  if (!writer || !allowed.includes(writer.status) || writer.workflowType !== scope.workflowType || writer.proposedAction !== "update_draft" ||
    writer.documentFamily !== "customer_invoice" || writer.proposedDocumentNumber !== scope.mainInvoiceNumber || writer.targetXeroDocumentId !== scope.mainXeroInvoiceId ||
    writer.idempotencyKey !== payload.idempotencyKey || writer.payloadFingerprint !== `${payload.idempotencyKey.slice(0, 24)}:POST:${payload.endpoint}` ||
    writer.method !== "POST" || writer.endpoint !== payload.endpoint || writer.approvalReference !== event.releaseKey || writer.preparedBy !== event.approvedBy || !writer.submittedAt) {
    throw new Error("D702959 recovery cannot exclude or adopt another writer execution.");
  }
}

/** Final boundary verifier used both before consuming and immediately inside the queued Xero POST. */
export async function verifyD702959AuthorisedDepositMainDeductionRecoveryWriteAccess(input: { eventId: number; token: string; releaseKey: string; preparedBy: number; payload: FinancialDraftPayload; executionId?: number; submitted?: boolean }): Promise<void> {
  const policy = await getD702959AuthorisedDepositMainDeductionRecoveryPolicy();
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy);
  assertD702959AuthorisedDepositRecoveryPayload(input.payload);
  const event = await getD702959AuthorisedDepositMainDeductionRecoveryEvent(input.eventId);
  const stateMatches = event && event.scopeKey === D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY && (input.submitted === true
    ? event.status === "submitted" && Boolean(event.submittedAt) && event.executionId === input.executionId && input.executionId !== undefined
    : event.status === "reserved" && !event.submittedAt && !event.executionId);
  if (!event || !stateMatches || event.processingToken !== input.token || event.releaseKey !== input.releaseKey ||
    input.releaseKey !== policy.releaseKey || input.preparedBy !== policy.approvedBy || event.policyHash !== financialSha256(policy) ||
    event.payloadHash !== financialSha256(input.payload) || financialSha256(event.authorisedPayload) !== event.payloadHash) {
    throw new Error("D702959 recovery requires its separate unconsumed exact-payload reservation and named approval.");
  }
  if (input.executionId !== undefined) await assertD702959AuthorisedDepositRecoveryWriterReceipt(input.executionId, event, ["submitted"]);
  const { readD702959AuthorisedDepositMainDeductionRecoveryPreflight } = await import("./financialD702959AuthorisedDepositMainDeductionRecoveryService");
  const fresh = await readD702959AuthorisedDepositMainDeductionRecoveryPreflight(input.executionId);
  if (fresh.status !== "ready" || fresh.evidence.anchorEvidenceHash !== event.anchorEvidenceHash ||
    fresh.evidence.sourceSnapshotHash !== event.sourceSnapshotHash || fresh.evidence.xeroEvidenceHash !== event.xeroEvidenceHash ||
    financialSha256(fresh.evidence) !== financialSha256(extractD702959AuthorisedDepositRecoveryEvidence(event)) ||
    financialSha256(fresh.payload) !== event.payloadHash) {
    throw new Error("Final D702959 verifier: current source/receipts/Xero or rebuilt exact payload changed.");
  }
}

export function extractD702959AuthorisedDepositRecoveryEvidence(event: FinancialD702959AuthorisedDepositMainDeductionRecoveryEvent): D702959AuthorisedDepositRecoveryEvidence {
  const { scopeKey, dealId, dealNumber, originalMainEventId, failedMainWriterExecutionId, depositEventId, depositWriterExecutionId,
    mainInvoiceNumber, mainXeroInvoiceId, depositInvoiceNumber, depositXeroInvoiceId, anchorEvidenceHash, anchorEvidence,
    sourceSnapshotHash, sourceSnapshot, xeroEvidenceHash, mainXeroSnapshot, depositXeroSnapshot } = event;
  return { scopeKey, dealId, dealNumber, originalMainEventId, failedMainWriterExecutionId, depositEventId, depositWriterExecutionId,
    mainInvoiceNumber, mainXeroInvoiceId, depositInvoiceNumber, depositXeroInvoiceId, anchorEvidenceHash, anchorEvidence: anchorEvidence as any,
    sourceSnapshotHash, sourceSnapshot: sourceSnapshot as any, xeroEvidenceHash, mainXeroSnapshot: mainXeroSnapshot as any, depositXeroSnapshot: depositXeroSnapshot as any };
}

/** Atomic consumption is before the Xero transport. There is no transition back to reserved. */
export async function consumeD702959AuthorisedDepositMainDeductionRecoveryPayload(input: { eventId: number; token: string }, executionId: number): Promise<void> {
  const event = await getD702959AuthorisedDepositMainDeductionRecoveryEvent(input.eventId);
  if (!event || event.scopeKey !== D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY) throw new Error("D702959 recovery receipt missing.");
  await assertD702959AuthorisedDepositRecoveryWriterReceipt(executionId, event, ["submitted"]);
  if (!affected(await (await database()).update(events).set({ status: "submitted", submittedAt: new Date(), executionId })
    .where(and(eq(events.id, input.eventId), eq(events.scopeKey, D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY), eq(events.status, "reserved"),
      eq(events.processingToken, input.token), isNull(events.submittedAt), isNull(events.executionId))))) {
    throw new Error("D702959 recovery reservation is already consumed; never POST again.");
  }
}

export async function holdD702959AuthorisedDepositMainDeductionRecovery(eventId: number, token: string, reason: string): Promise<void> {
  await (await database()).update(events).set({ status: "reconciliation_required", processingToken: null, holdReason: reason.slice(0, 2000) })
    .where(and(eq(events.id, eventId), eq(events.scopeKey, D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY), eq(events.processingToken, token),
      inArray(events.status, ["reserved", "submitted"])));
}

/** Completion needs the retained single-write readback; original source and Deposit receipts remain untouched. */
export async function completeD702959AuthorisedDepositMainDeductionRecovery(input: { eventId: number; payloadHash: string; executionId: number; readbackEvidence: unknown; token?: string }): Promise<void> {
  const event = await getD702959AuthorisedDepositMainDeductionRecoveryEvent(input.eventId);
  const readback = input.readbackEvidence as Record<string, any>;
  if (!event || event.scopeKey !== D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY || !event.submittedAt || event.executionId !== input.executionId ||
    event.payloadHash !== input.payloadHash || !readback || readback.executionId !== input.executionId || readback.payloadHash !== event.payloadHash ||
    readback.anchorEvidenceHash !== event.anchorEvidenceHash || !readback.noXeroWrite ||
    financialSha256(readback.deposit) !== financialSha256(event.depositXeroSnapshot) || financialSha256(event.authorisedPayload) !== event.payloadHash) {
    throw new Error("D702959 recovery completion requires exact full consumed-payload readback evidence.");
  }
  assertD702959AuthorisedDepositRecoveryReadback(readback.main, event.authorisedPayload as FinancialDraftPayload);
  const conditions = [eq(events.id, input.eventId), eq(events.scopeKey, D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY),
    eq(events.payloadHash, input.payloadHash), eq(events.executionId, input.executionId)];
  if (input.token) conditions.push(eq(events.status, "submitted"), eq(events.processingToken, input.token));
  else conditions.push(eq(events.status, "reconciliation_required"), isNull(events.processingToken));
  if (!affected(await (await database()).update(events).set({ status: "draft_updated", processingToken: null, holdReason: null, readbackEvidence: input.readbackEvidence })
    .where(and(...conditions)))) {
    throw new Error("D702959 recovery completion lost its exact submitted receipt; reconciliation is required.");
  }
}
