import axios from "axios";
import { createHash } from "node:crypto";
import type {
  FinancialDocumentFamily,
  ProposedFinancialDocument,
} from "./financialWorkflowEngine";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { runXeroRequest } from "./xeroRequestManager";
import { financialSha256 } from "./financialProposalIntegrity";
import { verifyInitialStoragePilotWriteAccess } from "./financialInitialStorageDb";
import { verifyStorageAutomaticWriteAccess } from "./financialStorageLifecycleDb";
import { verifyForHireAutomaticWriteAccess } from "./financialForHireDb";
import { verifyAssetPurchaseAutomaticWriteAccess } from "./financialAssetPurchaseDb";
import { verifyCustomerSalePurchaseAutomaticWriteAccess } from "./financialCustomerSalePurchaseDb";
import { verifyMainCustomerInvoiceAutomaticWriteAccess } from "./financialMainCustomerInvoiceDb";
import { consumeMainCustomerInvoiceReconciliationPayload, verifyMainCustomerInvoiceReconciliationWriteAccess } from "./financialMainCustomerInvoiceReconciliationDb";
import { verifyDepositInvoiceAutomaticWriteAccess } from "./financialDepositInvoiceDb";
import { consumeDepositInvoiceReconciliationPayload, verifyDepositInvoiceReconciliationWriteAccess } from "./financialDepositInvoiceReconciliationDb";
import { consumeFinalWeightPayload, verifyFinalWeightAutomaticWriteAccess } from "./financialFinalWeightAdjustmentDb";
import { consumeFinalWeightReconciliationPayload, verifyFinalWeightReconciliationWriteAccess } from "./financialFinalWeightReconciliationDb";
import { consumeFinalWeightReconciliationRemediationPayload, verifyFinalWeightReconciliationRemediationWriteAccess } from "./financialFinalWeightReconciliationRemediationDb";
import type { FinalWeightDirection } from "./financialFinalWeightAdjustmentRules";
import { consumeExtraHirePayload, verifyExtraHireAutomaticWriteAccess } from "./financialExtraHireInvoiceDb";
import { consumeD702946DepositMainDeductionRecoveryPayload, verifyD702946DepositMainDeductionRecoveryWriteAccess } from "./financialD702946DepositMainDeductionRecoveryDb";
import { assertD702946RecoveryPayload, D702946_RECOVERY_RELEASE_KEY, d702946ExistingDeductions } from "./financialD702946DepositMainDeductionRecoveryScope";
import { consumeD702946AuthorisedDepositMainDeductionRecoveryPayload, verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess } from "./financialD702946AuthorisedDepositMainDeductionRecoveryDb";
import { assertD702946AuthorisedDepositRecoveryPayload, D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY } from "./financialD702946AuthorisedDepositMainDeductionRecoveryScope";

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
  storageAutomaticEventId?: number;
  storageReleaseKey?: string;
  storageApprovedBy?: number;
  /** Isolated For Hire release event; no generic family can use this path. */
  forHireAutomaticEventId?: number;
  forHireReleaseKey?: string;
  forHireApprovedBy?: number;
  /** Isolated Container Control Asset purchase event; never available to generic financial families. */
  assetPurchaseAutomaticEventId?: number;
  assetPurchaseReleaseKey?: string;
  assetPurchaseApprovedBy?: number;
  /** Isolated Container Control Customer Sale purchase event; never available to other families. */
  customerSalePurchaseAutomaticEventId?: number;
  customerSalePurchaseReleaseKey?: string;
  customerSalePurchaseApprovedBy?: number;
  /** Isolated Main Customer Invoice event; never available to other financial families. */
  mainCustomerInvoiceAutomaticEventId?: number;
  mainCustomerInvoiceReleaseKey?: string;
  mainCustomerInvoiceApprovedBy?: number;
  /** Atomic Main Invoice preview claim; it is checked again immediately before POST. */
  mainCustomerInvoiceToken?: string;
  /** One named locally-proven Main Invoice validation recovery; never a normal event replay. */
  mainInvoiceReconciliationEventId?: number;
  mainInvoiceReconciliationToken?: string;
  mainInvoiceReconciliationReleaseKey?: string;
  mainInvoiceReconciliationApprovedBy?: number;
  /** Dedicated Deposit release only; the generic all-family gate cannot enable it. */
  depositInvoiceAutomaticEventId?: number;
  depositInvoiceReleaseKey?: string;
  depositInvoiceApprovedBy?: number;
  /** One individually approved historical Deposit recovery; never a webhook/browser or generic Deposit claim. */
  depositInvoiceReconciliationEventId?: number;
  depositInvoiceReconciliationToken?: string;
  depositInvoiceReconciliationReleaseKey?: string;
  depositInvoiceReconciliationApprovedBy?: number;
  /** Dedicated existing-main-Draft amendment only; never a Main Invoice create release. */
  finalWeightAutomaticEventId?: number;
  finalWeightDirection?: FinalWeightDirection;
  finalWeightReleaseKey?: string;
  finalWeightApprovedBy?: number;
  /** Individually approved recovery for an immutable historical Final Weight 404. */
  finalWeightReconciliationEventId?: number;
  finalWeightReconciliationToken?: string;
  finalWeightReconciliationReleaseKey?: string;
  finalWeightReconciliationApprovedBy?: number;
  /** One separately auditable no-execution verifier-defect remediation; never a generic reopening. */
  finalWeightReconciliationRemediationEventId?: number;
  finalWeightReconciliationRemediationToken?: string;
  finalWeightReconciliationRemediationReleaseKey?: string;
  finalWeightReconciliationRemediationApprovedBy?: number;
  /** Independent current-source Extra Hire claim; never available to a generic bridge. */
  extraHireAutomaticEventId?: number;
  extraHireReleaseKey?: string;
  extraHireApprovedBy?: number;
  /** One-off Deposit/main Draft correction; never available to webhooks or generic writers. */
  depositDraftCorrectionKind?: "deposit_description" | "main_deduction" | "main_deduction_rounding";
  depositDraftCorrectionReleaseKey?: string;
  depositDraftCorrectionApprovedBy?: number;
  /** Generic Deposit post-create amendment, independently released from Deposit creation. */
  depositMainDeductionAutomaticEventId?: number;
  depositMainDeductionReleaseKey?: string;
  depositMainDeductionApprovedBy?: number;
  depositMainDeductionToken?: string;
  /** Closed D702946 recovery only; no generic Deposit approval can form this class. */
  d702946DepositMainDeductionRecoveryEventId?: number;
  d702946DepositMainDeductionRecoveryToken?: string;
  d702946DepositMainDeductionRecoveryReleaseKey?: string;
  d702946DepositMainDeductionRecoveryApprovedBy?: number;
  /** V2 closed recovery only: existing Authorised Deposit evidence, Main Draft write target. */
  d702946AuthorisedDepositMainDeductionRecoveryEventId?: number;
  d702946AuthorisedDepositMainDeductionRecoveryToken?: string;
  d702946AuthorisedDepositMainDeductionRecoveryReleaseKey?: string;
  d702946AuthorisedDepositMainDeductionRecoveryApprovedBy?: number;
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

