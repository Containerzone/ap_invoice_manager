import { and, eq, isNull, or } from "drizzle-orm";
import {
  financialMainCustomerInvoiceEvents as mainEvents,
  financialMainCustomerInvoiceReconciliationEvents as recoveryEvents,
  financialWriterExecutions,
  type FinancialMainCustomerInvoiceEvent,
  type FinancialMainCustomerInvoiceReconciliationEvent,
  type FinancialWriterExecution,
} from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import {
  isPermittedMainCustomerInvoiceLineAccount,
  prepareFinancialDraftPayload,
} from "./financialProductionWriter";
import {
  assertMainCustomerInvoiceReconciliationRelease,
  getMainCustomerInvoiceReleasePolicy,
} from "./financialMainCustomerInvoiceRelease";

/**
 * This is an intentionally closed recovery class, not a general Main Invoice
 * retry policy.  It documents the sole locally-proven pre-transport validation
 * receipt that can be prepared for a separately approved recovery.
 */
export const MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE = {
  originalEventId: 750001,
  failedWriterExecutionId: 1110001,
  dealId: "5x490313",
  dealNumber: "D702946",
  invoiceNumber: "INV-702946",
  total: 9_932.07,
  validationError:
    "Main Customer Invoice automatic release permits only a new exact AUD Exclusive Draft ACCREC with account 200 lines.",
} as const;

const affected = (result: any) =>
  Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;

