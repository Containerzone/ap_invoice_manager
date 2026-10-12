import { and, eq, isNull } from "drizzle-orm";
import {
  financialFinalWeightAdjustmentEvents as adjustmentEvents,
  financialFinalWeightReconciliationEvents as events,
  type FinancialFinalWeightReconciliationEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { buildFinalWeightAdjustment, FINAL_WEIGHT_RULES_HASH, FINAL_WEIGHT_RULES_VERSION, prepareFinalWeightPayload, type FinalWeightDirection } from "./financialFinalWeightAdjustmentRules";
import { readFinalWeightFacts } from "./financialFinalWeightAdjustmentSource";
import { readFinalWeightXeroEvidence } from "./financialReadOnlyXeroService";

const affected = (result: any) => Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
async function database() {
  const db = await getDb();
  if (!db) throw new Error("Final Weight reconciliation audit ledger is unavailable.");
  return db;
}

export type FinalWeightReconciliationEvidence = {
  originalEventId: number;
  direction: FinalWeightDirection;
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  xeroInvoiceId: string;
  originalEventHash: string;
  sourceSnapshotHash: string;
  xeroPreflightHash: string;
  sourceSnapshot: Record<string, unknown>;
  xeroPreflight: Record<string, unknown>;
  originalDraft: Record<string, unknown>;
  expectedDraft: Record<string, unknown>;
  originalDraftHash: string;
  expectedDraftHash: string;
};

export async function getFinalWeightReconciliationEvent(id: number): Promise<FinancialFinalWeightReconciliationEvent | null> {
  return (await (await database()).select().from(events).where(eq(events.id, id)).limit(1))[0] ?? null;
}

/** Reserves one new audited reconciliation record; original claims remain immutable. */
export async function reserveFinalWeightReconciliation(input: FinalWeightReconciliationEvidence & { token: string }) {
  const db = await database();
  const { token, ...evidence } = input;
  const recoveryKey = financialSha256(evidence);
  let event = (await db.select().from(events).where(eq(events.originalEventId, input.originalEventId)).limit(1))[0];
  if (!event) {
    try {
      await db.insert(events).values({ ...evidence, recoveryKey, status: "previewed", processingToken: null, releaseKey: null, authorisedPayload: null, holdReason: null, executionId: null, submittedAt: null, readbackEvidence: null });
    } catch (error) {
      if ((error as any)?.code !== "ER_DUP_ENTRY") throw error;
    }
    event = (await db.select().from(events).where(eq(events.originalEventId, input.originalEventId)).limit(1))[0];
  }
  if (!event) throw new Error("Final Weight reconciliation receipt could not be read back.");
  if (event.status === "draft_updated") return { state: "completed" as const, event };
  if (event.recoveryKey !== recoveryKey || event.status !== "previewed") return { state: "blocked" as const, event };
  const claimed = affected(await db.update(events).set({ status: "reserved", processingToken: token })
    .where(and(eq(events.id, event.id), eq(events.status, "previewed"), isNull(events.processingToken), eq(events.recoveryKey, recoveryKey))));
  if (!claimed) {
    const current = (await db.select().from(events).where(eq(events.id, event.id)).limit(1))[0]!;
    return current.status === "draft_updated" ? { state: "completed" as const, event: current } : { state: "blocked" as const, event: current };
  }
  return { state: "reserved" as const, event: (await db.select().from(events).where(eq(events.id, event.id)).limit(1))[0]! };
}

export async function bindFinalWeightReconciliationPayload(eventId: number, token: string, releaseKey: string, payload: FinancialDraftPayload) {
  const db = await database();
  if (!affected(await db.update(events).set({ releaseKey, authorisedPayload: { hash: financialSha256(payload), payload } })
    .where(and(eq(events.id, eventId), eq(events.status, "reserved"), eq(events.processingToken, token), isNull(events.authorisedPayload))))) {
    throw new Error("Final Weight reconciliation payload can only bind once to its exclusive reservation.");
  }
}

export async function verifyFinalWeightReconciliationWriteAccess(input: { eventId: number; token: string; releaseKey: string; preparedBy: number; payload: FinancialDraftPayload }) {
  const db = await database();
  const policy = await getFinalWeightReleasePolicy();
  if (process.env.FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED !== "true") throw new Error("Final Weight reconciliation release is disabled.");
  const event = await getFinalWeightReconciliationEvent(input.eventId);
  const original = event ? (await db.select().from(adjustmentEvents).where(eq(adjustmentEvents.id, event.originalEventId)).limit(1))[0] : null;
  const authorised = event?.authorisedPayload as { hash?: string } | null;
  if (!event || !original || original.status !== "reconciliation_required" || !/status code 404/i.test(String(original.holdReason ?? "")) ||
    event.status !== "reserved" || event.processingToken !== input.token || event.releaseKey !== input.releaseKey || event.releaseKey !== policy.releaseKey ||
    !authorised || authorised.hash !== financialSha256(input.payload) || input.preparedBy !== policy.approvedBy ||
    input.payload.documentNumber !== event.invoiceNumber || input.payload.expectedXeroDocumentId !== event.xeroInvoiceId ||
    financialSha256({ id: original.id, status: original.status, holdReason: original.holdReason, executionId: original.executionId, originalDraftHash: original.originalDraftHash, expectedDraftHash: original.expectedDraftHash }) !== event.originalEventHash) {
    throw new Error("Final Weight reconciliation requires its original immutable 404 record and a new exact-resource reservation.");
  }
  assertFinalWeightRelease(policy, event.direction);
  const facts = await readFinalWeightFacts(event.dealId, event.direction);
  if (!facts.sourceRefreshedAt || Date.parse(facts.sourceRefreshedAt) < Date.parse(policy.effectiveFrom!) || sourceSnapshotHash({ ...facts, direction: event.direction, rulesVersion: FINAL_WEIGHT_RULES_VERSION }) !== event.sourceSnapshotHash) {
    throw new Error("Final Weight reconciliation source is stale or changed.");
  }
  const xero = await readFinalWeightXeroEvidence(event.invoiceNumber, facts.customerName, event.direction);
  if (financialSha256(xero) !== event.xeroPreflightHash) throw new Error("Final Weight reconciliation Xero evidence changed.");
  const preview = buildFinalWeightAdjustment(facts, event.direction, xero);
  if (!preview.eligible || !preview.originalDraft || !preview.expectedDraft || financialSha256(preview.originalDraft) !== event.originalDraftHash ||
    financialSha256(preview.expectedDraft) !== event.expectedDraftHash || financialSha256(prepareFinalWeightPayload(preview, event.sourceSnapshotHash)) !== financialSha256(input.payload)) {
    throw new Error("Final Weight reconciliation current Draft is no longer the independently approved exact amendment.");
  }
}

export async function consumeFinalWeightReconciliationPayload(input: { eventId: number; token: string }, executionId: number) {
  const db = await database();
  if (!affected(await db.update(events).set({ status: "submitted", submittedAt: new Date(), executionId })
    .where(and(eq(events.id, input.eventId), eq(events.status, "reserved"), eq(events.processingToken, input.token), isNull(events.submittedAt))))) {
    throw new Error("Final Weight reconciliation payload was already consumed or reservation lost.");
  }
}

export async function completeFinalWeightReconciliation(input: { eventId: number; token: string; executionId: number; readbackEvidence: unknown }) {
  const db = await database();
  if (!affected(await db.update(events).set({ status: "draft_updated", executionId: input.executionId, readbackEvidence: input.readbackEvidence, processingToken: null, holdReason: null })
    .where(and(eq(events.id, input.eventId), eq(events.status, "submitted"), eq(events.processingToken, input.token))))) {
    throw new Error("Final Weight reconciliation completion requires manual reconciliation.");
  }
}

export async function holdFinalWeightReconciliation(eventId: number, token: string, reason: string) {
  const db = await database();
  await db.update(events).set({ status: "reconciliation_required", processingToken: null, holdReason: reason.slice(0, 2000) })
    .where(and(eq(events.id, eventId), eq(events.processingToken, token), eq(events.status, "reserved")));
}
