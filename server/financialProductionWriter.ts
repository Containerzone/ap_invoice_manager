import axios from "axios";
import { createHash } from "node:crypto";
import type {
  FinancialDocumentFamily,
  ProposedFinancialDocument,
} from "./financialWorkflowEngine";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { runXeroRequest } from "./xeroRequestManager";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

/**
 * A writer can only be armed deliberately in the deployment environment. It is
 * false by default and no UI, route or scheduled job in this phase can change
 * it. A later documented cutover must also provide every context gate below.
 */
export function isFinancialLiveWriteEnvironmentEnabled(): boolean {
  return process.env.FINANCIAL_LIVE_WRITES_ENABLED === "true";
}

export const FINANCIAL_WRITER_IMPLEMENTATION_VERSION = "phase-3.0-guarded-draft-writer" as const;

export type FinancialDraftPayload = {
  endpoint: "/PurchaseOrders" | "/Invoices" | `/PurchaseOrders/${string}` | `/Invoices/${string}`;
  method: "POST" | "PUT";
  documentFamily: FinancialDocumentFamily;
  documentNumber: string;
  expectedXeroDocumentId: string | null;
  idempotencyKey: string;
  body: Record<string, unknown>;
};

/** An existing document can only ever be updated when it was freshly proven Draft. */
export type ExistingDraftTarget = {
  xeroDocumentId: string;
  documentNumber: string;
  status: "DRAFT";
};

/**
 * This context is intentionally more restrictive than the deployment flag. All
 * values are supplied by a future document-specific approval route; no current
 * caller is able to form an authorised context.
 */
export type FinancialWriteAuthorisation = {
  workflowType: string;
  approvalReference: string | null;
  globalShadowMode: boolean;
  familyLiveEnabled: boolean;
  releaseManifestApproved: boolean;
  cutoverPackApproved: boolean;
  currentDocumentPreflightPassed: boolean;
  legacyWriterHandoffComplete: boolean;
};

export type FinancialDraftWriteResult = {
  xeroDocumentId: string;
  documentNumber: string;
  status: "DRAFT";
  endpoint: FinancialDraftPayload["endpoint"];
  idempotencyKey: string;
};

