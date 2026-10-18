import { and, eq, isNull } from "drizzle-orm";
import { financialDepositMainDeductionEvents, financialWriterExecutions, type FinancialDepositMainDeductionEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";

const affected = (result: any) => Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
async function database() {
  const db = await getDb();
  if (!db) throw new Error("Deposit-to-main deduction audit ledger is unavailable.");
  return db;
}
export const depositMainDeductionPayloadHash = (payload: FinancialDraftPayload) => financialSha256(payload);

export async function reserveDepositMainDeduction(input: {
  dealId: string; dealNumber: string; depositInvoiceNumber: string; depositXeroInvoiceId: string;
  mainInvoiceNumber: string; mainXeroInvoiceId: string; sourceSnapshotHash: string; xeroEvidenceHash: string; token: string;
}): Promise<{ state: "reserved"; event: FinancialDepositMainDeductionEvent } | { state: "completed"; event: FinancialDepositMainDeductionEvent } | { state: "blocked"; event: FinancialDepositMainDeductionEvent }> {
  const db = await database();
  const { token, ...evidence } = input;
  const evidenceKey = financialSha256(evidence);
  const values = { ...evidence, evidenceKey, status: "previewed" as const, processingToken: null, releaseKey: null, authorisedPayload: null, holdReason: null, executionId: null };
  let event = (await db.select().from(financialDepositMainDeductionEvents).where(eq(financialDepositMainDeductionEvents.depositXeroInvoiceId, input.depositXeroInvoiceId)).limit(1))[0];
  if (!event) {
    try {
      await db.insert(financialDepositMainDeductionEvents).values(values);
    } catch (error) {
      if ((error as any)?.code !== "ER_DUP_ENTRY") throw error;
    }
    event = (await db.select().from(financialDepositMainDeductionEvents).where(eq(financialDepositMainDeductionEvents.depositXeroInvoiceId, input.depositXeroInvoiceId)).limit(1))[0];
  }
  if (!event) throw new Error("Deposit-to-main deduction receipt could not be read back.");
  if (event.status === "draft_updated") return { state: "completed", event };
  if (event.evidenceKey !== evidenceKey) return { state: "blocked", event };
  if (event.status !== "previewed") return { state: "blocked", event };
  const claimed = affected(await db.update(financialDepositMainDeductionEvents).set({ status: "reserved", processingToken: token })
    .where(and(eq(financialDepositMainDeductionEvents.id, event.id), eq(financialDepositMainDeductionEvents.status, "previewed"), isNull(financialDepositMainDeductionEvents.processingToken), eq(financialDepositMainDeductionEvents.sourceSnapshotHash, input.sourceSnapshotHash), eq(financialDepositMainDeductionEvents.xeroEvidenceHash, input.xeroEvidenceHash))));
  if (!claimed) {
    const current = (await db.select().from(financialDepositMainDeductionEvents).where(eq(financialDepositMainDeductionEvents.id, event.id)).limit(1))[0]!;
    return current.status === "draft_updated" ? { state: "completed", event: current } : { state: "blocked", event: current };
  }
  const reserved = (await db.select().from(financialDepositMainDeductionEvents).where(eq(financialDepositMainDeductionEvents.id, event.id)).limit(1))[0]!;
  return { state: "reserved", event: reserved };
}

export async function bindDepositMainDeductionPayload(eventId: number, token: string, releaseKey: string, payload: FinancialDraftPayload) {
  const db = await database();
  if (!affected(await db.update(financialDepositMainDeductionEvents).set({ releaseKey, authorisedPayload: { hash: depositMainDeductionPayloadHash(payload), payload } })
    .where(and(eq(financialDepositMainDeductionEvents.id, eventId), eq(financialDepositMainDeductionEvents.status, "reserved"), eq(financialDepositMainDeductionEvents.processingToken, token), isNull(financialDepositMainDeductionEvents.authorisedPayload))))) {
    throw new Error("Deposit-to-main deduction payload can only be bound once to its exclusive reservation.");
  }
}

export async function verifyDepositMainDeductionWriteAccess(input: { eventId: number; token: string; releaseKey: string; preparedBy: number; payload: FinancialDraftPayload }) {
  const db = await database();
  const event = (await db.select().from(financialDepositMainDeductionEvents).where(eq(financialDepositMainDeductionEvents.id, input.eventId)).limit(1))[0];
  const auth = event?.authorisedPayload as { hash?: string } | null;
  if (!event || event.status !== "reserved" || event.processingToken !== input.token || !event.releaseKey || event.releaseKey !== input.releaseKey || !auth || auth.hash !== depositMainDeductionPayloadHash(input.payload) || !event.mainXeroInvoiceId || input.payload.expectedXeroDocumentId !== event.mainXeroInvoiceId || input.payload.documentNumber !== event.mainInvoiceNumber || input.preparedBy <= 0) {
    throw new Error("Deposit-to-main deduction lacks an immutable exact-Draft reservation.");
  }
}

export async function completeDepositMainDeduction(input: { eventId: number; token: string; executionId: number }) {
  const db = await database();
  if (!affected(await db.update(financialDepositMainDeductionEvents).set({ status: "draft_updated", executionId: input.executionId, processingToken: null, holdReason: null })
    .where(and(eq(financialDepositMainDeductionEvents.id, input.eventId), eq(financialDepositMainDeductionEvents.status, "reserved"), eq(financialDepositMainDeductionEvents.processingToken, input.token))))) {
    throw new Error("Deposit-to-main deduction requires reconciliation; exclusive reservation was lost.");
  }
}
export async function holdDepositMainDeduction(eventId: number, token: string, reason: string) {
  const db = await database();
  await db.update(financialDepositMainDeductionEvents).set({ status: "reconciliation_required", processingToken: null, holdReason: reason.slice(0, 2000) })
    .where(and(eq(financialDepositMainDeductionEvents.id, eventId), eq(financialDepositMainDeductionEvents.status, "reserved"), eq(financialDepositMainDeductionEvents.processingToken, token)));
}

/**
 * Completes only a locally uncertain deduction after an independent exact Xero
 * GET read-back has proven that its immutable bound payload is already present.
 * This function has no Xero dependency and cannot submit, retry or alter a
 * financial document.
 */
export async function reconcileVerifiedDepositMainDeduction(input: {
  eventId: number;
  payload: FinancialDraftPayload;
  xeroDocumentId: string;
  documentNumber: string;
  status: "DRAFT";
}) {
  const db = await database();
  const event = (await db.select().from(financialDepositMainDeductionEvents)
    .where(eq(financialDepositMainDeductionEvents.id, input.eventId)).limit(1))[0];
  if (!event) throw new Error("Deposit-to-main reconciliation event was not found.");
  const authorization = event.authorisedPayload as { hash?: string } | null;
  if (event.status === "draft_updated") return { event, executionId: event.executionId, alreadyCompleted: true };
  if (event.status !== "reconciliation_required" || !authorization || authorization.hash !== depositMainDeductionPayloadHash(input.payload) ||
    event.mainXeroInvoiceId !== input.xeroDocumentId || event.mainInvoiceNumber !== input.documentNumber || input.status !== "DRAFT") {
    throw new Error("Deposit-to-main reconciliation cannot adopt a different event, payload or Xero Draft.");
  }
  const execution = (await db.select().from(financialWriterExecutions)
    .where(eq(financialWriterExecutions.idempotencyKey, input.payload.idempotencyKey)).limit(1))[0];
  if (!execution || execution.workflowType !== "deposit_main_deduction" || execution.proposedAction !== "update_draft" ||
    execution.proposedDocumentNumber !== event.mainInvoiceNumber || execution.targetXeroDocumentId !== event.mainXeroInvoiceId ||
    !["reconciliation_required", "succeeded"].includes(execution.status)) {
    throw new Error("Deposit-to-main reconciliation lacks the exact uncertain writer receipt.");
  }
  if (execution.status === "reconciliation_required") {
    const updated = affected(await db.update(financialWriterExecutions).set({
      status: "succeeded",
      xeroDocumentId: input.xeroDocumentId,
      xeroDocumentStatus: "DRAFT",
      xeroResponseSummary: { documentNumber: input.documentNumber, endpoint: input.payload.endpoint, idempotencyKey: input.payload.idempotencyKey, reconciledFromExactReadback: true } as any,
      errorMessage: "Reconciled as succeeded from a fresh exact Xero Draft read-back after the post-write receipt was uncertain.",
      completedAt: new Date(),
    }).where(and(eq(financialWriterExecutions.id, execution.id), eq(financialWriterExecutions.status, "reconciliation_required"))));
    if (!updated) throw new Error("Deposit-to-main writer receipt changed during reconciliation.");
  }
  const completed = affected(await db.update(financialDepositMainDeductionEvents).set({
    status: "draft_updated",
    executionId: execution.id,
    processingToken: null,
    holdReason: "Verified exact Xero Draft read-back reconciled the post-write receipt; no retry was sent.",
  }).where(and(eq(financialDepositMainDeductionEvents.id, event.id), eq(financialDepositMainDeductionEvents.status, "reconciliation_required"), isNull(financialDepositMainDeductionEvents.executionId))));
  if (!completed) throw new Error("Deposit-to-main event changed during reconciliation; no local adoption was performed.");
  const reconciled = (await db.select().from(financialDepositMainDeductionEvents)
    .where(eq(financialDepositMainDeductionEvents.id, event.id)).limit(1))[0]!;
  return { event: reconciled, executionId: execution.id, alreadyCompleted: false };
}
