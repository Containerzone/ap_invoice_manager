import { and, eq, isNull, or } from "drizzle-orm";
import {
  financialDepositInvoiceEvents as depositEvents,
  financialDepositInvoiceReconciliationEvents as recoveryEvents,
  type FinancialDepositInvoiceEvent,
  type FinancialDepositInvoiceReconciliationEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { assertDepositInvoiceRelease, getDepositInvoiceReleasePolicy } from "./financialDepositInvoiceRelease";
import {
  DEPOSIT_INVOICE_RULES_HASH,
  DEPOSIT_INVOICE_RULES_VERSION,
  buildDepositInvoice,
  type DepositInvoiceFacts,
} from "./financialDepositInvoiceDrafts";
import { readDepositInvoiceFacts } from "./financialDepositInvoiceSource";
import { depositInvoicePayloadHash, depositPreflightHold } from "./financialDepositInvoiceDb";
import {
  preflightFinancialXeroIntents,
  readDepositInvoiceXeroItemConfiguration,
} from "./financialReadOnlyXeroService";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";
import { previewCustomerContactResolution } from "./financialCustomerContactServiceV2";

/**
 * This is deliberately a runtime allow-list, rather than a query convention.
 * The recovery API accepts an original event ID so its design remains auditable
 * and reusable, but this release authorises exactly one historic receipt.
 */
export const DEPOSIT_INVOICE_RECONCILIATION_SCOPE = {
  originalEventId: 180001,
  dealNumber: "D702941",
  invoiceNumber: "INV-702941-D",
} as const;

const affected = (result: any) =>
  Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Deposit Invoice reconciliation audit ledger is unavailable.");
  return db;
}

export type DepositInvoiceReconciliationEvidence = {
  originalEventId: number;
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  originalEventHash: string;
  sourceSnapshotHash: string;
  xeroPreflightHash: string;
  sourceSnapshot: Record<string, unknown>;
  proposal: Record<string, unknown>;
  xeroPreflight: Record<string, unknown>;
};

/** All original factual columns are included: any legacy-record alteration blocks recovery. */
export function depositInvoiceReconciliationOriginalHash(event: FinancialDepositInvoiceEvent): string {
  return financialSha256({
    id: event.id,
    evidenceKey: event.evidenceKey,
    dealId: event.dealId,
    dealNumber: event.dealNumber,
    proposedInvoiceNumber: event.proposedInvoiceNumber,
    customerVtigerId: event.customerVtigerId,
    customerName: event.customerName,
    sourceRefreshedAt: event.sourceRefreshedAt?.toISOString() ?? null,
    sourceSnapshotHash: event.sourceSnapshotHash,
    rulesSnapshotHash: event.rulesSnapshotHash,
    xeroPreflightHash: event.xeroPreflightHash,
    sourceSnapshot: event.sourceSnapshot,
    proposal: event.proposal,
    xeroPreflight: event.xeroPreflight,
    postconditionHold: event.postconditionHold,
    claimedDealId: event.claimedDealId,
    claimedInvoiceNumber: event.claimedInvoiceNumber,
    releaseKey: event.releaseKey,
    authorisedPayload: event.authorisedPayload,
    processingToken: event.processingToken,
    status: event.status,
    holdReason: event.holdReason,
    executionId: event.executionId,
    xeroInvoiceId: event.xeroInvoiceId,
  });
}

/**
 * Original Deposit claims are never released, replayed or written. A recovery
 * is possible only for the one named historical receipt that was left in a
 * reconciliation state before an Xero execution or invoice identifier existed.
 */
export function assertDepositInvoiceReconciliationOriginal(
  original: FinancialDepositInvoiceEvent | null,
  originalEventId: number,
): asserts original is FinancialDepositInvoiceEvent {
  if (
    originalEventId !== DEPOSIT_INVOICE_RECONCILIATION_SCOPE.originalEventId ||
    !original ||
    original.id !== originalEventId ||
    original.status !== "reconciliation_required" ||
    original.dealNumber.toUpperCase() !== DEPOSIT_INVOICE_RECONCILIATION_SCOPE.dealNumber ||
    original.proposedInvoiceNumber.toUpperCase() !== DEPOSIT_INVOICE_RECONCILIATION_SCOPE.invoiceNumber ||
    original.xeroInvoiceId !== null ||
    original.executionId !== null ||
    original.processingToken !== null ||
    original.claimedDealId !== original.dealId ||
    original.claimedInvoiceNumber?.toUpperCase() !== original.proposedInvoiceNumber.toUpperCase()
  ) {
    throw new Error("Only the immutable scoped Deposit reconciliation receipt without Xero execution may be considered for recovery.");
  }
}

