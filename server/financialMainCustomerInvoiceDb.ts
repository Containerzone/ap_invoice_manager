import { and, desc, eq, isNull } from "drizzle-orm";
import { financialMainCustomerInvoiceEvents, type FinancialMainCustomerInvoiceEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { assertMainCustomerInvoiceRelease, getMainCustomerInvoiceReleasePolicy } from "./financialMainCustomerInvoiceRelease";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import { financialSha256 } from "./financialProposalIntegrity";

export function mainCustomerInvoicePayloadHash(payload: FinancialDraftPayload): string {
  return financialSha256(payload);
}

function jsonHash(value: unknown): string {
  return financialSha256(value);
}

function dateOnly(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

/** Reconstructs the exact Main Invoice wire body only from the stored current preflight proposal. */
function mainCustomerInvoiceProposalBody(value: unknown): Record<string, unknown> | null {
  const document = value as Partial<ProposedFinancialDocument> | null;
  if (!document || document.documentFamily !== "customer_invoice" || document.documentType !== "main_customer_invoice" ||
    document.proposedAction !== "create_draft" || !document.proposedDocumentNumber?.trim() || !document.partySourceId?.trim() ||
    !Array.isArray(document.lineItems) || document.lineItems.length < 1 || !dateOnly(document.issueDate) ||
    !["GST_EXCLUSIVE", "GST_INCLUSIVE"].includes(String(document.gstTreatment))) return null;
  return {
    Invoices: [{
      InvoiceID: undefined,
      Type: "ACCREC",
      InvoiceNumber: document.proposedDocumentNumber.trim(),
      ...(document.reference?.trim() ? { Reference: document.reference.trim() } : {}),
      Contact: { ContactID: document.partySourceId.trim() },
      Status: "DRAFT",
      Date: dateOnly(document.issueDate),
      DueDate: dateOnly(document.dueDate),
      LineAmountTypes: document.gstTreatment === "GST_INCLUSIVE" ? "Inclusive" : "Exclusive",
      CurrencyCode: "AUD",
      LineItems: document.lineItems.map((line) => ({
        ItemCode: line.itemCode || undefined,
        Description: line.description,
        Quantity: line.quantity,
        UnitAmount: line.unitAmount,
        AccountCode: line.accountCode || document.accountCode || undefined,
        TaxType: "OUTPUT",
      })),
    }],
  };
}

function affected(result: any): boolean {
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
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
  return affected(result);
}

/**
 * Binds only one exact wire payload to the atomic claim. The body must be the
 * one reconstructed from the previewed proposal; a caller cannot replace it
 * with another valid-looking Main Invoice after claiming the event.
 */
export async function bindMainCustomerInvoicePayload(input: {
  eventId: number;
  token: string;
  releaseKey: string;
  payload: FinancialDraftPayload;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  const event = (await db.select().from(financialMainCustomerInvoiceEvents)
    .where(eq(financialMainCustomerInvoiceEvents.id, input.eventId)).limit(1))[0];
  const expectedBody = mainCustomerInvoiceProposalBody(event?.proposal);
  if (!event || !expectedBody || input.payload.method !== "POST" || input.payload.endpoint !== "/Invoices" ||
    input.payload.documentFamily !== "customer_invoice" || input.payload.expectedXeroDocumentId ||
    input.payload.documentNumber !== event.proposedInvoiceNumber || jsonHash(input.payload.body) !== jsonHash(expectedBody)) {
    throw new Error("Main Customer Invoice payload does not match its immutable current preflight proposal.");
  }
  const result: any = await db.update(financialMainCustomerInvoiceEvents).set({
    releaseKey: input.releaseKey,
    authorisedPayload: {
      hash: mainCustomerInvoicePayloadHash(input.payload),
      number: input.payload.documentNumber,
      bodyHash: jsonHash(input.payload.body),
      sourceSnapshotHash: event.sourceSnapshotHash,
      xeroPreflightHash: event.xeroPreflightHash,
    },
  }).where(and(
    eq(financialMainCustomerInvoiceEvents.id, input.eventId),
    eq(financialMainCustomerInvoiceEvents.status, "reserved"),
    eq(financialMainCustomerInvoiceEvents.processingToken, input.token),
    isNull(financialMainCustomerInvoiceEvents.releaseKey),
    isNull(financialMainCustomerInvoiceEvents.authorisedPayload),
  ));
  if (!affected(result)) throw new Error("Main Customer Invoice payload could not be bound to its exclusive current preflight reservation.");
}

/** Checks the stored release, exclusive claim and exact preflight body immediately before POST. */
export async function verifyMainCustomerInvoiceAutomaticWriteAccess(input: {
  eventId: number;
  token: string;
  releaseKey: string;
  payload: FinancialDraftPayload;
  preparedBy: number;
}): Promise<void> {
  const policy = await getMainCustomerInvoiceReleasePolicy();
  assertMainCustomerInvoiceRelease(policy);
  const db = await getDb();
  if (!db) throw new Error("AP Main Customer Invoice lifecycle ledger is unavailable.");
  const event = (await db.select().from(financialMainCustomerInvoiceEvents).where(eq(financialMainCustomerInvoiceEvents.id, input.eventId)).limit(1))[0];
  const auth = event?.authorisedPayload as { hash?: string; number?: string; bodyHash?: string; sourceSnapshotHash?: string; xeroPreflightHash?: string } | null;
  const expectedBody = mainCustomerInvoiceProposalBody(event?.proposal);
  if (!event || event.status !== "reserved" || !event.processingToken || event.processingToken !== input.token || event.releaseKey !== policy.releaseKey || input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy || !auth || auth.hash !== mainCustomerInvoicePayloadHash(input.payload) || auth.number !== input.payload.documentNumber ||
    auth.bodyHash !== jsonHash(input.payload.body) || !expectedBody || auth.bodyHash !== jsonHash(expectedBody) ||
    auth.sourceSnapshotHash !== event.sourceSnapshotHash || auth.xeroPreflightHash !== event.xeroPreflightHash ||
    input.payload.documentNumber !== event.proposedInvoiceNumber) {
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
