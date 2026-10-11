import { createHash } from "node:crypto";
import type { FinancialLineItem, ProposedFinancialDocument } from "./financialWorkflowEngine";

export const MAIN_CUSTOMER_INVOICE_ACCOUNT_CODE = "200" as const;
export const MAIN_CUSTOMER_INVOICE_RULES_VERSION = "main-customer-invoice-v1-operations-aligned" as const;
export const MAIN_CUSTOMER_INVOICE_RULES_HASH = createHash("sha256").update(MAIN_CUSTOMER_INVOICE_RULES_VERSION).digest("hex");

export type MainCustomerInvoiceServiceLineFacts = {
  serviceVtigerId: string;
  description: string;
  quantity: number;
  unitAmount: number;
};

export type MainCustomerInvoiceFacts = {
  dealId: string;
  dealNumber: string;
  quoteId: string;
  quoteNumber: string;
  customerVtigerId: string;
  customerName: string;
  customerKind: "organisation" | "contact";
  sourceRefreshedAt: string | null;
  serviceLines: MainCustomerInvoiceServiceLineFacts[];
};

export type MainCustomerInvoicePreview = {
  eligible: boolean;
  holdReason: string | null;
  proposedInvoiceNumber: string | null;
  document: ProposedFinancialDocument | null;
};

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normal(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function validServiceLine(line: MainCustomerInvoiceServiceLineFacts): boolean {
  return /^\d+x\d+$/i.test(line.serviceVtigerId)
    && Boolean(normal(line.description))
    && Number.isFinite(line.quantity) && line.quantity > 0
    && Number.isFinite(line.unitAmount) && line.unitAmount >= 0;
}

export function mainCustomerInvoiceNumber(dealNumber: string): string {
  return `INV-${dealNumber.replace(/^D/i, "").trim()}`;
}

function toFinancialLine(line: MainCustomerInvoiceServiceLineFacts): FinancialLineItem {
  const description = normal(line.description);
  return {
    // Operations resolves a current VTiger Service to its human description.
    // Do not infer an Xero ItemCode; a free-text customer line is safer than a
    // mismapped Xero item and the source service ID remains in the evidence hash.
    itemCode: "",
    description,
    quantity: line.quantity,
    unitAmount: money(line.unitAmount),
    lineAmount: money(line.quantity * line.unitAmount),
    accountCode: MAIN_CUSTOMER_INVOICE_ACCOUNT_CODE,
    taxRate: 10,
    gstTreatment: "GST_EXCLUSIVE",
  };
}

/**
 * Builds exactly one Draft ACCREC proposal from re-read Deal, Quote and Service
 * evidence. Warranty is intentionally excluded: it has a separately guarded
 * lifecycle and must not be inferred or bundled during Main Invoice migration.
 */
export function buildMainCustomerInvoice(facts: MainCustomerInvoiceFacts, now = new Date()): MainCustomerInvoicePreview {
  if (!/^\d+x\d+$/i.test(facts.dealId) || !facts.dealNumber.trim()) {
    return { eligible: false, holdReason: "A current VTiger Deal ID and Deal number are required.", proposedInvoiceNumber: null, document: null };
  }
  if (!/^\d+x\d+$/i.test(facts.quoteId) || !facts.quoteNumber.trim()) {
    return { eligible: false, holdReason: "A current linked VTiger Quote is required.", proposedInvoiceNumber: null, document: null };
  }
  if (!/^\d+x\d+$/i.test(facts.customerVtigerId) || !normal(facts.customerName)) {
    return { eligible: false, holdReason: "A current Deal or Quote customer organisation/contact is required.", proposedInvoiceNumber: null, document: null };
  }
  if (!facts.serviceLines.length || facts.serviceLines.some((line) => !validServiceLine(line))) {
    return { eligible: false, holdReason: "The linked VTiger Quote requires one or more current billable Service line items with quantity and list price.", proposedInvoiceNumber: null, document: null };
  }
  const issueDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const lineItems = facts.serviceLines.map(toFinancialLine);
  const subtotal = money(lineItems.reduce((total, line) => total + line.lineAmount, 0));
  const invoiceNumber = mainCustomerInvoiceNumber(facts.dealNumber);
  return {
    eligible: true,
    holdReason: null,
    proposedInvoiceNumber: invoiceNumber,
    document: {
      documentFamily: "customer_invoice",
      documentType: "main_customer_invoice",
      proposedAction: "create_draft",
      proposedDocumentNumber: invoiceNumber,
      reference: facts.quoteNumber,
      partyName: normal(facts.customerName),
      partySourceId: null,
      accountCode: MAIN_CUSTOMER_INVOICE_ACCOUNT_CODE,
      gstTreatment: "GST_EXCLUSIVE",
      currency: "AUD",
      subtotal,
      taxAmount: money(subtotal * 0.1),
      total: money(subtotal * 1.1),
      issueDate,
      dueDate: null,
      lineItems,
      sourceWorkflow: "main_customer_invoice",
      sourceRecordId: facts.dealId,
      validationStatus: "valid",
    },
  };
}
