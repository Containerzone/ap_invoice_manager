import { and, eq, isNull } from "drizzle-orm";
import {
  financialFinalWeightAdjustmentEvents as adjustmentEvents,
  financialFinalWeightReconciliationEvents as reconciliationEvents,
  financialFinalWeightReconciliationRemediationEvents as remediationEvents,
  type FinancialFinalWeightReconciliationEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { buildFinalWeightAdjustment, FINAL_WEIGHT_RULES_VERSION, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { readFinalWeightFacts } from "./financialFinalWeightAdjustmentSource";
import { readFinalWeightXeroEvidence } from "./financialReadOnlyXeroService";
import {
  finalWeightReconciliationOrigin,
  finalWeightReconciliationOriginalHash,
  isFinalWeightReconciliationVerifierDefectHoldReason,
} from "./financialFinalWeightReconciliationOrigin";
import type { FinalWeightReconciliationEvidence } from "./financialFinalWeightReconciliationDb";

const affected = (result: any) => Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Final Weight reconciliation remediation audit ledger is unavailable.");
  return db;
}

export type FinalWeightReconciliationRemediationPriorEvidence = {
  id: number;
  originalEventId: number;
  recoveryKey: string;
  direction: string;
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  xeroInvoiceId: string;
  originalEventHash: string;
  sourceSnapshotHash: string;
  xeroPreflightHash: string;
  sourceSnapshot: unknown;
  xeroPreflight: unknown;
  originalDraft: unknown;
  expectedDraft: unknown;
  originalDraftHash: string;
  expectedDraftHash: string;
  releaseKey: string | null;
  authorisedPayload: unknown;
  processingToken: string | null;
  status: string;
  holdReason: string | null;
  executionId: number | null;
  submittedAt: Date | null;
  readbackEvidence: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Copies the complete previous reconciliation receipt into a new immutable
 * remediation record. The original receipt is read only: no replay path updates
 * or clears it.
 */
export function finalWeightReconciliationRemediationPriorEvidence(
  receipt: FinancialFinalWeightReconciliationEvent,
): FinalWeightReconciliationRemediationPriorEvidence {
  return {
    id: receipt.id,
    originalEventId: receipt.originalEventId,
    recoveryKey: receipt.recoveryKey,
    direction: receipt.direction,
    dealId: receipt.dealId,
    dealNumber: receipt.dealNumber,
    invoiceNumber: receipt.invoiceNumber,
    xeroInvoiceId: receipt.xeroInvoiceId,
    originalEventHash: receipt.originalEventHash,
    sourceSnapshotHash: receipt.sourceSnapshotHash,
    xeroPreflightHash: receipt.xeroPreflightHash,
    sourceSnapshot: receipt.sourceSnapshot,
    xeroPreflight: receipt.xeroPreflight,
    originalDraft: receipt.originalDraft,
    expectedDraft: receipt.expectedDraft,
    originalDraftHash: receipt.originalDraftHash,
    expectedDraftHash: receipt.expectedDraftHash,
    releaseKey: receipt.releaseKey,
    authorisedPayload: receipt.authorisedPayload,
    processingToken: receipt.processingToken,
    status: receipt.status,
    holdReason: receipt.holdReason,
    executionId: receipt.executionId,
    submittedAt: receipt.submittedAt,
    readbackEvidence: receipt.readbackEvidence,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
  };
}

export function isEligibleFinalWeightReconciliationVerifierDefectReceipt(
  receipt: FinancialFinalWeightReconciliationEvent | null | undefined,
): receipt is FinancialFinalWeightReconciliationEvent {
  return Boolean(receipt &&
    receipt.status === "reconciliation_required" &&
    receipt.processingToken === null &&
    receipt.executionId === null &&
    receipt.submittedAt === null &&
    isFinalWeightReconciliationVerifierDefectHoldReason(receipt.holdReason) &&
    receipt.authorisedPayload && typeof receipt.authorisedPayload === "object" &&
    typeof (receipt.authorisedPayload as { hash?: unknown }).hash === "string" &&
    (receipt.authorisedPayload as { payload?: unknown }).payload &&
    typeof (receipt.authorisedPayload as { payload?: unknown }).payload === "object");
}

export async function getFinalWeightReconciliationRemediationEvent(id: number) {
  return (await (await database()).select().from(remediationEvents).where(eq(remediationEvents.id, id)).limit(1))[0] ?? null;
}

/**
 * Creates exactly one separately-audited attempt for a verifier-defect receipt.
 * An extant remediation record is never reopened, even if it is only held.
 */
export async function reserveFinalWeightReconciliationRemediation(input: {
  priorReceipt: FinancialFinalWeightReconciliationEvent;
  evidence: FinalWeightReconciliationEvidence;
  token: string;
}) {
  const db = await database();
  const priorEvidence = finalWeightReconciliationRemediationPriorEvidence(input.priorReceipt);
  const priorReceiptHash = financialSha256(priorEvidence);
  const remediationKey = financialSha256({ priorReceiptHash, evidence: input.evidence });
  let event = (await db.select().from(remediationEvents)
    .where(eq(remediationEvents.priorReconciliationEventId, input.priorReceipt.id)).limit(1))[0];
  if (event) return { state: event.status === "draft_updated" ? "completed" as const : "blocked" as const, event };
  try {
    await db.insert(remediationEvents).values({
      ...input.evidence,
      priorReconciliationEventId: input.priorReceipt.id,
      priorReceiptHash,
      priorReceiptEvidence: priorEvidence,
      remediationKey,
      status: "reserved",
      processingToken: input.token,
      releaseKey: null,
      authorisedPayload: null,
      holdReason: null,
      executionId: null,
      submittedAt: null,
      readbackEvidence: null,
    });
  } catch (error) {
    if ((error as any)?.code !== "ER_DUP_ENTRY") throw error;
  }
  event = (await db.select().from(remediationEvents)
    .where(eq(remediationEvents.priorReconciliationEventId, input.priorReceipt.id)).limit(1))[0];
  if (!event) throw new Error("Final Weight remediation receipt could not be read back.");
  if (event.remediationKey !== remediationKey || event.processingToken !== input.token || event.status !== "reserved") {
    return { state: event.status === "draft_updated" ? "completed" as const : "blocked" as const, event };
  }
  return { state: "reserved" as const, event };
}

export async function bindFinalWeightReconciliationRemediationPayload(
  eventId: number,
  token: string,
  releaseKey: string,
  payload: FinancialDraftPayload,
) {
  const db = await database();
  if (!affected(await db.update(remediationEvents).set({
    releaseKey,
    authorisedPayload: { hash: financialSha256(payload), payload },
  }).where(and(
    eq(remediationEvents.id, eventId),
    eq(remediationEvents.status, "reserved"),
    eq(remediationEvents.processingToken, token),
    isNull(remediationEvents.authorisedPayload),
  )))) {
    throw new Error("Final Weight remediation payload can only bind once to its exclusive reservation.");
  }
}

export async function verifyFinalWeightReconciliationRemediationWriteAccess(input: {
  eventId: number;
  token: string;
  releaseKey: string;
  preparedBy: number;
  payload: FinancialDraftPayload;
}) {
  const db = await database();
  const policy = await getFinalWeightReleasePolicy();
  if (process.env.FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED !== "true") throw new Error("Final Weight reconciliation release is disabled.");
  const event = await getFinalWeightReconciliationRemediationEvent(input.eventId);
  const prior = event ? (await db.select().from(reconciliationEvents)
    .where(eq(reconciliationEvents.id, event.priorReconciliationEventId)).limit(1))[0] : null;
  const original = prior ? (await db.select().from(adjustmentEvents)
    .where(eq(adjustmentEvents.id, prior.originalEventId)).limit(1))[0] : null;
  const authorised = event?.authorisedPayload as { hash?: string } | null;
  const priorEvidence = prior ? finalWeightReconciliationRemediationPriorEvidence(prior) : null;
  if (!event || !prior || !original || !priorEvidence ||
    !isEligibleFinalWeightReconciliationVerifierDefectReceipt(prior) ||
    finalWeightReconciliationOrigin(original) !== "xero_drift" ||
    prior.originalEventId !== original.id ||
    prior.invoiceNumber !== original.invoiceNumber || prior.xeroInvoiceId !== original.xeroInvoiceId ||
    event.originalEventId !== original.id || event.invoiceNumber !== original.invoiceNumber || event.xeroInvoiceId !== original.xeroInvoiceId ||
    event.direction !== original.direction || event.dealId !== original.dealId ||
    event.priorReceiptHash !== financialSha256(priorEvidence) ||
    financialSha256(event.priorReceiptEvidence) !== event.priorReceiptHash ||
    event.status !== "reserved" || event.processingToken !== input.token ||
    event.releaseKey !== input.releaseKey || event.releaseKey !== policy.releaseKey ||
    !authorised || authorised.hash !== financialSha256(input.payload) ||
    input.payload.documentNumber !== event.invoiceNumber || input.payload.expectedXeroDocumentId !== event.xeroInvoiceId ||
    finalWeightReconciliationOriginalHash(original) !== event.originalEventHash) {
    throw new Error("Final Weight remediation requires the exact no-execution verifier-defect receipt, immutable prior evidence and a new exact-resource reservation.");
  }
  assertFinalWeightRelease(policy, event.direction);
  const facts = await readFinalWeightFacts(event.dealId, event.direction);
  if (!facts.sourceRefreshedAt || Date.parse(facts.sourceRefreshedAt) < Date.parse(policy.effectiveFrom!) ||
    sourceSnapshotHash({ ...facts, direction: event.direction, rulesVersion: FINAL_WEIGHT_RULES_VERSION }) !== event.sourceSnapshotHash) {
    throw new Error("Final Weight remediation source is stale or changed.");
  }
  // Current Draft ContactID remains authoritative; a renamed VTiger contact must
  // not turn this known verifier defect into a different Xero preflight result.
  const xero = await readFinalWeightXeroEvidence(event.invoiceNumber, facts.customerName, event.direction, { skipCustomerMatch: true });
  if (financialSha256(xero) !== event.xeroPreflightHash) throw new Error("Final Weight remediation Xero evidence changed.");
  const preview = buildFinalWeightAdjustment(facts, event.direction, xero);
  if (!preview.eligible || !preview.originalDraft || !preview.expectedDraft ||
    financialSha256(preview.originalDraft) !== event.originalDraftHash ||
    financialSha256(preview.expectedDraft) !== event.expectedDraftHash ||
    financialSha256(prepareFinalWeightPayload(preview, event.sourceSnapshotHash)) !== financialSha256(input.payload)) {
    throw new Error("Final Weight remediation current Draft is no longer the independently approved exact amendment.");
  }
}

export async function consumeFinalWeightReconciliationRemediationPayload(input: { eventId: number; token: string }, executionId: number) {
  const db = await database();
  if (!affected(await db.update(remediationEvents).set({ status: "submitted", submittedAt: new Date(), executionId })
    .where(and(eq(remediationEvents.id, input.eventId), eq(remediationEvents.status, "reserved"),
      eq(remediationEvents.processingToken, input.token), isNull(remediationEvents.submittedAt))))) {
    throw new Error("Final Weight remediation payload was already consumed or reservation lost.");
  }
}

export async function completeFinalWeightReconciliationRemediation(input: { eventId: number; token: string; executionId: number; readbackEvidence: unknown }) {
  const db = await database();
  if (!affected(await db.update(remediationEvents).set({
    status: "draft_updated",
    executionId: input.executionId,
    readbackEvidence: input.readbackEvidence,
    processingToken: null,
    holdReason: null,
  }).where(and(eq(remediationEvents.id, input.eventId), eq(remediationEvents.status, "submitted"),
    eq(remediationEvents.processingToken, input.token))))) {
    throw new Error("Final Weight remediation completion requires manual reconciliation.");
  }
}

export async function holdFinalWeightReconciliationRemediation(eventId: number, token: string, reason: string) {
  const db = await database();
  await db.update(remediationEvents).set({
    status: "reconciliation_required",
    processingToken: null,
    holdReason: reason.slice(0, 2000),
  }).where(and(eq(remediationEvents.id, eventId), eq(remediationEvents.processingToken, token), eq(remediationEvents.status, "reserved")));
}