async function database() {
  const db = await getDb();
  if (!db)
    throw new Error(
      "Main Customer Invoice reconciliation audit ledger is unavailable."
    );
  return db;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

/** Every mutable original-event fact is bound into the separate recovery receipt. */
export function mainCustomerInvoiceReconciliationOriginalHash(
  event: FinancialMainCustomerInvoiceEvent
): string {
  return financialSha256({
    id: event.id,
    dealId: event.dealId,
    dealNumber: event.dealNumber,
    quoteId: event.quoteId,
    quoteNumber: event.quoteNumber,
    proposedInvoiceNumber: event.proposedInvoiceNumber,
    customerVtigerId: event.customerVtigerId,
    customerName: event.customerName,
    sourceRefreshedAt: event.sourceRefreshedAt?.toISOString() ?? null,
    sourceSnapshotHash: event.sourceSnapshotHash,
    rulesSnapshotHash: event.rulesSnapshotHash,
    xeroPreflightHash: event.xeroPreflightHash,
    proposal: event.proposal,
    xeroPreflight: event.xeroPreflight,
    xeroInvoiceId: event.xeroInvoiceId,
    releaseKey: event.releaseKey,
    authorisedPayload: event.authorisedPayload,
    processingToken: event.processingToken,
    status: event.status,
    holdReason: event.holdReason,
    executionId: event.executionId,
  });
}

/** Binds the exact locally-known failed execution without treating it as transport evidence. */
export function mainCustomerInvoiceReconciliationWriterEvidenceHash(
  execution: FinancialWriterExecution
): string {
  return financialSha256({
    id: execution.id,
    executionKey: execution.executionKey,
    workflowType: execution.workflowType,
    documentFamily: execution.documentFamily,
    proposedAction: execution.proposedAction,
    proposedDocumentNumber: execution.proposedDocumentNumber,
    targetXeroDocumentId: execution.targetXeroDocumentId,
    endpoint: execution.endpoint,
    method: execution.method,
    idempotencyKey: execution.idempotencyKey,
    payloadFingerprint: execution.payloadFingerprint,
    status: execution.status,
    approvalReference: execution.approvalReference,
    safePayloadSummary: execution.safePayloadSummary,
    xeroDocumentId: execution.xeroDocumentId,
    xeroDocumentStatus: execution.xeroDocumentStatus,
    xeroResponseSummary: execution.xeroResponseSummary,
    errorMessage: execution.errorMessage,
    preparedBy: execution.preparedBy,
    submittedAt: execution.submittedAt?.toISOString() ?? null,
    completedAt: execution.completedAt?.toISOString() ?? null,
  });
}

function isExactOriginalAuthorisation(
  event: FinancialMainCustomerInvoiceEvent
): boolean {
  const authorisation = event.authorisedPayload;
  return (
    isRecord(authorisation) &&
    hasHash(authorisation.hash) &&
    authorisation.number ===
      MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.invoiceNumber &&
    hasHash(authorisation.bodyHash)
  );
}

/**
 * Accepts only the named reconciliation event with no Xero receipt.  It is
 * deliberately independent of the normal Main Invoice preview/claim API.
 */
export function isEligibleMainCustomerInvoiceReconciliationOriginal(
  event: FinancialMainCustomerInvoiceEvent | null | undefined,
  originalEventId: number
): event is FinancialMainCustomerInvoiceEvent {
  const scope = MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE;
  return Boolean(
    event &&
      originalEventId === scope.originalEventId &&
      event.id === scope.originalEventId &&
      event.dealId === scope.dealId &&
      event.dealNumber === scope.dealNumber &&
      event.proposedInvoiceNumber === scope.invoiceNumber &&
      event.status === "reconciliation_required" &&
      event.processingToken === null &&
      event.xeroInvoiceId === null &&
      event.executionId === null &&
      isExactOriginalAuthorisation(event)
  );
}

/**
 * The prior receipt must prove a local validation failure before an Xero
 * response could exist.  A submitted/uncertain record is expressly excluded.
 */
export function isEligibleMainCustomerInvoiceLocalValidationFailure(
  execution: FinancialWriterExecution | null | undefined
): execution is FinancialWriterExecution {
  const scope = MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE;
  return Boolean(
    execution &&
      execution.id === scope.failedWriterExecutionId &&
      execution.workflowType === "main_customer_invoice" &&
      execution.documentFamily === "customer_invoice" &&
      execution.proposedAction === "create_draft" &&
      execution.proposedDocumentNumber === scope.invoiceNumber &&
      execution.targetXeroDocumentId === null &&
      execution.endpoint === "/Invoices" &&
      execution.method === "POST" &&
      execution.status === "failed" &&
      execution.xeroDocumentId === null &&
      execution.xeroDocumentStatus === null &&
      execution.xeroResponseSummary === null &&
      execution.errorMessage === scope.validationError &&
      execution.submittedAt !== null &&
      execution.completedAt !== null &&
      hasHash(execution.idempotencyKey)
  );
}

export type MainCustomerInvoiceReconciliationOrigin = {
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  total: number;
};

/** Classifies the one and only safe no-POST writer-validation origin. */
export function classifyMainCustomerInvoiceReconciliationOrigin(input: {
  original: FinancialMainCustomerInvoiceEvent | null | undefined;
  failedExecution: FinancialWriterExecution | null | undefined;
  originalEventId: number;
}): MainCustomerInvoiceReconciliationOrigin {
  if (
    !isEligibleMainCustomerInvoiceReconciliationOriginal(
      input.original,
      input.originalEventId
    ) ||
    !isEligibleMainCustomerInvoiceLocalValidationFailure(input.failedExecution)
  ) {
    throw new Error(
      "Only the exact D702946 locally-known Main Invoice no-POST validation receipt may be considered for recovery."
    );
  }
  return {
    dealId: MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.dealId,
    dealNumber: MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.dealNumber,
    invoiceNumber: MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.invoiceNumber,
    total: MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.total,
  };
}

export type MainCustomerInvoiceReconciliationEvidence = {
  originalEventId: number;
  failedWriterExecutionId: number;
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  originalEventHash: string;
  failedWriterEvidenceHash: string;
  sourceSnapshotHash: string;
  xeroPreflightHash: string;
  sourceSnapshot: Record<string, unknown>;
  proposal: Record<string, unknown>;
  xeroPreflight: Record<string, unknown>;
};

export async function getMainCustomerInvoiceReconciliationOriginal(
  originalEventId: number
): Promise<FinancialMainCustomerInvoiceEvent | null> {
  return (
    (
      await (await database())
        .select()
        .from(mainEvents)
        .where(eq(mainEvents.id, originalEventId))
        .limit(1)
    )[0] ?? null
  );
}

export async function getMainCustomerInvoiceReconciliationWriterEvidence(
  executionId: number
): Promise<FinancialWriterExecution | null> {
  return (
    (
      await (await database())
        .select()
        .from(financialWriterExecutions)
        .where(eq(financialWriterExecutions.id, executionId))
        .limit(1)
    )[0] ?? null
  );
}

export async function getMainCustomerInvoiceReconciliationEvent(
  eventId: number
): Promise<FinancialMainCustomerInvoiceReconciliationEvent | null> {
  return (
    (
      await (await database())
        .select()
        .from(recoveryEvents)
        .where(eq(recoveryEvents.id, eventId))
        .limit(1)
    )[0] ?? null
  );
}

/**
 * Builds a recovery-specific deterministic payload key.  It can never collide
 * with the failed normal-writer execution's key, even when the financial body
 * is otherwise identical.
 */
export function prepareMainCustomerInvoiceReconciliationPayload(
  proposal: Record<string, any>,
  originalEventId: number,
  sourceSnapshotHash: string
): FinancialDraftPayload {
  const payload = prepareFinancialDraftPayload(
    proposal as any,
    `${proposal.dealId ?? "main"}:main_invoice_reconciliation:${originalEventId}:${sourceSnapshotHash}`
  );
  (payload.body.Invoices as Record<string, unknown>[])[0]!.CurrencyCode = "AUD";
  return payload;
}

/** A recovery receipt is created only by the explicit protected reservation call. */
export async function reserveMainCustomerInvoiceReconciliation(
  input: MainCustomerInvoiceReconciliationEvidence & { token: string }
) {
  const db = await database();
  const { token, ...evidence } = input;
  const recoveryKey = financialSha256(evidence);
  let event = (
    await db
      .select()
      .from(recoveryEvents)
      .where(eq(recoveryEvents.originalEventId, input.originalEventId))
      .limit(1)
  )[0];
  if (event) {
    if (event.recoveryKey !== recoveryKey)
      return { state: "blocked" as const, event };
    return {
      state:
        event.status === "drafts_created"
          ? ("completed" as const)
          : ("already_reserved" as const),
      event,
    };
  }
  try {
    await db.insert(recoveryEvents).values({
      ...evidence,
      recoveryKey,
      status: "reserved",
      processingToken: token,
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
  event = (
    await db
      .select()
      .from(recoveryEvents)
      .where(eq(recoveryEvents.originalEventId, input.originalEventId))
      .limit(1)
  )[0];
  if (!event)
    throw new Error(
      "Main Customer Invoice reconciliation receipt could not be read back."
    );
  if (
    event.recoveryKey !== recoveryKey ||
    event.processingToken !== token ||
    event.status !== "reserved"
  ) {
    return {
      state:
        event.status === "drafts_created"
          ? ("completed" as const)
          : ("blocked" as const),
      event,
    };
  }
  return { state: "reserved" as const, event };
}

/** The recovery payload is immutable and binds only once to its separate receipt. */
export async function bindMainCustomerInvoiceReconciliationPayload(
  eventId: number,
  token: string,
  releaseKey: string,
  payload: FinancialDraftPayload
): Promise<void> {
  if (
    !affected(
      await (
        await database()
      )
        .update(recoveryEvents)
        .set({
          releaseKey,
          authorisedPayload: {
            hash: financialSha256(payload),
            number: payload.documentNumber,
            payload,
          },
        })
        .where(
          and(
            eq(recoveryEvents.id, eventId),
            eq(recoveryEvents.status, "reserved"),
            eq(recoveryEvents.processingToken, token),
            isNull(recoveryEvents.authorisedPayload)
          )
        )
    )
  ) {
    throw new Error(
      "Main Customer Invoice reconciliation payload can only bind once to its exclusive reservation."
    );
  }
}

function exactMainInvoicePayload(payload: FinancialDraftPayload): boolean {
  const rows = payload.body.Invoices;
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  return (
    payload.method === "POST" &&
    payload.endpoint === "/Invoices" &&
    payload.documentFamily === "customer_invoice" &&
    payload.expectedXeroDocumentId === null &&
    payload.documentNumber ===
      MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.invoiceNumber &&
    isRecord(row) &&
    Object.keys(payload.body).length === 1 &&
    !row.InvoiceID &&
    row.InvoiceNumber === payload.documentNumber &&
    row.Type === "ACCREC" &&
    row.Status === "DRAFT" &&
    row.CurrencyCode === "AUD" &&
    row.LineAmountTypes === "Exclusive" &&
    isRecord(row.Contact) &&
    typeof row.Contact.ContactID === "string" &&
    Boolean(row.Contact.ContactID.trim()) &&
    Array.isArray(row.LineItems) &&
    row.LineItems.length > 0 &&
    row.LineItems.every(isPermittedMainCustomerInvoiceLineAccount)
  );
}

/**
 * Revalidates the separate receipt before any future transport.  The dynamic
 * import avoids a module-initialisation cycle while preserving source/Xero
 * GET-only revalidation at the final writer boundary.
 */
export async function verifyMainCustomerInvoiceReconciliationWriteAccess(input: {
  eventId: number;
  token: string;
  releaseKey: string;
  preparedBy: number;
  payload: FinancialDraftPayload;
}): Promise<void> {
  if (
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED !==
    "true"
  ) {
    throw new Error(
      "Main Customer Invoice reconciliation release is disabled."
    );
  }
  const policy = await getMainCustomerInvoiceReleasePolicy();
  assertMainCustomerInvoiceReconciliationRelease(policy);
  const event = await getMainCustomerInvoiceReconciliationEvent(input.eventId);
  const original = event
    ? await getMainCustomerInvoiceReconciliationOriginal(event.originalEventId)
    : null;
  const failedExecution = event
    ? await getMainCustomerInvoiceReconciliationWriterEvidence(
        event.failedWriterExecutionId
      )
    : null;
  const authorised = event?.authorisedPayload as {
    hash?: unknown;
    number?: unknown;
  } | null;
  if (
    !event ||
    !original ||
    !failedExecution ||
    !isEligibleMainCustomerInvoiceReconciliationOriginal(
      original,
      event.originalEventId
    ) ||
    !isEligibleMainCustomerInvoiceLocalValidationFailure(failedExecution) ||
    event.originalEventId !== original.id ||
    event.failedWriterExecutionId !== failedExecution.id ||
    event.dealId !== original.dealId ||
    event.dealNumber !== original.dealNumber ||
    event.invoiceNumber !== original.proposedInvoiceNumber ||
    event.originalEventHash !==
      mainCustomerInvoiceReconciliationOriginalHash(original) ||
    event.failedWriterEvidenceHash !==
      mainCustomerInvoiceReconciliationWriterEvidenceHash(failedExecution) ||
    event.status !== "reserved" ||
    event.processingToken !== input.token ||
    event.releaseKey !== input.releaseKey ||
    event.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy ||
    !isRecord(authorised) ||
    authorised.hash !== financialSha256(input.payload) ||
    authorised.number !== event.invoiceNumber ||
    !exactMainInvoicePayload(input.payload)
  ) {
    throw new Error(
      "Main Customer Invoice reconciliation requires the exact D702946 no-POST failure, independent recovery receipt and exact-payload reservation."
    );
  }

  const { previewMainCustomerInvoice } = await import(
    "./financialMainCustomerInvoiceService"
  );
  const current = await previewMainCustomerInvoice(event.dealId);
  const document = current.preview.document as Record<string, any> | null;
  const preflight = current.preflight as Record<string, any> | null;
  const lines = document?.lineItems;
  const items = Array.isArray(preflight?.itemChecks)
    ? preflight.itemChecks
    : [];
  const itemChecks = new Map(
    items.map((item: any) => [
      String(item?.itemCode ?? "")
        .trim()
        .toUpperCase(),
      item,
    ])
  );
  const totalMatches =
    typeof document?.subtotal === "number" &&
    typeof document?.taxAmount === "number" &&
    typeof document?.total === "number" &&
    Math.abs(document.subtotal + document.taxAmount - document.total) < 0.001 &&
    document.total === MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.total;
  const exactItems =
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every((line: any) => {
      const itemCode = String(line?.itemCode ?? "").trim();
      if (!itemCode) return String(line?.accountCode ?? "") === "200";
      const check = itemChecks.get(itemCode.toUpperCase());
      return (
        check?.found === true &&
        check?.isSold === true &&
        check?.salesTaxType === "OUTPUT" &&
        String(check?.salesAccountCode ?? "") ===
          String(line?.accountCode ?? "")
      );
    });
  if (
    current.state !== "previewed" ||
    !current.preview.eligible ||
    !document ||
    !preflight ||
    current.facts.dealId !== event.dealId ||
    current.facts.dealNumber !== event.dealNumber ||
    current.preview.proposedInvoiceNumber !== event.invoiceNumber ||
    document.proposedDocumentNumber !== event.invoiceNumber ||
    document.documentType !== "main_customer_invoice" ||
    document.sourceWorkflow !== "main_customer_invoice" ||
    document.sourceRecordId !== event.dealId ||
    preflight.duplicateState !== "not_found" ||
    !preflight.contactCheck?.found ||
    !preflight.contactCheck?.contactId ||
    document.partySourceId !== preflight.contactCheck.contactId ||
    !document.partyName ||
    !totalMatches ||
    !exactItems ||
    current.sourceSnapshotHash !== event.sourceSnapshotHash ||
    current.xeroPreflightHash !== event.xeroPreflightHash ||
    financialSha256(current.facts) !== financialSha256(event.sourceSnapshot) ||
    financialSha256(document) !== financialSha256(event.proposal) ||
    financialSha256(preflight) !== financialSha256(event.xeroPreflight)
  ) {
    throw new Error(
      "Current Main Customer Invoice source/Xero GET-only evidence no longer proves the reserved exact party, items, totals and no-duplicate state."
    );
  }
  const expected = prepareMainCustomerInvoiceReconciliationPayload(
    document,
    event.originalEventId,
    event.sourceSnapshotHash
  );
  if (financialSha256(expected) !== financialSha256(input.payload)) {
    throw new Error(
      "Main Customer Invoice reconciliation payload no longer matches its independently rebuilt exact evidence."
    );
  }
}

/** Consumes the recovery receipt before Xero authentication; it cannot be replayed. */
export async function consumeMainCustomerInvoiceReconciliationPayload(
  input: { eventId: number; token: string },
  executionId: number
): Promise<void> {
  if (
    !affected(
      await (
        await database()
      )
        .update(recoveryEvents)
        .set({
          status: "submitted",
          submittedAt: new Date(),
          executionId,
        })
        .where(
          and(
            eq(recoveryEvents.id, input.eventId),
            eq(recoveryEvents.status, "reserved"),
            eq(recoveryEvents.processingToken, input.token),
            isNull(recoveryEvents.submittedAt)
          )
        )
    )
  ) {
    throw new Error(
      "Main Customer Invoice reconciliation payload was already consumed or reservation lost."
    );
  }
}

export async function completeMainCustomerInvoiceReconciliation(input: {
  eventId: number;
  token: string;
  executionId: number;
  readbackEvidence: unknown;
}): Promise<void> {
  if (
    !affected(
      await (
        await database()
      )
        .update(recoveryEvents)
        .set({
          status: "drafts_created",
          executionId: input.executionId,
          readbackEvidence: input.readbackEvidence,
          processingToken: null,
          holdReason: null,
        })
        .where(
          and(
            eq(recoveryEvents.id, input.eventId),
            eq(recoveryEvents.status, "submitted"),
            eq(recoveryEvents.processingToken, input.token)
          )
        )
    )
  ) {
    throw new Error(
      "Main Customer Invoice reconciliation completion requires manual reconciliation."
    );
  }
}

/** A consumed/failed recovery remains immutable and cannot reopen the original event. */
export async function holdMainCustomerInvoiceReconciliation(
  eventId: number,
  token: string,
  reason: string
): Promise<void> {
  await (
    await database()
  )
    .update(recoveryEvents)
    .set({
      status: "reconciliation_required",
      processingToken: null,
      holdReason: reason.slice(0, 2000),
    })
    .where(
      and(
        eq(recoveryEvents.id, eventId),
        eq(recoveryEvents.processingToken, token),
        or(
          eq(recoveryEvents.status, "reserved"),
          eq(recoveryEvents.status, "submitted")
        )
      )
    );
}