export class FinancialWriteDisabledError extends Error {
  constructor(message = "Financial production writing is disabled. A later approved per-family cutover is required before any Xero Draft request can be sent.") {
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

function stableIdempotencyKey(document: ProposedFinancialDocument, workflowIdempotencyKey: string, targetId: string | null = null): string {
  return createHash("sha256")
    .update(JSON.stringify({
      workflowIdempotencyKey,
      documentFamily: document.documentFamily,
      documentType: document.documentType,
      number: documentKey(document),
      action: document.proposedAction,
      targetId,
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

function xeroLineItems(document: ProposedFinancialDocument) {
  const lineItems = document.lineItems.map((line) => ({
    ItemCode: line.itemCode || undefined,
    Description: line.description,
    Quantity: line.quantity,
    UnitAmount: line.unitAmount,
    AccountCode: line.accountCode || document.accountCode || undefined,
    TaxType: xeroTaxType(document.documentFamily),
  }));
  if (lineItems.length === 0) throw new Error(`Cannot prepare ${documentKey(document)}: at least one line item is required.`);
  return lineItems;
}

function xeroDocumentShape(document: ProposedFinancialDocument, target: ExistingDraftTarget | null): Record<string, unknown> {
  const lineItems = xeroLineItems(document);
  if (document.documentFamily === "purchase_order") {
    return {
      PurchaseOrderID: target?.xeroDocumentId,
      PurchaseOrderNumber: documentKey(document),
      Reference: document.reference ?? undefined,
      Contact: xeroContact(document),
      Status: "DRAFT",
      Date: isoDate(document.issueDate),
      LineAmountTypes: "Exclusive",
      LineItems: lineItems,
    };
  }
  return {
    InvoiceID: target?.xeroDocumentId,
    Type: "ACCREC",
    InvoiceNumber: documentKey(document),
    Reference: document.reference ?? undefined,
    Contact: xeroContact(document),
    Status: "DRAFT",
    Date: isoDate(document.issueDate),
    DueDate: isoDate(document.dueDate),
    LineAmountTypes: xeroLineAmountType(document),
    LineItems: lineItems,
  };
}

function assertWriteableProposal(document: ProposedFinancialDocument): void {
  if (document.proposedAction === "hold" || document.validationStatus === "held" || document.validationStatus === "invalid") {
    throw new Error(`Cannot prepare ${document.proposedDocumentNumber ?? document.documentType}: the proposal is ${document.validationStatus}.`);
  }
}

/** Creates a deterministic, transport-neutral Draft creation request. */
export function prepareFinancialDraftPayload(
  document: ProposedFinancialDocument,
  workflowIdempotencyKey: string,
): FinancialDraftPayload {
  assertWriteableProposal(document);
  if (document.proposedAction !== "create_draft") {
    throw new Error(`Cannot create ${documentKey(document)}: ${document.proposedAction} requires a freshly verified existing Draft target.`);
  }
  const documentNumber = documentKey(document);
  return {
    endpoint: document.documentFamily === "purchase_order" ? "/PurchaseOrders" : "/Invoices",
    method: "POST",
    documentFamily: document.documentFamily,
    documentNumber,
    expectedXeroDocumentId: null,
    idempotencyKey: stableIdempotencyKey(document, workflowIdempotencyKey),
    body: document.documentFamily === "purchase_order"
      ? { PurchaseOrders: [xeroDocumentShape(document, null)] }
      : { Invoices: [xeroDocumentShape(document, null)] },
  };
}

/**
 * Creates a Draft-update payload only after an independent preflight proved the
 * exact Xero identifier, document number and Draft status. Non-Draft targets are
 * rejected before a transport can be selected.
 */
export function prepareFinancialDraftUpdatePayload(
  document: ProposedFinancialDocument,
  workflowIdempotencyKey: string,
  target: ExistingDraftTarget,
): FinancialDraftPayload {
  assertWriteableProposal(document);
  if (document.proposedAction !== "update_draft") {
    throw new Error(`Cannot update ${documentKey(document)}: this proposal is not an update_draft action.`);
  }
  if (!target.xeroDocumentId.trim() || target.status !== "DRAFT") {
    throw new Error(`Cannot update ${documentKey(document)}: an exact existing Draft target is required.`);
  }
  if (target.documentNumber.trim().toUpperCase() !== documentKey(document).toUpperCase()) {
    throw new Error(`Cannot update ${documentKey(document)}: the preflight Draft number does not match the proposal.`);
  }
  const endpoint = document.documentFamily === "purchase_order"
    ? `/PurchaseOrders/${encodeURIComponent(target.xeroDocumentId)}` as const
    : `/Invoices/${encodeURIComponent(target.xeroDocumentId)}` as const;
  return {
    endpoint,
    method: "PUT",
    documentFamily: document.documentFamily,
    documentNumber: documentKey(document),
    expectedXeroDocumentId: target.xeroDocumentId,
    idempotencyKey: stableIdempotencyKey(document, workflowIdempotencyKey, target.xeroDocumentId),
    body: document.documentFamily === "purchase_order"
      ? { PurchaseOrders: [xeroDocumentShape(document, target)] }
      : { Invoices: [xeroDocumentShape(document, target)] },
  };
}

/** Checks every cutover condition immediately before any Xero accounting call. */
export function assertFinancialDraftWriteAuthorised(context: FinancialWriteAuthorisation): void {
  if (!isFinancialLiveWriteEnvironmentEnabled()) {
    throw new FinancialWriteDisabledError("Financial writer environment lock is active. Set no production action until a separately approved release enables it.");
  }
  if (context.globalShadowMode) throw new FinancialWriteDisabledError("Financial writer rejected the request because global shadow mode is active.");
  if (!context.familyLiveEnabled) throw new FinancialWriteDisabledError(`Financial writer rejected ${context.workflowType}: this family is not enabled.`);
  if (!context.releaseManifestApproved) throw new FinancialWriteDisabledError("Financial writer rejected the request because the all-family release manifest is not approved.");
  if (!context.cutoverPackApproved) throw new FinancialWriteDisabledError("Financial writer rejected the request because its document-specific cutover pack is not approved.");
  if (!context.currentDocumentPreflightPassed) throw new FinancialWriteDisabledError("Financial writer rejected the request because the current Xero Draft preflight is not passing.");
  if (!context.legacyWriterHandoffComplete) throw new FinancialWriteDisabledError("Financial writer rejected the request because the documented legacy writer handoff is incomplete.");
  if (!context.approvalReference?.trim()) throw new FinancialWriteDisabledError("Financial writer rejected the request because a document-specific approval reference is required.");
}

function responseDocument(payload: FinancialDraftPayload, data: any): any {
  const row = payload.documentFamily === "purchase_order"
    ? data?.PurchaseOrders?.[0]
    : data?.Invoices?.[0];
  if (!row) throw new Error(`Xero did not return the expected Draft response for ${payload.documentNumber}.`);
  const returnedNumber = String(row.PurchaseOrderNumber ?? row.InvoiceNumber ?? "").trim();
  const returnedId = String(row.PurchaseOrderID ?? row.InvoiceID ?? "").trim();
  const returnedStatus = String(row.Status ?? "").trim().toUpperCase();
  if (returnedNumber.toUpperCase() !== payload.documentNumber.toUpperCase() || !returnedId || returnedStatus !== "DRAFT") {
    throw new Error(`Xero response for ${payload.documentNumber} did not confirm the exact expected Draft document.`);
  }
  if (payload.expectedXeroDocumentId && returnedId !== payload.expectedXeroDocumentId) {
    throw new Error(`Xero response for ${payload.documentNumber} returned a different document ID than the verified Draft target.`);
  }
  return { returnedId, returnedNumber };
}

/**
 * Performs exactly one Draft-only Xero document operation after every approval
 * guard has passed. No current route, webhook or schedule can call this method.
 * The deterministic idempotency key is preserved for its one transient retry.
 */
export async function executeFinancialDraftWrite(
  payload: FinancialDraftPayload,
  context: FinancialWriteAuthorisation,
): Promise<FinancialDraftWriteResult> {
  assertFinancialDraftWriteAuthorised(context);
  const auth = await getXeroReadAuthWithRefresh();
  const operation = `${payload.method} financial-draft:${payload.documentFamily}:${payload.documentNumber}`;
  const response = await runXeroRequest<any>(auth, operation, () => {
    const headers = {
      Authorization: `Bearer ${auth.token}`,
      "Xero-tenant-id": auth.tenantId,
      "Content-Type": "application/json",
      "Idempotency-Key": payload.idempotencyKey,
    };
    const url = `${XERO_API_BASE}${payload.endpoint}`;
    return payload.method === "POST"
      ? axios.post(url, payload.body, { headers })
      : axios.put(url, payload.body, { headers });
  }, { retryTransientGatewayFailures: true });
  const result = responseDocument(payload, response.data);
  return {
    xeroDocumentId: result.returnedId,
    documentNumber: result.returnedNumber,
    status: "DRAFT",
    endpoint: payload.endpoint,
    idempotencyKey: payload.idempotencyKey,
  };
}
