import { createHash } from "node:crypto";
import type {
  FinancialDocumentFamily,
  ProposedFinancialDocument,
} from "./financialWorkflowEngine";

/**
 * This module prepares a deterministic Xero Draft request shape for future,
 * document-specific cutovers. It deliberately imports no HTTP or Xero client.
 * The only execution entry point rejects before a transport could be invoked.
 */
export const FINANCIAL_LIVE_WRITES_ENABLED = false as const;
export const FINANCIAL_WRITER_IMPLEMENTATION_VERSION = "phase-2.0-disabled-draft-adapter" as const;

export type FinancialDraftPayload = {
  endpoint: "/PurchaseOrders" | "/Invoices";
  documentFamily: FinancialDocumentFamily;
  documentNumber: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
};

export type DisabledWriterContext = {
  workflowType: string;
  approvalReference?: string | null;
  globalShadowMode?: boolean;
  familyLiveEnabled?: boolean;
};

export class FinancialWriteDisabledError extends Error {
  constructor(message = "Financial production writing is disabled. A future approved per-family cutover is required before any Xero Draft request can be sent.") {
    super(message);
    this.name = "FinancialWriteDisabledError";
  }
}

function isoDate(value: Date | null): string | undefined {
  return value ? value.toISOString().slice(0, 10) : undefined;
}

function xeroTaxType(documentFamily: FinancialDocumentFamily): "INPUT" | "OUTPUT" {
  return documentFamily === "purchase_order" ? "INPUT" : "OUTPUT";
}

function xeroLineAmountType(document: ProposedFinancialDocument): "Exclusive" | "Inclusive" {
  if (document.gstTreatment === "PENDING_CONFIGURATION") {
    throw new Error(`Cannot prepare ${document.proposedDocumentNumber ?? document.documentType}: GST treatment is still pending configuration.`);
  }
  return document.gstTreatment === "GST_INCLUSIVE" ? "Inclusive" : "Exclusive";
}

function xeroContact(document: ProposedFinancialDocument): Record<string, string> {
  if (document.partySourceId?.trim()) return { ContactID: document.partySourceId.trim() };
  if (document.partyName?.trim()) return { Name: document.partyName.trim() };
  throw new Error(`Cannot prepare ${document.proposedDocumentNumber ?? document.documentType}: a Xero contact is required.`);
}

function documentKey(document: ProposedFinancialDocument): string {
  if (!document.proposedDocumentNumber?.trim()) {
    throw new Error(`Cannot prepare ${document.documentType}: a proposed document number is required.`);
  }
  return document.proposedDocumentNumber.trim();
}

function stableIdempotencyKey(document: ProposedFinancialDocument, workflowIdempotencyKey: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      workflowIdempotencyKey,
      documentFamily: document.documentFamily,
      documentType: document.documentType,
      number: documentKey(document),
      action: document.proposedAction,
      total: document.total.toFixed(2),
      lines: document.lineItems.map((line) => ({
        itemCode: line.itemCode,
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
        accountCode: line.accountCode,
        gstTreatment: line.gstTreatment,
      })),
    }))
    .digest("hex");
}

/**
 * Creates a transport-neutral Draft request plan. It does not transmit it.
 * Purchase-order amounts use GST-exclusive Xero lines; customer invoices retain
 * the evaluator's explicit Exclusive/Inclusive GST treatment.
 */
export function prepareFinancialDraftPayload(
  document: ProposedFinancialDocument,
  workflowIdempotencyKey: string,
): FinancialDraftPayload {
  if (document.proposedAction === "hold" || document.validationStatus === "held" || document.validationStatus === "invalid") {
    throw new Error(`Cannot prepare ${document.proposedDocumentNumber ?? document.documentType}: the proposal is ${document.validationStatus}.`);
  }
  const documentNumber = documentKey(document);
  const lineAmountTypes = xeroLineAmountType(document);
  const taxType = xeroTaxType(document.documentFamily);
  const lineItems = document.lineItems.map((line) => ({
    ItemCode: line.itemCode || undefined,
    Description: line.description,
    Quantity: line.quantity,
    UnitAmount: line.unitAmount,
    AccountCode: line.accountCode || document.accountCode || undefined,
    TaxType: taxType,
  }));
  if (lineItems.length === 0) throw new Error(`Cannot prepare ${documentNumber}: at least one line item is required.`);

  const idempotencyKey = stableIdempotencyKey(document, workflowIdempotencyKey);
  if (document.documentFamily === "purchase_order") {
    return {
      endpoint: "/PurchaseOrders",
      documentFamily: document.documentFamily,
      documentNumber,
      idempotencyKey,
      body: {
        PurchaseOrders: [{
          PurchaseOrderNumber: documentNumber,
          Reference: document.reference ?? undefined,
          Contact: xeroContact(document),
          Status: "DRAFT",
          Date: isoDate(document.issueDate),
          LineAmountTypes: "Exclusive",
          LineItems: lineItems,
        }],
      },
    };
  }

  return {
    endpoint: "/Invoices",
    documentFamily: document.documentFamily,
    documentNumber,
    idempotencyKey,
    body: {
      Invoices: [{
        Type: "ACCREC",
        InvoiceNumber: documentNumber,
        Reference: document.reference ?? undefined,
        Contact: xeroContact(document),
        Status: "DRAFT",
        Date: isoDate(document.issueDate),
        DueDate: isoDate(document.dueDate),
        LineAmountTypes: lineAmountTypes,
        LineItems: lineItems,
      }],
    },
  };
}

/**
 * Future transport seam. It is intentionally a hard stop in every environment
 * until an explicit per-family approval implementation is added in a new phase.
 */
export async function executeFinancialDraftWrite(
  _payload: FinancialDraftPayload,
  _context: DisabledWriterContext,
): Promise<never> {
  throw new FinancialWriteDisabledError();
}

/** Server-enforced guard reusable by future writer routes and scheduled handlers. */
export function assertFinancialWritesDisabled(_context: DisabledWriterContext): void {
  if (!FINANCIAL_LIVE_WRITES_ENABLED) throw new FinancialWriteDisabledError();
}
