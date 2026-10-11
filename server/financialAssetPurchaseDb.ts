import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { financialAssetPurchasePoEvents, type FinancialAssetPurchasePoEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { assertAssetPurchaseRelease, getAssetPurchaseReleasePolicy } from "./financialAssetPurchaseRelease";
import type { FinancialDraftPayload } from "./financialProductionWriter";

export function assetPurchasePayloadHash(payload: FinancialDraftPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function getAssetPurchasePoEvents(limit = 100): Promise<FinancialAssetPurchasePoEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialAssetPurchasePoEvents)
    .orderBy(desc(financialAssetPurchasePoEvents.updatedAt), desc(financialAssetPurchasePoEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}

export async function getAssetPurchaseEvent(containerControlId: string): Promise<FinancialAssetPurchasePoEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("AP Asset purchase lifecycle ledger is unavailable.");
  return (await db.select().from(financialAssetPurchasePoEvents)
    .where(eq(financialAssetPurchasePoEvents.containerControlId, containerControlId)).limit(1))[0] ?? null;
}

/** Persists a GET-only current source/Xero preview. Terminal write states cannot be replaced. */
export async function recordAssetPurchasePreview(input: {
  containerControlId: string;
  containerControlNumber: string;
  proposedPoNumber: string;
  containerNumber: string;
  containerType: string;
  supplierVtigerId: string | null;
  supplierName: string | null;
  purchaseDate: string | null;
  sourceRefreshedAt: Date | null;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  proposal: unknown;
  xeroPreflight: unknown;
  status: "previewed" | "held";
  holdReason: string | null;
}): Promise<FinancialAssetPurchasePoEvent> {
  const db = await getDb();
  if (!db) throw new Error("AP Asset purchase lifecycle ledger is unavailable.");
  const existing = await getAssetPurchaseEvent(input.containerControlId);
  if (existing && ["reserved", "drafts_created", "reconciliation_required"].includes(existing.status)) return existing;
  const values = { ...input, proposal: input.proposal as any, xeroPreflight: input.xeroPreflight as any };
  await db.insert(financialAssetPurchasePoEvents).values(values).onDuplicateKeyUpdate({ set: { ...values, updatedAt: new Date() } });
  const saved = await getAssetPurchaseEvent(input.containerControlId);
  if (!saved) throw new Error("Asset purchase preview receipt could not be read back from the AP ledger.");
  return saved;
}

/** Claims an exact fresh preview; VTiger/browser inputs cannot form this lock. */
export async function claimAssetPurchasePreview(eventId: number, token: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("AP Asset purchase lifecycle ledger is unavailable.");
  const result: any = await db.update(financialAssetPurchasePoEvents)
    .set({ status: "reserved", processingToken: token, holdReason: null })
    .where(and(eq(financialAssetPurchasePoEvents.id, eventId), eq(financialAssetPurchasePoEvents.status, "previewed"), isNull(financialAssetPurchasePoEvents.processingToken)));
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}

export async function bindAssetPurchasePayload(eventId: number, releaseKey: string, payload: FinancialDraftPayload): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP Asset purchase lifecycle ledger is unavailable.");
  await db.update(financialAssetPurchasePoEvents).set({
    releaseKey,
    authorisedPayload: {
      hash: assetPurchasePayloadHash(payload),
      number: payload.documentNumber,
      bodyHash: createHash("sha256").update(JSON.stringify(payload.body)).digest("hex"),
    },
  }).where(eq(financialAssetPurchasePoEvents.id, eventId));
}

/** Re-checks release, exclusive claim and immutable payload immediately before Xero transport. */
export async function verifyAssetPurchaseAutomaticWriteAccess(input: {
  eventId: number;
  releaseKey: string;
  payload: FinancialDraftPayload;
  preparedBy: number;
}): Promise<void> {
  const policy = await getAssetPurchaseReleasePolicy();
  assertAssetPurchaseRelease(policy);
  const db = await getDb();
  if (!db) throw new Error("AP Asset purchase lifecycle ledger is unavailable.");
  const event = (await db.select().from(financialAssetPurchasePoEvents).where(eq(financialAssetPurchasePoEvents.id, input.eventId)).limit(1))[0];
  const auth = event?.authorisedPayload as { hash?: string; number?: string } | null;
  if (!event || event.status !== "reserved" || !event.processingToken || event.releaseKey !== policy.releaseKey || input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy || !auth || auth.hash !== assetPurchasePayloadHash(input.payload) || auth.number !== input.payload.documentNumber) {
    throw new Error("Asset purchase event has no current release-backed, exact-payload reservation.");
  }
  if (input.payload.method !== "POST" || input.payload.documentFamily !== "purchase_order" || input.payload.expectedXeroDocumentId) {
    throw new Error("Asset automatic release permits only a new Draft Purchase Order POST.");
  }
}

export async function completeAssetPurchaseDraft(input: { eventId: number; executionId: number; xeroPurchaseOrderId: string }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP Asset purchase lifecycle ledger is unavailable.");
  await db.update(financialAssetPurchasePoEvents).set({
    status: "drafts_created",
    executionId: input.executionId,
    xeroPurchaseOrderId: input.xeroPurchaseOrderId,
    processingToken: null,
    holdReason: null,
    updatedAt: new Date(),
  }).where(eq(financialAssetPurchasePoEvents.id, input.eventId));
}

export async function holdAssetPurchaseExecution(eventId: number, reason: string, uncertain = false): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP Asset purchase lifecycle ledger is unavailable.");
  await db.update(financialAssetPurchasePoEvents).set({
    status: uncertain ? "reconciliation_required" : "held",
    processingToken: null,
    holdReason: reason.slice(0, 2000),
    updatedAt: new Date(),
  }).where(eq(financialAssetPurchasePoEvents.id, eventId));
}
