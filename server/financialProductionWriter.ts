import axios from "axios";
import { createHash } from "node:crypto";
import type {
  FinancialDocumentFamily,
  ProposedFinancialDocument,
} from "./financialWorkflowEngine";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { runXeroRequest } from "./xeroRequestManager";
import { verifyInitialStoragePilotWriteAccess } from "./financialInitialStorageDb";

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
  /** AP-local immutable writer-execution ledger ID, assigned before transport. */
  executionId?: number | null;
  workflowType: string;
  approvalReference: string | null;
  globalShadowMode: boolean;
  familyLiveEnabled: boolean;
  releaseManifestApproved: boolean;
  cutoverPackApproved: boolean;
  currentDocumentPreflightPassed: boolean;
  legacyWriterHandoffComplete: boolean;
  /** Isolated loaded-storage pilot receipt; never supplied by a browser or generic financial route. */
  storagePilotEventId?: number;
  storagePilotApprovedBy?: number;
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
  throw new Error(`Cannot prepare ${document.proposedDocumentNumber ?? document.documentType}: an exact Xero ContactID from the current preflight is required. Name-only contact payloads are not permitted.`);
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
export function assertFinancialDraftWriteAuthorised(
  context: FinancialWriteAuthorisation,
  options: { requireExecutionId?: boolean } = {},
): void {
  if (context.storagePilotEventId !== undefined) {
    if (context.workflowType !== "storage_activation" || !Number.isInteger(context.storagePilotEventId) || context.storagePilotEventId <= 0) {
      throw new FinancialWriteDisabledError("Storage pilot authorisation is not valid for this financial family.");
    }
    if (!Number.isInteger(context.storagePilotApprovedBy) || Number(context.storagePilotApprovedBy) <= 0) {
      throw new FinancialWriteDisabledError("Storage pilot requires its named AP approver.");
    }
    if (process.env.FINANCIAL_INITIAL_STORAGE_ENABLED !== "true") throw new FinancialWriteDisabledError("Initial loaded-storage Draft transport is not enabled.");
    if (!context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete || !context.approvalReference?.trim()) {
      throw new FinancialWriteDisabledError("Storage pilot needs exact Xero preflight, named approval and legacy writer handoff.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) {
      throw new FinancialWriteDisabledError("Storage Draft transport requires an AP execution ledger ID.");
    }
    return;
  }
  if (!isFinancialLiveWriteEnvironmentEnabled()) {
    throw new FinancialWriteDisabledError("Financial writer environment lock is active. Set no production action until a separately approved release enables it.");
  }
  if (context.globalShadowMode) throw new FinancialWriteDisabledError("Financial writer rejected the request because global shadow mode is active.");
  if (!context.familyLiveEnabled) throw new FinancialWriteDisabledError(`Financial writer rejected ${context.workflowType}: this family is not enabled.`);
  if (!context.releaseManifestApproved) throw new FinancialWriteDisabledError("Financial writer rejected the request because the all-family release manifest is not approved.");
  if (!context.cutoverPackApproved) throw new FinancialWriteDisabledError("Financial writer rejected the request because its document-specific cutover pack is not approved.");
  if (!context.currentDocumentPreflightPassed) throw new FinancialWriteDisabledError("Financial writer rejected the request because the current Xero Draft preflight is not passing.");
  if (!context.legacyWriterHandoffComplete) throw new FinancialWriteDisabledError("Financial writer rejected the request because the documented legacy writer handoff is incomplete.");
  if (!context.workflowType.trim()) throw new FinancialWriteDisabledError("Financial writer rejected the request because an AP workflow family is required.");
  if (!context.approvalReference?.trim()) throw new FinancialWriteDisabledError("Financial writer rejected the request because a document-specific approval reference is required.");
  if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) {
    throw new FinancialWriteDisabledError("Financial writer rejected the request because an AP execution ledger ID is required.");
  }
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
 * guard has passed. The loaded-storage route is additionally restricted to
 * three exact, named, approved Draft POSTs; unrelated financial families retain
 * their independent disabled release gates.
 * The deterministic idempotency key is preserved for its one transient retry.
 */
export async function executeFinancialDraftWrite(
  payload: FinancialDraftPayload,
  context: FinancialWriteAuthorisation,
): Promise<FinancialDraftWriteResult> {
  assertFinancialDraftWriteAuthorised(context);
  if (context.storagePilotEventId !== undefined && (payload.method !== "POST" || payload.expectedXeroDocumentId
    || !["/Invoices", "/PurchaseOrders"].includes(payload.endpoint))) {
    throw new FinancialWriteDisabledError("Loaded-storage pilot permits only a new ACCREC or Purchase Order Draft POST.");
  }
  if (context.storagePilotEventId !== undefined) {
    const rows = payload.documentFamily === "customer_invoice" ? payload.body.Invoices : payload.body.PurchaseOrders;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!row || row.Status !== "DRAFT" || (payload.documentFamily === "customer_invoice" && row.Type !== "ACCREC")) {
      throw new FinancialWriteDisabledError("Loaded-storage pilot requires exactly one ACCREC or Purchase Order in DRAFT status.");
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(payload.idempotencyKey)) {
    throw new FinancialWriteDisabledError("Financial writer rejected the request because a deterministic 64-character idempotency key is required.");
  }
  if (context.storagePilotEventId !== undefined) {
    await verifyInitialStoragePilotWriteAccess({ eventId: context.storagePilotEventId,
      approvalReference: context.approvalReference!, documentNumber: payload.documentNumber,
      preparedBy: context.storagePilotApprovedBy! });
  }
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