/**
 * Main Invoices may contain itemless Quote services, native transport items,
 * current Sale items, and the separately verified 20/40-foot Hire items. Sale
 * account evidence is bound by the current Xero preflight and immutable event
 * payload; all other pairings are fixed here to prevent cross-item accounts.
 */
export function isPermittedMainCustomerInvoiceLineAccount(line: unknown): boolean {
  const itemCode = String((line as { ItemCode?: unknown } | null)?.ItemCode ?? "").trim();
  const accountCode = String((line as { AccountCode?: unknown } | null)?.AccountCode ?? "").trim();
  if (!itemCode || itemCode === "SER9" || itemCode === "SER60") return accountCode === "200";
  if (itemCode === "20' Hire" || itemCode === "40' Hire") return accountCode === "210";
  if (itemCode === "20' Sale" || itemCode === "40' Sale") return /^\d{1,10}$/.test(accountCode);
  return false;
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
  const reference = document.reference?.trim();
  if (document.documentFamily === "purchase_order") {
    return {
      PurchaseOrderID: target?.xeroDocumentId,
      PurchaseOrderNumber: documentKey(document),
      ...(reference ? { Reference: reference } : {}),
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
    ...(reference ? { Reference: reference } : {}),
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
 * Main Invoice creation uses the exact completed wire body—not only selected
 * source fields—for its idempotency identity. This prevents a changed Date,
 * ContactID, Reference or CurrencyCode from reusing a stale Draft request key.
 */
export function bindFinancialDraftPayloadIdempotencyKey(payload: FinancialDraftPayload): FinancialDraftPayload {
  return {
    ...payload,
    idempotencyKey: financialSha256({
      version: "financial-draft-wire-body-v1",
      endpoint: payload.endpoint,
      method: payload.method,
      documentFamily: payload.documentFamily,
      documentNumber: payload.documentNumber,
      expectedXeroDocumentId: payload.expectedXeroDocumentId,
      body: payload.body,
    }),
  };
}

/**
 * Xero Draft POST/PUT outcomes can be uncertain after a transient gateway
 * failure. Never resubmit them automatically, regardless of the authorised
 * financial workflow; callers must reconcile the outcome instead.
 */
export function financialDraftWriteAllowsTransientRetry(_context: FinancialWriteAuthorisation): boolean {
  return false;
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
  const authorisedDepositRecoveryFields = [context.d702946AuthorisedDepositMainDeductionRecoveryEventId, context.d702946AuthorisedDepositMainDeductionRecoveryToken,
    context.d702946AuthorisedDepositMainDeductionRecoveryReleaseKey, context.d702946AuthorisedDepositMainDeductionRecoveryApprovedBy];
  if (context.workflowType === "d702946_authorised_deposit_main_deduction_recovery" || authorisedDepositRecoveryFields.some(value => value !== undefined)) {
    const otherClasses = Object.entries(context).filter(([key, value]) => value !== undefined && !key.startsWith("d702946AuthorisedDepositMainDeductionRecovery") &&
      /(?:EventId|Token|ReleaseKey|ApprovedBy|CorrectionKind|Direction)$/.test(key));
    if (process.env.FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED !== "true" ||
      context.workflowType !== "d702946_authorised_deposit_main_deduction_recovery" || otherClasses.length ||
      !Number.isInteger(context.d702946AuthorisedDepositMainDeductionRecoveryEventId) || Number(context.d702946AuthorisedDepositMainDeductionRecoveryEventId) <= 0 ||
      !context.d702946AuthorisedDepositMainDeductionRecoveryToken?.trim() || !context.d702946AuthorisedDepositMainDeductionRecoveryReleaseKey?.trim() ||
      context.d702946AuthorisedDepositMainDeductionRecoveryReleaseKey !== D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY ||
      !Number.isInteger(context.d702946AuthorisedDepositMainDeductionRecoveryApprovedBy) || Number(context.d702946AuthorisedDepositMainDeductionRecoveryApprovedBy) <= 0 ||
      context.approvalReference !== context.d702946AuthorisedDepositMainDeductionRecoveryReleaseKey || !context.currentDocumentPreflightPassed ||
      !context.legacyWriterHandoffComplete || context.globalShadowMode || !context.familyLiveEnabled) {
      throw new FinancialWriteDisabledError("D702946 Authorised-Deposit recovery requires its dedicated default-off V2 gate and mutually exclusive exact reservation context.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0))
      throw new FinancialWriteDisabledError("D702946 Authorised-Deposit recovery writer execution ledger is required.");
    return;
  }
  const recoveryFields = [context.d702946DepositMainDeductionRecoveryEventId, context.d702946DepositMainDeductionRecoveryToken,
    context.d702946DepositMainDeductionRecoveryReleaseKey, context.d702946DepositMainDeductionRecoveryApprovedBy];
  if (context.workflowType === "d702946_deposit_main_deduction_recovery" || recoveryFields.some(value => value !== undefined)) {
    const otherClasses = Object.entries(context).filter(([key, value]) => value !== undefined && !key.startsWith("d702946DepositMainDeductionRecovery") &&
      /(?:EventId|Token|ReleaseKey|ApprovedBy|CorrectionKind|Direction)$/.test(key));
    if (process.env.FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED !== "true" ||
      context.workflowType !== "d702946_deposit_main_deduction_recovery" || otherClasses.length ||
      !Number.isInteger(context.d702946DepositMainDeductionRecoveryEventId) || Number(context.d702946DepositMainDeductionRecoveryEventId) <= 0 ||
      !context.d702946DepositMainDeductionRecoveryToken?.trim() || !context.d702946DepositMainDeductionRecoveryReleaseKey?.trim() ||
      context.d702946DepositMainDeductionRecoveryReleaseKey !== D702946_RECOVERY_RELEASE_KEY ||
      !Number.isInteger(context.d702946DepositMainDeductionRecoveryApprovedBy) || Number(context.d702946DepositMainDeductionRecoveryApprovedBy) <= 0 ||
      context.approvalReference !== context.d702946DepositMainDeductionRecoveryReleaseKey || !context.currentDocumentPreflightPassed ||
      !context.legacyWriterHandoffComplete || context.globalShadowMode || !context.familyLiveEnabled) {
      throw new FinancialWriteDisabledError("D702946 recovery requires its dedicated default-off gate and mutually exclusive exact reservation context.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0))
      throw new FinancialWriteDisabledError("D702946 recovery writer execution ledger is required.");
    return;
  }
  if (context.workflowType === "main_invoice_reconciliation" || context.mainInvoiceReconciliationEventId !== undefined) {
    if (process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED !== "true" || context.workflowType !== "main_invoice_reconciliation" ||
      !Number.isInteger(context.mainInvoiceReconciliationEventId) || Number(context.mainInvoiceReconciliationEventId) <= 0 ||
      !context.mainInvoiceReconciliationToken || !context.mainInvoiceReconciliationReleaseKey ||
      !Number.isInteger(context.mainInvoiceReconciliationApprovedBy) || Number(context.mainInvoiceReconciliationApprovedBy) <= 0 ||
      context.approvalReference !== context.mainInvoiceReconciliationReleaseKey || !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.mainCustomerInvoiceAutomaticEventId, context.depositInvoiceAutomaticEventId, context.depositInvoiceReconciliationEventId,
        context.depositMainDeductionAutomaticEventId, context.depositDraftCorrectionKind, context.finalWeightAutomaticEventId,
        context.finalWeightReconciliationEventId, context.finalWeightReconciliationRemediationEventId, context.assetPurchaseAutomaticEventId,
        context.customerSalePurchaseAutomaticEventId, context.forHireAutomaticEventId, context.storageAutomaticEventId,
        context.storagePilotEventId, context.extraHireAutomaticEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Main Customer Invoice reconciliation requires its separate one-time recovery gate and exact reservation.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) {
      throw new FinancialWriteDisabledError("Main Customer Invoice reconciliation execution ledger is required.");
    }
    return;
  }
  if (context.workflowType === "deposit_invoice_reconciliation" || context.depositInvoiceReconciliationEventId !== undefined) {
    if (process.env.FINANCIAL_DEPOSIT_INVOICE_RECONCILIATION_ENABLED !== "true" || context.workflowType !== "deposit_invoice_reconciliation" ||
      !Number.isInteger(context.depositInvoiceReconciliationEventId) || Number(context.depositInvoiceReconciliationEventId) <= 0 ||
      !context.depositInvoiceReconciliationToken || !context.depositInvoiceReconciliationReleaseKey ||
      !Number.isInteger(context.depositInvoiceReconciliationApprovedBy) || Number(context.depositInvoiceReconciliationApprovedBy) <= 0 ||
      context.approvalReference !== context.depositInvoiceReconciliationReleaseKey || !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.depositInvoiceAutomaticEventId, context.depositMainDeductionAutomaticEventId, context.depositDraftCorrectionKind,
        context.finalWeightAutomaticEventId, context.finalWeightReconciliationEventId, context.finalWeightReconciliationRemediationEventId, context.mainCustomerInvoiceAutomaticEventId,
        context.assetPurchaseAutomaticEventId, context.customerSalePurchaseAutomaticEventId, context.forHireAutomaticEventId,
        context.storageAutomaticEventId, context.storagePilotEventId, context.extraHireAutomaticEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Deposit Invoice reconciliation requires its separate one-time recovery gate and exact reservation.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) throw new FinancialWriteDisabledError("Deposit Invoice reconciliation execution ledger is required.");
    return;
  }
  if (context.workflowType === "final_weight_reconciliation" || context.finalWeightReconciliationEventId !== undefined) {
    if (process.env.FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED !== "true" || context.workflowType !== "final_weight_reconciliation" ||
      !Number.isInteger(context.finalWeightReconciliationEventId) || Number(context.finalWeightReconciliationEventId) <= 0 ||
      !context.finalWeightReconciliationToken || !context.finalWeightReconciliationReleaseKey ||
      !Number.isInteger(context.finalWeightReconciliationApprovedBy) || Number(context.finalWeightReconciliationApprovedBy) <= 0 ||
      context.approvalReference !== context.finalWeightReconciliationReleaseKey || !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.finalWeightAutomaticEventId, context.finalWeightReconciliationRemediationEventId, context.depositInvoiceAutomaticEventId, context.mainCustomerInvoiceAutomaticEventId,
        context.assetPurchaseAutomaticEventId, context.customerSalePurchaseAutomaticEventId, context.forHireAutomaticEventId,
        context.storageAutomaticEventId, context.storagePilotEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Final Weight reconciliation requires its separate one-time recovery gate and exact reservation.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) throw new FinancialWriteDisabledError("Final Weight reconciliation execution ledger is required.");
    return;
  }
  if (context.workflowType === "final_weight_reconciliation_remediation" || context.finalWeightReconciliationRemediationEventId !== undefined) {
    if (process.env.FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED !== "true" || context.workflowType !== "final_weight_reconciliation_remediation" ||
      !Number.isInteger(context.finalWeightReconciliationRemediationEventId) || Number(context.finalWeightReconciliationRemediationEventId) <= 0 ||
      !context.finalWeightReconciliationRemediationToken || !context.finalWeightReconciliationRemediationReleaseKey ||
      !Number.isInteger(context.finalWeightReconciliationRemediationApprovedBy) || Number(context.finalWeightReconciliationRemediationApprovedBy) <= 0 ||
      context.approvalReference !== context.finalWeightReconciliationRemediationReleaseKey || !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.finalWeightAutomaticEventId, context.finalWeightReconciliationEventId, context.depositInvoiceAutomaticEventId,
        context.depositMainDeductionAutomaticEventId, context.depositDraftCorrectionKind, context.extraHireAutomaticEventId,
        context.mainCustomerInvoiceAutomaticEventId, context.assetPurchaseAutomaticEventId, context.customerSalePurchaseAutomaticEventId,
        context.forHireAutomaticEventId, context.storageAutomaticEventId, context.storagePilotEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Final Weight verifier-defect remediation requires its separate one-time recovery gate and exact reservation.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) throw new FinancialWriteDisabledError("Final Weight verifier-defect remediation execution ledger is required.");
    return;
  }
  if (context.workflowType === "deposit_main_deduction" || context.depositMainDeductionAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED !== "true" || context.workflowType !== "deposit_main_deduction" ||
      !Number.isInteger(context.depositMainDeductionAutomaticEventId) || Number(context.depositMainDeductionAutomaticEventId) <= 0 || !context.depositMainDeductionReleaseKey ||
      !Number.isInteger(context.depositMainDeductionApprovedBy) || Number(context.depositMainDeductionApprovedBy) <= 0 || !context.depositMainDeductionToken || context.approvalReference !== context.depositMainDeductionReleaseKey ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.depositInvoiceAutomaticEventId, context.mainCustomerInvoiceAutomaticEventId, context.finalWeightAutomaticEventId, context.finalWeightReconciliationEventId, context.finalWeightReconciliationRemediationEventId, context.assetPurchaseAutomaticEventId,
        context.customerSalePurchaseAutomaticEventId, context.forHireAutomaticEventId, context.storageAutomaticEventId, context.storagePilotEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Deposit-to-main independent Draft amendment gate is invalid; Deposit creation or another family cannot enable it.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) throw new FinancialWriteDisabledError("Deposit-to-main execution ledger is required.");
    return;
  }
  if (context.workflowType === "extra_hire" || context.extraHireAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED !== "true" || context.workflowType !== "extra_hire" ||
      !Number.isInteger(context.extraHireAutomaticEventId) || Number(context.extraHireAutomaticEventId) <= 0 || !context.extraHireReleaseKey ||
      !Number.isInteger(context.extraHireApprovedBy) || Number(context.extraHireApprovedBy) <= 0 || context.approvalReference !== context.extraHireReleaseKey ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.finalWeightAutomaticEventId, context.finalWeightReconciliationEventId, context.finalWeightReconciliationRemediationEventId, context.depositInvoiceAutomaticEventId, context.mainCustomerInvoiceAutomaticEventId,
        context.assetPurchaseAutomaticEventId, context.customerSalePurchaseAutomaticEventId, context.forHireAutomaticEventId,
        context.storageAutomaticEventId, context.storagePilotEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Extra Hire independent Draft gate is invalid; global/storage/other invoice gates cannot enable it.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) throw new FinancialWriteDisabledError("Extra Hire execution ledger is required.");
    return;
  }
  if (context.workflowType === "final_weight_adjustment" || context.finalWeightAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED !== "true" || context.workflowType !== "final_weight_adjustment" ||
      !Number.isInteger(context.finalWeightAutomaticEventId) || Number(context.finalWeightAutomaticEventId) <= 0 ||
      !["overweight", "underweight"].includes(context.finalWeightDirection ?? "") || !context.finalWeightReleaseKey ||
      !Number.isInteger(context.finalWeightApprovedBy) || Number(context.finalWeightApprovedBy) <= 0 || context.approvalReference !== context.finalWeightReleaseKey ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.depositInvoiceAutomaticEventId, context.mainCustomerInvoiceAutomaticEventId, context.assetPurchaseAutomaticEventId,
        context.customerSalePurchaseAutomaticEventId, context.forHireAutomaticEventId, context.storageAutomaticEventId, context.storagePilotEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Final-weight independent amendment gate is invalid; Main Invoice/global/other family cannot enable it.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) throw new FinancialWriteDisabledError("Final-weight execution ledger is required.");
    return;
  }
  if (context.workflowType === "deposit_invoice" || context.depositInvoiceAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED !== "true" || context.workflowType !== "deposit_invoice" ||
      !Number.isInteger(context.depositInvoiceAutomaticEventId) || Number(context.depositInvoiceAutomaticEventId) <= 0 || !context.depositInvoiceReleaseKey ||
      !Number.isInteger(context.depositInvoiceApprovedBy) || Number(context.depositInvoiceApprovedBy) <= 0 || context.approvalReference !== context.depositInvoiceReleaseKey ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete ||
      [context.mainCustomerInvoiceAutomaticEventId, context.assetPurchaseAutomaticEventId, context.customerSalePurchaseAutomaticEventId,
        context.forHireAutomaticEventId, context.storageAutomaticEventId, context.storagePilotEventId].some(value => value !== undefined)) {
      throw new FinancialWriteDisabledError("Deposit Invoice automatic release gate is not valid; global or other-family gates cannot enable it.");
    }
    if (options.requireExecutionId !== false && (!Number.isInteger(context.executionId) || Number(context.executionId) <= 0)) throw new FinancialWriteDisabledError("Deposit Invoice execution ledger is required.");
    return;
  }
  if (context.mainCustomerInvoiceAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED !== "true" || context.workflowType !== "main_customer_invoice" ||
      !Number.isInteger(context.mainCustomerInvoiceAutomaticEventId) || context.mainCustomerInvoiceAutomaticEventId <= 0 || !context.mainCustomerInvoiceReleaseKey || !context.mainCustomerInvoiceApprovedBy ||
      !context.mainCustomerInvoiceToken || !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete) {
      throw new FinancialWriteDisabledError("Main Customer Invoice automatic release gate is not valid.");
    }
    if (options.requireExecutionId !== false && (!context.executionId || context.executionId <= 0)) {
      throw new FinancialWriteDisabledError("Main Customer Invoice execution ledger is required.");
    }
    return;
  }
  if (context.assetPurchaseAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED !== "true" || context.workflowType !== "asset_purchase" ||
      !Number.isInteger(context.assetPurchaseAutomaticEventId) || context.assetPurchaseAutomaticEventId <= 0 || !context.assetPurchaseReleaseKey || !context.assetPurchaseApprovedBy ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete) {
      throw new FinancialWriteDisabledError("Asset purchase automatic release gate is not valid.");
    }
    if (options.requireExecutionId !== false && (!context.executionId || context.executionId <= 0)) {
      throw new FinancialWriteDisabledError("Asset purchase execution ledger is required.");
    }
    return;
  }
  if (context.customerSalePurchaseAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED !== "true" || context.workflowType !== "customer_sale_purchase" ||
      !Number.isInteger(context.customerSalePurchaseAutomaticEventId) || context.customerSalePurchaseAutomaticEventId <= 0 || !context.customerSalePurchaseReleaseKey || !context.customerSalePurchaseApprovedBy ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete) {
      throw new FinancialWriteDisabledError("Customer Sale purchase automatic release gate is not valid.");
    }
    if (options.requireExecutionId !== false && (!context.executionId || context.executionId <= 0)) {
      throw new FinancialWriteDisabledError("Customer Sale purchase execution ledger is required.");
    }
    return;
  }
  if (context.forHireAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED !== "true" || !["initial_for_hire", "recurring_for_hire"].includes(context.workflowType) ||
      !Number.isInteger(context.forHireAutomaticEventId) || context.forHireAutomaticEventId <= 0 || !context.forHireReleaseKey || !context.forHireApprovedBy ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete) {
      throw new FinancialWriteDisabledError("For Hire automatic release gate is not valid.");
    }
    if (options.requireExecutionId !== false && (!context.executionId || context.executionId <= 0)) {
      throw new FinancialWriteDisabledError("For Hire execution ledger is required.");
    }
    return;
  }
  if (context.storageAutomaticEventId !== undefined) {
    if (process.env.FINANCIAL_STORAGE_AUTOMATIC_ENABLED !== "true" || !["storage_activation", "recurring_storage", "storage_finalisation"].includes(context.workflowType) ||
      !Number.isInteger(context.storageAutomaticEventId) || context.storageAutomaticEventId <= 0 || !context.storageReleaseKey || !context.storageApprovedBy ||
      !context.currentDocumentPreflightPassed || !context.legacyWriterHandoffComplete) throw new FinancialWriteDisabledError("Storage automatic release gate is not valid.");
    if (options.requireExecutionId !== false && (!context.executionId || context.executionId <= 0)) throw new FinancialWriteDisabledError("Storage execution ledger is required.");
    return;
  }
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
  const guardedRows = payload.body.Invoices;
  if (payload.documentNumber === "INV-702946" && Array.isArray(guardedRows) && guardedRows.some(row => d702946ExistingDeductions(row).length) &&
    context.d702946DepositMainDeductionRecoveryEventId === undefined && context.d702946AuthorisedDepositMainDeductionRecoveryEventId === undefined)
    throw new FinancialWriteDisabledError("The D702946 recovery deduction body is reserved exclusively for its dedicated authorisation class.");
  if (context.d702946AuthorisedDepositMainDeductionRecoveryEventId !== undefined) {
    assertD702946AuthorisedDepositRecoveryPayload(payload);
    await verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess({ eventId: context.d702946AuthorisedDepositMainDeductionRecoveryEventId,
      token: context.d702946AuthorisedDepositMainDeductionRecoveryToken!, releaseKey: context.d702946AuthorisedDepositMainDeductionRecoveryReleaseKey!,
      preparedBy: context.d702946AuthorisedDepositMainDeductionRecoveryApprovedBy!, payload, executionId: context.executionId! });
    await consumeD702946AuthorisedDepositMainDeductionRecoveryPayload({ eventId: context.d702946AuthorisedDepositMainDeductionRecoveryEventId,
      token: context.d702946AuthorisedDepositMainDeductionRecoveryToken! }, context.executionId!);
  }
  if (context.d702946DepositMainDeductionRecoveryEventId !== undefined) {
    assertD702946RecoveryPayload(payload);
    await verifyD702946DepositMainDeductionRecoveryWriteAccess({ eventId: context.d702946DepositMainDeductionRecoveryEventId,
      token: context.d702946DepositMainDeductionRecoveryToken!, releaseKey: context.d702946DepositMainDeductionRecoveryReleaseKey!,
      preparedBy: context.d702946DepositMainDeductionRecoveryApprovedBy!, payload, executionId: context.executionId! });
    await consumeD702946DepositMainDeductionRecoveryPayload({ eventId: context.d702946DepositMainDeductionRecoveryEventId,
      token: context.d702946DepositMainDeductionRecoveryToken! }, context.executionId!);
  }
  if (/^INV-\d+-EH/i.test(payload.documentNumber) && context.extraHireAutomaticEventId === undefined) throw new FinancialWriteDisabledError("Extra Hire EH series requires its independent event claim; another family cannot create or amend it.");
  if (context.extraHireAutomaticEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const line = row && Array.isArray(row.LineItems) && row.LineItems.length === 1 ? row.LineItems[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/Invoices" || payload.documentFamily !== "customer_invoice" || payload.expectedXeroDocumentId ||
      !/^INV-\d{1,12}-EH[1-9]\d*$/.test(payload.documentNumber) || Object.keys(payload.body).length !== 1 || !row || row.InvoiceID || row.InvoiceNumber !== payload.documentNumber ||
      row.Type !== "ACCREC" || row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" || !row.Contact?.ContactID ||
      !row.Date || row.DueDate || !row.Reference || !line || !["20' Hire", "40' Hire"].includes(line.ItemCode) || line.Quantity !== 4.286 ||
      typeof line.UnitAmount !== "number" || !Number.isFinite(line.UnitAmount) || line.UnitAmount <= 0 || !String(line.AccountCode ?? "").trim() || line.TaxType !== "OUTPUT" ||
      line.Description !== `${line.ItemCode.replace(" Hire", "")} Extra Hire — ${row.Reference}`) {
      throw new FinancialWriteDisabledError("Extra Hire permits only one exact EH-series AUD Exclusive Draft ACCREC with a 4.286-week current hire item line; other creates/updates/POs are rejected.");
    }
    await verifyExtraHireAutomaticWriteAccess({ eventId: context.extraHireAutomaticEventId, releaseKey: context.extraHireReleaseKey!, preparedBy: context.extraHireApprovedBy!, payload });
    await consumeExtraHirePayload(context.extraHireAutomaticEventId, context.executionId!);
  }
  if (context.finalWeightAutomaticEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || !payload.expectedXeroDocumentId || payload.endpoint !== `/Invoices/${encodeURIComponent(payload.expectedXeroDocumentId)}` ||
      payload.documentFamily !== "customer_invoice" || !/^INV-\d{1,12}$/.test(payload.documentNumber) || Object.keys(payload.body).length !== 1 ||
      !row || row.InvoiceID !== payload.expectedXeroDocumentId || row.InvoiceNumber !== payload.documentNumber || row.Status !== "DRAFT" || row.Type !== "ACCREC" ||
      row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" || !row.Contact?.ContactID || !row.Date || !row.DueDate || !Array.isArray(row.LineItems) || !row.LineItems.length) {
      throw new FinancialWriteDisabledError("Final-weight permits only a specific existing exact AUD Exclusive Draft main invoice PUT; no create or other update type.");
    }
    if (!/^[a-f0-9]{64}$/.test(payload.idempotencyKey)) throw new FinancialWriteDisabledError("Final-weight exact deterministic payload key is required.");
    const input = { eventId: context.finalWeightAutomaticEventId, direction: context.finalWeightDirection!, releaseKey: context.finalWeightReleaseKey!, preparedBy: context.finalWeightApprovedBy!, payload };
    await verifyFinalWeightAutomaticWriteAccess(input);
    await consumeFinalWeightPayload(input, context.executionId!);
  }
  if (context.finalWeightReconciliationEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || !payload.expectedXeroDocumentId || payload.endpoint !== `/Invoices/${encodeURIComponent(payload.expectedXeroDocumentId)}` ||
      payload.documentFamily !== "customer_invoice" || !/^INV-\d{1,12}$/.test(payload.documentNumber) || Object.keys(payload.body).length !== 1 ||
      !row || row.InvoiceID !== payload.expectedXeroDocumentId || row.InvoiceNumber !== payload.documentNumber || row.Status !== "DRAFT" || row.Type !== "ACCREC" ||
      row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" || !row.Contact?.ContactID || !row.Date || !row.DueDate || !Array.isArray(row.LineItems) || !row.LineItems.length) {
      throw new FinancialWriteDisabledError("Final Weight reconciliation permits only one exact existing AUD Exclusive Draft POST recovery.");
    }
    const input = { eventId: context.finalWeightReconciliationEventId, token: context.finalWeightReconciliationToken!, releaseKey: context.finalWeightReconciliationReleaseKey!, preparedBy: context.finalWeightReconciliationApprovedBy!, payload };
    await verifyFinalWeightReconciliationWriteAccess(input);
    await consumeFinalWeightReconciliationPayload({ eventId: input.eventId, token: input.token }, context.executionId!);
  }
  if (context.finalWeightReconciliationRemediationEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || !payload.expectedXeroDocumentId || payload.endpoint !== `/Invoices/${encodeURIComponent(payload.expectedXeroDocumentId)}` ||
      payload.documentFamily !== "customer_invoice" || !/^INV-\d{1,12}$/.test(payload.documentNumber) || Object.keys(payload.body).length !== 1 ||
      !row || row.InvoiceID !== payload.expectedXeroDocumentId || row.InvoiceNumber !== payload.documentNumber || row.Status !== "DRAFT" || row.Type !== "ACCREC" ||
      row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" || !row.Contact?.ContactID || !row.Date || !row.DueDate || !Array.isArray(row.LineItems) || !row.LineItems.length) {
      throw new FinancialWriteDisabledError("Final Weight verifier-defect remediation permits only one exact existing AUD Exclusive Draft POST recovery.");
    }
    const input = { eventId: context.finalWeightReconciliationRemediationEventId, token: context.finalWeightReconciliationRemediationToken!, releaseKey: context.finalWeightReconciliationRemediationReleaseKey!, preparedBy: context.finalWeightReconciliationRemediationApprovedBy!, payload };
    await verifyFinalWeightReconciliationRemediationWriteAccess(input);
    await consumeFinalWeightReconciliationRemediationPayload({ eventId: input.eventId, token: input.token }, context.executionId!);
  }
  if (context.depositInvoiceReconciliationEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const line = row && Array.isArray(row.LineItems) && row.LineItems.length === 1 ? row.LineItems[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/Invoices" || payload.documentFamily !== "customer_invoice" || payload.expectedXeroDocumentId ||
      !/^INV-\d{1,12}-D$/.test(payload.documentNumber) || Object.keys(payload.body).length !== 1 || !row || row.InvoiceID || row.InvoiceNumber !== payload.documentNumber ||
      row.Type !== "ACCREC" || row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Inclusive" || !row.Contact?.ContactID ||
      !line || line.ItemCode !== "Deposit Required" || line.Quantity !== 1 || typeof line.UnitAmount !== "number" || !Number.isFinite(line.UnitAmount) || line.UnitAmount <= 0 ||
      String(line.AccountCode ?? "") !== "200" || line.TaxType !== "OUTPUT" || !/^Deposit for .+ from INV-\d{1,12}$/.test(String(line.Description ?? ""))) {
      throw new FinancialWriteDisabledError("Deposit reconciliation permits only one exact current AUD Inclusive Draft ACCREC -D POST; amendments and Deposit-to-main deductions are excluded.");
    }
    const input = { eventId: context.depositInvoiceReconciliationEventId, token: context.depositInvoiceReconciliationToken!, releaseKey: context.depositInvoiceReconciliationReleaseKey!, preparedBy: context.depositInvoiceReconciliationApprovedBy!, payload };
    await verifyDepositInvoiceReconciliationWriteAccess(input);
    await consumeDepositInvoiceReconciliationPayload({ eventId: input.eventId, token: input.token }, context.executionId!);
  }
  if (context.mainInvoiceReconciliationEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/Invoices" || payload.documentFamily !== "customer_invoice" || payload.expectedXeroDocumentId ||
      !/^INV-\d{1,12}$/.test(payload.documentNumber) || Object.keys(payload.body).length !== 1 || !row || row.InvoiceID ||
      row.InvoiceNumber !== payload.documentNumber || row.Type !== "ACCREC" || row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" ||
      row.LineAmountTypes !== "Exclusive" || !row.Contact?.ContactID || !Array.isArray(row.LineItems) || row.LineItems.length < 1 ||
      !row.LineItems.every(isPermittedMainCustomerInvoiceLineAccount)) {
      throw new FinancialWriteDisabledError("Main Customer Invoice reconciliation permits only one exact AUD Exclusive Draft ACCREC with the independently revalidated Main Invoice lines.");
    }
    const input = { eventId: context.mainInvoiceReconciliationEventId, token: context.mainInvoiceReconciliationToken!,
      releaseKey: context.mainInvoiceReconciliationReleaseKey!, preparedBy: context.mainInvoiceReconciliationApprovedBy!, payload };
    await verifyMainCustomerInvoiceReconciliationWriteAccess(input);
    await consumeMainCustomerInvoiceReconciliationPayload({ eventId: input.eventId, token: input.token }, context.executionId!);
  }
  if (/^INV-\d+-D$/i.test(payload.documentNumber) && context.depositInvoiceAutomaticEventId === undefined && context.depositInvoiceReconciliationEventId === undefined && context.depositDraftCorrectionKind === undefined) {
    throw new FinancialWriteDisabledError("Exact Deposit -D invoices require their independent Deposit release; another family cannot create or amend them.");
  }
  if (context.depositInvoiceAutomaticEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/Invoices" || payload.documentFamily !== "customer_invoice" || payload.expectedXeroDocumentId ||
      !/^INV-\d{1,12}-D$/.test(payload.documentNumber) || !row || row.InvoiceID || row.InvoiceNumber !== payload.documentNumber ||
      row.Status !== "DRAFT" || row.Type !== "ACCREC" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Inclusive" ||
      !row.Contact?.ContactID || !Array.isArray(row.LineItems) || row.LineItems.length !== 1 || !row.LineItems.every((line: any) =>
        line.ItemCode === "Deposit Required" && /^Deposit for .+ from INV-\d{1,12}$/.test(String(line.Description ?? "")) && line.Quantity === 1 && typeof line.UnitAmount === "number" &&
        Number.isFinite(line.UnitAmount) && line.UnitAmount > 0 && String(line.AccountCode ?? "") === "200" && line.TaxType === "OUTPUT")) {
      throw new FinancialWriteDisabledError("Deposit release permits only one new exact AUD Inclusive Draft ACCREC -D with the Operations Deposit Required line and account 200; amendments and deductions are excluded.");
    }
    await verifyDepositInvoiceAutomaticWriteAccess({ eventId: context.depositInvoiceAutomaticEventId, releaseKey: context.depositInvoiceReleaseKey!, preparedBy: context.depositInvoiceApprovedBy!, payload });
  }
  if (context.depositMainDeductionAutomaticEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const deductions = row && Array.isArray(row.LineItems) ? row.LineItems.filter((line: any) => /^Less deposit invoice INV-\d{1,12}-D$/.test(String(line?.Description ?? "")) && line.Quantity === 1 && Number(line.UnitAmount) < 0 && Number(line.LineAmount) < 0 && Number(line.TaxAmount) <= 0 && String(line.AccountCode) === "200" && line.TaxType === "OUTPUT") : [];
    if (payload.method !== "POST" || !payload.expectedXeroDocumentId || payload.endpoint !== `/Invoices/${encodeURIComponent(payload.expectedXeroDocumentId)}` ||
      payload.documentFamily !== "customer_invoice" || !/^INV-\d{1,12}$/.test(payload.documentNumber) || !row || row.InvoiceID !== payload.expectedXeroDocumentId || row.InvoiceNumber !== payload.documentNumber || row.Status !== "DRAFT" || row.Type !== "ACCREC" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" || !row.Contact?.ContactID || !row.Date || !Array.isArray(row.LineItems) || !row.LineItems.length || deductions.length !== 1) {
      throw new FinancialWriteDisabledError("Deposit-to-main release permits only one exact existing AUD Exclusive main Draft with one negative legacy Deposit deduction line.");
    }
  }
  if (context.depositDraftCorrectionKind !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (context.workflowType !== "deposit_draft_correction" || payload.method !== "POST" || !payload.expectedXeroDocumentId || payload.endpoint !== `/Invoices/${encodeURIComponent(payload.expectedXeroDocumentId)}` ||
      payload.documentFamily !== "customer_invoice" || !/^INV-\d{1,12}(?:-D)?$/.test(payload.documentNumber) || !row || row.InvoiceID !== payload.expectedXeroDocumentId || row.InvoiceNumber !== payload.documentNumber || row.Status !== "DRAFT" || row.Type !== "ACCREC" || row.CurrencyCode !== "AUD" || !row.Contact?.ContactID || !Array.isArray(row.LineItems) || !row.LineItems.length ||
      context.depositDraftCorrectionReleaseKey !== context.approvalReference || context.depositDraftCorrectionApprovedBy === undefined) {
      throw new FinancialWriteDisabledError("Deposit correction permits only one exact existing AUD Draft invoice resource with an immutable correction approval.");
    }
    if (context.depositDraftCorrectionKind === "deposit_description") {
      const line = row.LineItems.length === 1 ? row.LineItems[0] : null;
      if (!/-D$/.test(payload.documentNumber) || row.LineAmountTypes !== "Inclusive" || !line || line.ItemCode !== "Deposit Required" || line.Quantity !== 1 || !(typeof line.UnitAmount === "number" && line.UnitAmount > 0) || !/^Deposit for Q\d{1,12} from INV-\d{1,12}$/.test(String(line.Description ?? "")) || !String(line.Description).endsWith(`from ${payload.documentNumber.replace(/-D$/, "")}`)) {
        throw new FinancialWriteDisabledError("Deposit correction permits only the exact native Deposit description on its existing inclusive -D Draft.");
      }
    } else if (context.depositDraftCorrectionKind === "main_deduction") {
      const deductions = row.LineItems.filter((line: any) => line?.Description === `Deposit deduction — ${payload.documentNumber}-D` && line.Quantity === 1 && Number(line.UnitAmount) < 0 && String(line.AccountCode) === "200" && line.TaxType === "OUTPUT");
      if (!/^INV-\d{1,12}$/.test(payload.documentNumber) || row.LineAmountTypes !== "Exclusive" || deductions.length !== 1) {
        throw new FinancialWriteDisabledError("Deposit correction permits only one negative exclusive Deposit deduction line on the exact existing main Draft.");
      }
    } else {
      const deductions = row.LineItems.filter((line: any) => line?.Description === "Deposit deduction — INV-702933-D" && line.Quantity === 1 && Number(line.UnitAmount) === -454.55 && Number(line.LineAmount) === -454.55 && Number(line.TaxAmount) === -45.45 && String(line.AccountCode) === "200" && line.TaxType === "OUTPUT");
      if (context.depositDraftCorrectionKind !== "main_deduction_rounding" || payload.documentNumber !== "INV-702933" || row.LineAmountTypes !== "Exclusive" || deductions.length !== 1) {
        throw new FinancialWriteDisabledError("Deposit rounding correction permits only the approved -$45.45 tax override on the exact D702933 Draft deduction line.");
      }
    }
  }
  if (context.mainCustomerInvoiceAutomaticEventId !== undefined) {
    const rows = payload.body.Invoices;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/Invoices" || payload.documentFamily !== "customer_invoice" || payload.expectedXeroDocumentId ||
      !row || row.InvoiceID || row.InvoiceNumber !== payload.documentNumber || row.Status !== "DRAFT" || row.Type !== "ACCREC" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" ||
      !row.Contact?.ContactID || !row.Date ||
      !Array.isArray(row.LineItems) || row.LineItems.length < 1 || !row.LineItems.every(isPermittedMainCustomerInvoiceLineAccount)) {
      throw new FinancialWriteDisabledError("Main Customer Invoice automatic release permits only exact approved transport/itemless, Sale, or Hire sales-account line combinations.");
    }
    await verifyMainCustomerInvoiceAutomaticWriteAccess({
      eventId: context.mainCustomerInvoiceAutomaticEventId,
      releaseKey: context.mainCustomerInvoiceReleaseKey!,
      preparedBy: context.mainCustomerInvoiceApprovedBy!,
      token: context.mainCustomerInvoiceToken!,
      payload,
    });
  }
  if (context.assetPurchaseAutomaticEventId !== undefined) {
    const rows = payload.body.PurchaseOrders;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/PurchaseOrders" || payload.documentFamily !== "purchase_order" || payload.expectedXeroDocumentId ||
      !row || row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" ||
      !Array.isArray(row.LineItems) || row.LineItems.length !== 1 || !row.LineItems.every((line: any) => String(line.AccountCode) === "322")) {
      throw new FinancialWriteDisabledError("Asset automatic release permits only one exact AUD Draft Purchase Order with account 322.");
    }
    await verifyAssetPurchaseAutomaticWriteAccess({
      eventId: context.assetPurchaseAutomaticEventId,
      releaseKey: context.assetPurchaseReleaseKey!,
      preparedBy: context.assetPurchaseApprovedBy!,
      payload,
    });
  }
  if (context.customerSalePurchaseAutomaticEventId !== undefined) {
    const rows = payload.body.PurchaseOrders;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/PurchaseOrders" || payload.documentFamily !== "purchase_order" || payload.expectedXeroDocumentId ||
      !row || row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" ||
      !Array.isArray(row.LineItems) || row.LineItems.length !== 1 || !row.LineItems.every((line: any) => String(line.AccountCode) === "322")) {
      throw new FinancialWriteDisabledError("Customer Sale automatic release permits only one exact AUD Draft Purchase Order with account 322.");
    }
    await verifyCustomerSalePurchaseAutomaticWriteAccess({
      eventId: context.customerSalePurchaseAutomaticEventId,
      releaseKey: context.customerSalePurchaseReleaseKey!,
      preparedBy: context.customerSalePurchaseApprovedBy!,
      payload,
    });
  }
  if (context.forHireAutomaticEventId !== undefined) {
    const rows = payload.body.PurchaseOrders;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (payload.method !== "POST" || payload.endpoint !== "/PurchaseOrders" || payload.documentFamily !== "purchase_order" || payload.expectedXeroDocumentId ||
      !row || row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" ||
      !Array.isArray(row.LineItems) || row.LineItems.length < 1 || row.LineItems.length > 2 ||
      !row.LineItems.every((line: any) => String(line.AccountCode) === "312")) {
      throw new FinancialWriteDisabledError("For Hire automatic release permits only an exact AUD Draft Purchase Order with account 312 lines.");
    }
    await verifyForHireAutomaticWriteAccess({
      eventId: context.forHireAutomaticEventId,
      releaseKey: context.forHireReleaseKey!,
      preparedBy: context.forHireApprovedBy!,
      payload,
      workflowType: context.workflowType as "initial_for_hire" | "recurring_for_hire",
    });
  }
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
  if (context.storageAutomaticEventId !== undefined) {
    const rows = payload.documentFamily === "customer_invoice" ? payload.body.Invoices : payload.body.PurchaseOrders;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!row || row.Status !== "DRAFT" || row.LineAmountTypes !== "Exclusive" || row.CurrencyCode !== "AUD" ||
      (payload.documentFamily === "customer_invoice" && row.Type !== "ACCREC") ||
      !Array.isArray(row.LineItems) || row.LineItems.length !== 1 ||
      !row.LineItems.every((line: any) => ["200", "310", "311"].includes(String(line.AccountCode)))) throw new FinancialWriteDisabledError("Automatic storage is restricted to exact AUD Exclusive storage Draft payloads.");
    await verifyStorageAutomaticWriteAccess({ eventId: context.storageAutomaticEventId, releaseKey: context.storageReleaseKey!,
      preparedBy: context.storageApprovedBy!, payload, workflowType: context.workflowType });
  }
  const auth = await getXeroReadAuthWithRefresh();
  const operation = `${payload.method} financial-draft:${payload.documentFamily}:${payload.documentNumber}`;
  const response = await runXeroRequest<any>(auth, operation, async () => {
    if (context.d702946AuthorisedDepositMainDeductionRecoveryEventId !== undefined) {
      // Final fresh source/locks/full-Xero GETs and independently rebuilt V2 body immediately before the single POST.
      assertFinancialDraftWriteAuthorised(context);
      assertD702946AuthorisedDepositRecoveryPayload(payload);
      await verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess({ eventId: context.d702946AuthorisedDepositMainDeductionRecoveryEventId,
        token: context.d702946AuthorisedDepositMainDeductionRecoveryToken!, releaseKey: context.d702946AuthorisedDepositMainDeductionRecoveryReleaseKey!,
        preparedBy: context.d702946AuthorisedDepositMainDeductionRecoveryApprovedBy!, payload, executionId: context.executionId!, submitted: true });
    }
    if (context.d702946DepositMainDeductionRecoveryEventId !== undefined) {
      // Final fresh source/locks/full-Xero GETs and independently rebuilt body immediately before the single POST.
      assertFinancialDraftWriteAuthorised(context);
      assertD702946RecoveryPayload(payload);
      await verifyD702946DepositMainDeductionRecoveryWriteAccess({ eventId: context.d702946DepositMainDeductionRecoveryEventId,
        token: context.d702946DepositMainDeductionRecoveryToken!, releaseKey: context.d702946DepositMainDeductionRecoveryReleaseKey!,
        preparedBy: context.d702946DepositMainDeductionRecoveryApprovedBy!, payload, executionId: context.executionId!, submitted: true });
    }
    if (process.env.FINANCIAL_BILLING_PARTY_SYNC_ENABLED === "true" &&
      payload.documentFamily === "customer_invoice" && payload.expectedXeroDocumentId) {
      const { getBillingPartySyncPendingInvoiceLock } = await import("./financialBillingPartySyncDb");
      const pending = await getBillingPartySyncPendingInvoiceLock(payload.expectedXeroDocumentId);
      if (pending) throw new FinancialWriteDisabledError(
        "Exact invoice has a pending or uncertain billing-party update; reconcile its read-back before another Draft amendment."
      );
    }
    if (payload.documentFamily === "customer_invoice" && payload.expectedXeroDocumentId &&
      context.d702946DepositMainDeductionRecoveryEventId === undefined && context.d702946AuthorisedDepositMainDeductionRecoveryEventId === undefined) {
      const { getPendingD702946DepositMainDeductionRecovery } = await import("./financialD702946DepositMainDeductionRecoveryDb");
      const pending = await getPendingD702946DepositMainDeductionRecovery(payload.expectedXeroDocumentId);
      if (pending) throw new FinancialWriteDisabledError(
        "INV-702946 has a pending or uncertain dedicated Deposit deduction recovery; reconcile it before another Draft amendment."
      );
    }
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
  }, { retryTransientGatewayFailures: financialDraftWriteAllowsTransientRetry(context) });
  const result = responseDocument(payload, response.data);
  return {
    xeroDocumentId: result.returnedId,
    documentNumber: result.returnedNumber,
    status: "DRAFT",
    endpoint: payload.endpoint,
    idempotencyKey: payload.idempotencyKey,
  };
}