export async function getDepositInvoiceReconciliationEvent(
  id: number,
): Promise<FinancialDepositInvoiceReconciliationEvent | null> {
  return (await (await database()).select().from(recoveryEvents).where(eq(recoveryEvents.id, id)).limit(1))[0] ?? null;
}

export async function getDepositInvoiceReconciliationOriginal(
  originalEventId: number,
): Promise<FinancialDepositInvoiceEvent | null> {
  return (await (await database()).select().from(depositEvents).where(eq(depositEvents.id, originalEventId)).limit(1))[0] ?? null;
}

/** Reserves a new independent receipt. It never touches the original Deposit event or claim keys. */
export async function reserveDepositInvoiceReconciliation(
  input: DepositInvoiceReconciliationEvidence & { token: string },
) {
  const db = await database();
  const { token, ...evidence } = input;
  const recoveryKey = financialSha256(evidence);
  let event = (await db.select().from(recoveryEvents)
    .where(eq(recoveryEvents.originalEventId, input.originalEventId)).limit(1))[0];
  if (!event) {
    try {
      await db.insert(recoveryEvents).values({
        ...evidence,
        recoveryKey,
        status: "previewed",
        processingToken: null,
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
    event = (await db.select().from(recoveryEvents)
      .where(eq(recoveryEvents.originalEventId, input.originalEventId)).limit(1))[0];
  }
  if (!event) throw new Error("Deposit reconciliation receipt could not be read back.");
  if (event.status === "drafts_created") return { state: "completed" as const, event };
  if (event.recoveryKey !== recoveryKey || event.status !== "previewed") return { state: "blocked" as const, event };
  const claimed = affected(await db.update(recoveryEvents).set({ status: "reserved", processingToken: token })
    .where(and(
      eq(recoveryEvents.id, event.id),
      eq(recoveryEvents.status, "previewed"),
      isNull(recoveryEvents.processingToken),
      eq(recoveryEvents.recoveryKey, recoveryKey),
    )));
  if (!claimed) {
    const current = (await db.select().from(recoveryEvents).where(eq(recoveryEvents.id, event.id)).limit(1))[0]!;
    return current.status === "drafts_created" ? { state: "completed" as const, event: current } : { state: "blocked" as const, event: current };
  }
  return {
    state: "reserved" as const,
    event: (await db.select().from(recoveryEvents).where(eq(recoveryEvents.id, event.id)).limit(1))[0]!,
  };
}

/** The payload is immutable and can bind only once to its exclusive recovery reservation. */
export async function bindDepositInvoiceReconciliationPayload(
  eventId: number,
  token: string,
  releaseKey: string,
  payload: FinancialDraftPayload,
): Promise<void> {
  if (!affected(await (await database()).update(recoveryEvents).set({
    releaseKey,
    authorisedPayload: { hash: depositInvoicePayloadHash(payload), number: payload.documentNumber, payload },
  }).where(and(
    eq(recoveryEvents.id, eventId),
    eq(recoveryEvents.status, "reserved"),
    eq(recoveryEvents.processingToken, token),
    isNull(recoveryEvents.authorisedPayload),
  )))) {
    throw new Error("Deposit reconciliation payload can only bind once to its exclusive reservation.");
  }
}

function storedContactId(event: FinancialDepositInvoiceReconciliationEvent): string | null {
  const proposal = event.proposal as { partySourceId?: unknown } | null;
  const id = typeof proposal?.partySourceId === "string" ? proposal.partySourceId.trim() : "";
  return id || null;
}

function sameV2Source(input: {
  facts: DepositInvoiceFacts;
  source: Awaited<ReturnType<typeof readCurrentCustomerContactResolution>>;
}): boolean {
  const { facts, source } = input;
  return source.dealId === facts.dealId &&
    source.customerVtigerId === facts.customerVtigerId &&
    source.name === facts.customerName &&
    (source.billingKind === "organisation" ? "organisation" : "contact") === facts.customerKind &&
    source.resolvedAt === facts.customerRefreshedAt &&
    facts.mappingEvidence.customerIdentityV2SourceSnapshotHash === source.sourceSnapshotHash;
}

export function prepareDepositInvoiceReconciliationPayload(
  proposal: Record<string, any>,
  originalEventId: number,
  sourceHash: string,
): FinancialDraftPayload {
  const payload = prepareFinancialDraftPayload(
    proposal as any,
    `${proposal.dealId ?? "deposit"}:deposit_invoice_reconciliation:${originalEventId}:${sourceHash}`,
  );
  (payload.body.Invoices as Record<string, unknown>[])[0]!.CurrencyCode = "AUD";
  return payload;
}

/**
 * Rebuilds current source, exact not-found Xero evidence and the Draft POST before
 * transport. It reads the original receipt only; it never invokes generic claim
 * lookup/claim functions, so the original legacy claim intentionally stays put.
 */
export async function verifyDepositInvoiceReconciliationWriteAccess(input: {
  eventId: number;
  token: string;
  releaseKey: string;
  preparedBy: number;
  payload: FinancialDraftPayload;
}): Promise<void> {
  if (process.env.FINANCIAL_DEPOSIT_INVOICE_RECONCILIATION_ENABLED !== "true") {
    throw new Error("Deposit Invoice reconciliation release is disabled.");
  }
  const policy = await getDepositInvoiceReleasePolicy();
  assertDepositInvoiceRelease(policy);
  const event = await getDepositInvoiceReconciliationEvent(input.eventId);
  const original = event
    ? await getDepositInvoiceReconciliationOriginal(event.originalEventId)
    : null;
  const authorised = event?.authorisedPayload as { hash?: string; number?: string } | null;
  if (
    !event ||
    event.originalEventId !== DEPOSIT_INVOICE_RECONCILIATION_SCOPE.originalEventId ||
    event.dealNumber.toUpperCase() !== DEPOSIT_INVOICE_RECONCILIATION_SCOPE.dealNumber ||
    event.invoiceNumber.toUpperCase() !== DEPOSIT_INVOICE_RECONCILIATION_SCOPE.invoiceNumber ||
    event.status !== "reserved" ||
    event.processingToken !== input.token ||
    event.releaseKey !== input.releaseKey ||
    event.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy ||
    !authorised ||
    authorised.hash !== depositInvoicePayloadHash(input.payload) ||
    authorised.number !== event.invoiceNumber ||
    input.payload.documentNumber !== event.invoiceNumber ||
    input.payload.method !== "POST" ||
    input.payload.endpoint !== "/Invoices" ||
    input.payload.documentFamily !== "customer_invoice" ||
    input.payload.expectedXeroDocumentId !== null
  ) {
    throw new Error("Deposit reconciliation requires its separate one-time exact-payload reservation.");
  }
  assertDepositInvoiceReconciliationOriginal(original, event.originalEventId);
  if (depositInvoiceReconciliationOriginalHash(original) !== event.originalEventHash) {
    throw new Error("Deposit reconciliation original immutable receipt changed.");
  }
  const facts = await readDepositInvoiceFacts(event.dealId);
  if (sourceSnapshotHash({ ...facts, rulesVersion: DEPOSIT_INVOICE_RULES_VERSION }) !== event.sourceSnapshotHash) {
    throw new Error("Current Deposit reconciliation source changed.");
  }
  const storedProposal = event.proposal as Record<string, any> | null;
  const issueDate = storedProposal?.issueDate ? new Date(storedProposal.issueDate) : null;
  if (!issueDate || !Number.isFinite(issueDate.getTime())) {
    throw new Error("Deposit reconciliation proposal is missing its immutable issue date.");
  }
  const preview = buildDepositInvoice(facts, issueDate);
  if (!preview.eligible || !preview.document || preview.proposedInvoiceNumber !== event.invoiceNumber) {
    throw new Error(preview.holdReason ?? "Current Deposit reconciliation source is held.");
  }
  const contactId = storedContactId(event);
  if (!contactId) throw new Error("Deposit reconciliation reservation is missing its exact Xero ContactID.");
  if (process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED === "true") {
    const currentSource = await readCurrentCustomerContactResolution(event.dealId);
    if (!sameV2Source({ facts, source: currentSource })) {
      throw new Error("Current Deposit reconciliation billing identity metadata changed after reservation.");
    }
    const currentPlan = await previewCustomerContactResolution(currentSource);
    if (currentPlan.status !== "matched" || currentPlan.contactId !== contactId) {
      throw new Error("Current Deposit reconciliation customer match no longer resolves to the reserved exact Xero ContactID.");
    }
  }
  preview.document.partySourceId = contactId;
  const [preflight] = await preflightFinancialXeroIntents([preview.document]);
  const reason = depositPreflightHold(event.invoiceNumber, facts.customerName, preflight ?? null);
  if (reason || !preflight) throw new Error(reason ?? "Deposit reconciliation GET-only preflight is missing.");
  if (financialSha256(preflight) !== event.xeroPreflightHash) {
    throw new Error("Deposit reconciliation Xero evidence changed since reservation.");
  }
  if (preflight.contactCheck.contactId !== contactId) {
    throw new Error("Current Deposit reconciliation Xero ContactID differs from the reserved exact customer.");
  }
  const item = await readDepositInvoiceXeroItemConfiguration();
  preview.document.accountCode = item.accountCode;
  preview.document.lineItems[0]!.accountCode = item.accountCode;
  if (financialSha256(preview.document) !== financialSha256(event.proposal)) {
    throw new Error("Deposit reconciliation proposal no longer matches immutable current evidence.");
  }
  const expected = prepareDepositInvoiceReconciliationPayload(
    preview.document as unknown as Record<string, any>,
    event.originalEventId,
    event.sourceSnapshotHash,
  );
  if (depositInvoicePayloadHash(expected) !== authorised.hash) {
    throw new Error("Deposit reconciliation payload does not match current independently rebuilt evidence.");
  }
}

/** Consumes the recovery receipt before Xero authentication; it can never be replayed. */
export async function consumeDepositInvoiceReconciliationPayload(
  input: { eventId: number; token: string },
  executionId: number,
): Promise<void> {
  if (!affected(await (await database()).update(recoveryEvents).set({
    status: "submitted",
    submittedAt: new Date(),
    executionId,
  }).where(and(
    eq(recoveryEvents.id, input.eventId),
    eq(recoveryEvents.status, "reserved"),
    eq(recoveryEvents.processingToken, input.token),
    isNull(recoveryEvents.submittedAt),
  )))) {
    throw new Error("Deposit reconciliation payload was already consumed or reservation lost.");
  }
}

export async function completeDepositInvoiceReconciliation(input: {
  eventId: number;
  token: string;
  executionId: number;
  readbackEvidence: unknown;
}): Promise<void> {
  if (!affected(await (await database()).update(recoveryEvents).set({
    status: "drafts_created",
    executionId: input.executionId,
    readbackEvidence: input.readbackEvidence,
    processingToken: null,
    holdReason: null,
  }).where(and(
    eq(recoveryEvents.id, input.eventId),
    eq(recoveryEvents.status, "submitted"),
    eq(recoveryEvents.processingToken, input.token),
  )))) {
    throw new Error("Deposit reconciliation completion requires manual reconciliation.");
  }
}

/** Preserve the consumed recovery receipt, whether failure happened before or after submission. */
export async function holdDepositInvoiceReconciliation(
  eventId: number,
  token: string,
  reason: string,
): Promise<void> {
  await (await database()).update(recoveryEvents).set({
    status: "reconciliation_required",
    processingToken: null,
    holdReason: reason.slice(0, 2000),
  }).where(and(
    eq(recoveryEvents.id, eventId),
    eq(recoveryEvents.processingToken, token),
    or(eq(recoveryEvents.status, "reserved"), eq(recoveryEvents.status, "submitted")),
  ));
}
