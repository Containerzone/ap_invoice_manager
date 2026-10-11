import { and, desc, eq, isNull, or } from "drizzle-orm";
import { financialFinalWeightAdjustmentEvents as events, type FinancialFinalWeightAdjustmentEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { buildFinalWeightAdjustment, prepareFinalWeightPayload, FINAL_WEIGHT_RULES_HASH, FINAL_WEIGHT_RULES_VERSION, type FinalWeightDirection, type FinalWeightFacts, type FinalWeightPreview, type FinalWeightXeroEvidence } from "./financialFinalWeightAdjustmentRules";
import { readFinalWeightFacts } from "./financialFinalWeightAdjustmentSource";
import { readFinalWeightXeroEvidence } from "./financialReadOnlyXeroService";
import type { FinancialDraftPayload } from "./financialProductionWriter";

const affected = (result: any) => Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
async function database() { const db = await getDb(); if (!db) throw new Error("Final-weight immutable ledger unavailable; migration requires separate review/application."); return db; }
export async function getFinalWeightEvents(limit = 100) { return (await database()).select().from(events).orderBy(desc(events.id)).limit(Math.max(1, Math.min(limit, 200))); }
export async function getFinalWeightEvent(eventId: number): Promise<FinancialFinalWeightAdjustmentEvent | null> { return (await (await database()).select().from(events).where(eq(events.id, eventId)).limit(1))[0] ?? null; }
export async function getFinalWeightClaim(dealId: string, invoiceId: string, invoiceNumber: string) {
  return (await (await database()).select().from(events).where(or(eq(events.claimedDealId, dealId), eq(events.claimedInvoiceId, invoiceId), eq(events.claimedInvoiceNumber, invoiceNumber))).limit(1))[0] ?? null;
}
export type FinalWeightEvidenceReceipt = { facts: FinalWeightFacts; direction: FinalWeightDirection; preview: FinalWeightPreview; xero: FinalWeightXeroEvidence | null; sourceSnapshotHash: string; xeroPreflightHash: string | null; holdReason: string | null };
/** Append-only receipt. Duplicate evidence-key insert is a factual no-op, never a rewrite. */
export async function recordFinalWeightEvidence(input: FinalWeightEvidenceReceipt) {
  const db = await database();
  const values = { evidenceKey: financialSha256(input), direction: input.direction, dealId: input.facts.dealId, dealNumber: input.facts.dealNumber,
    invoiceNumber: input.preview.invoiceNumber, xeroInvoiceId: input.preview.invoiceId,
    sourceRefreshedAt: input.facts.sourceRefreshedAt ? new Date(input.facts.sourceRefreshedAt) : null,
    sourceSnapshotHash: input.sourceSnapshotHash, rulesSnapshotHash: FINAL_WEIGHT_RULES_HASH, xeroPreflightHash: input.xeroPreflightHash,
    sourceSnapshot: input.facts, xeroPreflight: input.xero, originalDraft: input.preview.originalDraft, expectedDraft: input.preview.expectedDraft,
    originalDraftHash: input.preview.originalDraft ? financialSha256(input.preview.originalDraft) : null,
    expectedDraftHash: input.preview.expectedDraft ? financialSha256(input.preview.expectedDraft) : null,
    status: input.holdReason || !input.preview.eligible ? "held" as const : "previewed" as const, holdReason: input.holdReason };
  await db.insert(events).values(values).onDuplicateKeyUpdate({ set: { evidenceKey: values.evidenceKey } });
  const event = (await db.select().from(events).where(eq(events.evidenceKey, values.evidenceKey)).limit(1))[0];
  if (!event) throw new Error("Final-weight immutable receipt could not be read back."); return event;
}
/** Nullable unique claim keys never clear even after failure. Both branches contend for the SAME invoice. */
export async function claimFinalWeightEvent(eventId: number, token: string, sourceHash: string, preflightHash: string) {
  const event = await getFinalWeightEvent(eventId); if (!event?.xeroInvoiceId || !event.invoiceNumber) return false;
  try {
    return affected(await (await database()).update(events).set({ status: "reserved", processingToken: token, claimedDealId: event.dealId, claimedInvoiceId: event.xeroInvoiceId, claimedInvoiceNumber: event.invoiceNumber })
      .where(and(eq(events.id, eventId), eq(events.status, "previewed"), isNull(events.processingToken), isNull(events.claimedInvoiceId), eq(events.sourceSnapshotHash, sourceHash), eq(events.xeroPreflightHash, preflightHash))));
  } catch (error) { if ((error as any)?.code === "ER_DUP_ENTRY") return false; throw error; }
}
export async function bindFinalWeightPayload(eventId: number, token: string, releaseKey: string, payload: FinancialDraftPayload) {
  if (!affected(await (await database()).update(events).set({ releaseKey, authorisedPayload: { hash: financialSha256(payload), payload } })
    .where(and(eq(events.id, eventId), eq(events.status, "reserved"), eq(events.processingToken, token), isNull(events.authorisedPayload))))) throw new Error("Final-weight exact payload binds once only to an exclusive reservation.");
}
export type FinalWeightWriteAccess = { eventId: number; direction: FinalWeightDirection; releaseKey: string; preparedBy: number; payload: FinancialDraftPayload };
export function assertFinalWeightLedgerIntegrity(event: FinancialFinalWeightAdjustmentEvent | null, input: FinalWeightWriteAccess, policy: Awaited<ReturnType<typeof getFinalWeightReleasePolicy>>) {
  const auth = event?.authorisedPayload as { hash?: string; payload?: FinancialDraftPayload } | null;
  if (!event || event.status !== "reserved" || !event.processingToken || event.direction !== input.direction || event.claimedDealId !== event.dealId || event.claimedInvoiceId !== event.xeroInvoiceId || event.claimedInvoiceNumber !== event.invoiceNumber ||
    input.releaseKey !== policy.releaseKey || event.releaseKey !== policy.releaseKey || input.preparedBy !== policy.approvedBy || event.rulesSnapshotHash !== FINAL_WEIGHT_RULES_HASH ||
    !auth || auth.hash !== financialSha256(input.payload) || auth.hash !== financialSha256(auth.payload) || !event.sourceSnapshot ||
    sourceSnapshotHash({ ...(event.sourceSnapshot as object), direction: event.direction, rulesVersion: FINAL_WEIGHT_RULES_VERSION }) !== event.sourceSnapshotHash ||
    !event.xeroPreflightHash || financialSha256(event.xeroPreflight) !== event.xeroPreflightHash || !event.originalDraftHash || financialSha256(event.originalDraft) !== event.originalDraftHash ||
    !event.expectedDraftHash || financialSha256(event.expectedDraft) !== event.expectedDraftHash || input.payload.documentNumber !== event.invoiceNumber || input.payload.expectedXeroDocumentId !== event.xeroInvoiceId) throw new Error("Final-weight requires an intact immutable exact-payload reservation, direction and exclusive document claim.");
}
export async function verifyFinalWeightAutomaticWriteAccess(input: FinalWeightWriteAccess) {
  const policy = await getFinalWeightReleasePolicy(); assertFinalWeightRelease(policy, input.direction);
  const event = await getFinalWeightEvent(input.eventId); assertFinalWeightLedgerIntegrity(event, input, policy);
  const facts = await readFinalWeightFacts(event!.dealId, input.direction);
  if (sourceSnapshotHash({ ...facts, direction: input.direction, rulesVersion: FINAL_WEIGHT_RULES_VERSION }) !== event!.sourceSnapshotHash || !facts.sourceRefreshedAt || Date.parse(facts.sourceRefreshedAt) < Date.parse(policy.effectiveFrom!)) throw new Error("Current final-weight Deal changed or predates new-events-only cutover.");
  const xero = await readFinalWeightXeroEvidence(event!.invoiceNumber!, facts.customerName, input.direction);
  if (financialSha256(xero) !== event!.xeroPreflightHash) throw new Error("Exact Draft/contact/full-line Xero evidence changed since reservation; reconciliation required.");
  const preview = buildFinalWeightAdjustment(facts, input.direction, xero);
  if (!preview.eligible || financialSha256(preview.originalDraft) !== event!.originalDraftHash || financialSha256(preview.expectedDraft) !== event!.expectedDraftHash || financialSha256(prepareFinalWeightPayload(preview, event!.sourceSnapshotHash)) !== financialSha256(input.payload)) throw new Error("Final-weight allowed SER70/due-date variation differs from independently rebuilt exact evidence.");
}
/** Atomic one-shot consume immediately before transport: submitted cannot be re-authorised or retried. */
export async function consumeFinalWeightPayload(input: FinalWeightWriteAccess, executionId: number) {
  const policy = await getFinalWeightReleasePolicy();
  assertFinalWeightRelease(policy, input.direction);
  const event = await getFinalWeightEvent(input.eventId);
  assertFinalWeightLedgerIntegrity(event, input, policy);
  if (!event?.processingToken || !affected(await (await database()).update(events).set({ status: "submitted", submittedAt: new Date(), executionId })
    .where(and(eq(events.id, input.eventId), eq(events.status, "reserved"), eq(events.processingToken, event.processingToken), isNull(events.submittedAt))))) throw new Error("Final-weight one-time payload was already consumed or reservation lost; no transport.");
}
export async function completeFinalWeightEvent(eventId: number, token: string, executionId: number, readbackEvidence: unknown) {
  if (!affected(await (await database()).update(events).set({ status: "draft_updated", executionId, readbackEvidence, holdReason: null, processingToken: null })
    .where(and(eq(events.id, eventId), eq(events.status, "submitted"), eq(events.processingToken, token))))) throw new Error("Final-weight completion requires reconciliation; submitted reservation lost.");
}
export async function holdFinalWeightEvent(eventId: number, token: string, reason: string) {
  await (await database()).update(events).set({ status: "reconciliation_required", holdReason: reason.slice(0, 2000), processingToken: null })
    .where(and(eq(events.id, eventId), eq(events.processingToken, token), or(eq(events.status, "reserved"), eq(events.status, "submitted"))));
}
