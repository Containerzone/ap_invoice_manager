import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { financialMainCustomerInvoiceEvents, type FinancialMainCustomerInvoiceEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { assertMainCustomerInvoiceRelease, getMainCustomerInvoiceReleasePolicy } from "./financialMainCustomerInvoiceRelease";
import type { FinancialDraftPayload } from "./financialProductionWriter";

export function mainCustomerInvoicePayloadHash(payload: FinancialDraftPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function getMainCustomerInvoiceEvents(limit = 100): Promise<FinancialMainCustomerInvoiceEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialMainCustomerInvoiceEvents)
    .orderBy(desc(financialMainCustomerInvoiceEvents.updatedAt), desc(financialMainCustomerInvoiceEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}

export async function getMainCustomerInvoiceEvent(dealId: string): Promise<FinancialMainCustomerInvoiceEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  return (await db.select().from(financialMainCustomerInvoiceEvents)
    .where(eq(financialMainCustomerInvoiceEvents.dealId, dealId)).limit(1))[0] ?? null;
}

/** Saves GET-only source/preflight evidence; completed or uncertain states are immutable. */
export async function recordMainCustomerInvoicePreview(input: {
  dealId: string;
  dealNumber: string;
  quoteId: string | null;
  quoteNumber: string | null;
  proposedInvoiceNumber: string;
  customerVtigerId: string | null;
  customerName: string | null;
  sourceRefreshedAt: Date | null;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  proposal: unknown;
  xeroPreflight: unknown;
  status: "previewed" | "held";
  holdReason: string | null;
}): Promise<FinancialMainCustomerInvoiceEvent> {
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  const existing = await getMainCustomerInvoiceEvent(input.dealId);
  if (existing && ["reserved", "drafts_created", "reconciliation_required"].includes(existing.status)) return existing;
  const values = { ...input, proposal: input.proposal as any, xeroPreflight: input.xeroPreflight as any };
  await db.insert(financialMainCustomerInvoiceEvents).values(values).onDuplicateKeyUpdate({ set: { ...values, updatedAt: new Date() } });
  const saved = await getMainCustomerInvoiceEvent(input.dealId);
  if (!saved) throw new Error("Main Customer Invoice evidence receipt could not be read back from the AP ledger.");
  return saved;
}

export async function claimMainCustomerInvoicePreview(eventId: number, token: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  const result: any = await db.update(financialMainCustomerInvoiceEvents)
    .set({ status: "reserved", processingToken: token, holdReason: null })
    .where(and(eq(financialMainCustomerInvoiceEvents.id, eventId), eq(financialMainCustomerInvoiceEvents.status, "previewed"), isNull(financialMainCustomerInvoiceEvents.processingToken)));
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}

export async function bindMainCustomerInvoicePayload(eventId: number, releaseKey: string, payload: FinancialDraftPayload): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  await db.update(financialMainCustomerInvoiceEvents).set({
    releaseKey,
    authorisedPayload: {
      hash: mainCustomerInvoicePayloadHash(payload),
      number: payload.documentNumber,
      bodyHash: createHash("sha256").update(JSON.stringify(payload.body)).digest("hex"),
    },
  }).where(eq(financialMainCustomerInvoiceEvents.id, eventId));
}

/** Checks the stored release, exclusive claim and payload immediately before POST. */
export async function verifyMainCustomerInvoiceAutomaticWriteAccess(input: {
  eventId: number;
  releaseKey: string;
  payload: FinancialDraftPayload;
  preparedBy: number;
}): Promise<void> {
  const policy = await getMainCustomerInvoiceReleasePolicy();
  assertMainCustomerInvoiceRelease(policy);
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  const event = (await db.select().from(financialMainCustomerInvoiceEvents).where(eq(financialMainCustomerInvoiceEvents.id, input.eventId)).limit(1))[0];
  const auth = event?.authorisedPayload as { hash?: string; number?: string } | null;
  if (!event || event.status !== "reserved" || !event.processingToken || event.releaseKey !== policy.releaseKey || input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy || !auth || auth.hash !== mainCustomerInvoicePayloadHash(input.payload) || auth.number !== input.payload.documentNumber) {
    throw new Error("Main Customer Invoice event has no current release-backed exact-payload reservation.");
  }
  if (input.payload.method !== "POST" || input.payload.documentFamily !== "customer_invoice" || input.payload.expectedXeroDocumentId) {
    throw new Error("Main Customer Invoice automatic release permits only a new Draft customer-invoice POST.");
  }
}

export async function completeMainCustomerInvoiceDraft(input: { eventId: number; executionId: number; xeroInvoiceId: string }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  await db.update(financialMainCustomerInvoiceEvents).set({
    status: "drafts_created", executionId: input.executionId, xeroInvoiceId: input.xeroInvoiceId,
    processingToken: null, holdReason: null, updatedAt: new Date(),
  }).where(eq(financialMainCustomerInvoiceEvents.id, input.eventId));
}

export async function holdMainCustomerInvoiceExecution(eventId: number, reason: string, uncertain = false): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  await db.update(financialMainCustomerInvoiceEvents).set({
    status: uncertain ? "reconciliation_required" : "held", processingToken: null,
    holdReason: reason.slice(0, 2000), updatedAt: new Date(),
  }).where(eq(financialMainCustomerInvoiceEvents.id, eventId));
}
