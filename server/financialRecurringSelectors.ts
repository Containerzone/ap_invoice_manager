import { nextRecurringHirePoNumber, type ProposedFinancialDocument } from "./financialWorkflowEngine";
import { resolveFinancialAutomationRules, type FinancialAutomationRules } from "./financialAutomationRules";
import { preflightFinancialXeroIntents, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";

export type RecurringSelectorOutcome = "candidate" | "no_current_candidate" | "held";

export type RecurringForHireSelectorInput = {
  sourceRecordId: string;
  containerControlNumber: string;
  acquisition?: unknown;
  status?: unknown;
  containerType?: unknown;
  containerNumber?: unknown;
  collectionDate?: unknown;
  supplierName?: unknown;
  nextBillingDate?: unknown;
  lastVerifiedPeriodEnd?: unknown;
  existingDocumentNumbers?: string[];
  now?: Date;
  rules?: FinancialAutomationRules;
};

export type RecurringStorageSelectorInput = {
  storageBillingEventId: number | string;
  activationVerified: boolean;
  finalisationStatus: string;
  nextBillingDate?: unknown;
  billedThroughDate?: unknown;
  dealNumber?: unknown;
  containerNumber?: unknown;
  containerType?: unknown;
  customerName?: unknown;
  storageSupplierName?: unknown;
  hasApExecutionCollision?: boolean;
  hasXeroCollision?: boolean;
  now?: Date;
  rules?: FinancialAutomationRules;
};

export type RecurringSelectorCandidate = {
  outcome: RecurringSelectorOutcome;
  reason: string;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  intents: ProposedFinancialDocument[];
  xeroPreflight?: FinancialXeroPreflight[];
  noRecurringJdPo: true;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function upper(value: unknown): string {
  return text(value)?.toUpperCase() ?? "";
}

function date(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function supportedFeet(value: unknown): 20 | 40 | null {
  const normalized = upper(value);
  if (/\b20\b/.test(normalized)) return 20;
  if (/\b40\b/.test(normalized)) return 40;
  return null;
}

/** Uses Australia/Sydney calendar comparison rather than the server timezone. */
export function sydneyCalendarDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function sameOrBeforeSydney(left: Date, right: Date): boolean {
  return sydneyCalendarDate(left) <= sydneyCalendarDate(right);
}

function sameSydneyDay(left: Date, right: Date): boolean {
  return sydneyCalendarDate(left) === sydneyCalendarDate(right);
}

function empty(outcome: Exclude<RecurringSelectorOutcome, "candidate">, reason: string): RecurringSelectorCandidate {
  return { outcome, reason, billingPeriodStart: null, billingPeriodEnd: null, intents: [], noRecurringJdPo: true };
}

/**
 * Builds one, and only one, due recurring-hire proposal. No catch-up is allowed:
 * a prior billing period must have been verified and the next date must be due
 * today, not skipped into historical periods. It only produces a local proposal.
 */
export function selectRecurringForHireCandidate(input: RecurringForHireSelectorInput): RecurringSelectorCandidate {
  const rules = input.rules ?? resolveFinancialAutomationRules();
  const now = input.now ?? new Date();
  const acquisition = upper(input.acquisition);
  const status = upper(input.status);
  const feet = supportedFeet(input.containerType);
  const controlNumber = text(input.containerControlNumber);
  const containerNumber = text(input.containerNumber);
  const supplierName = text(input.supplierName);
  const collectionDate = date(input.collectionDate);
  const priorEnd = date(input.lastVerifiedPeriodEnd);
  const dueDate = date(input.nextBillingDate);

  if (acquisition !== rules.validation.recurringHireAcquisition) return empty("no_current_candidate", "Not a current FOR HIRE Container Control.");
  if (!rules.validation.allowedRecurringHireStatuses.includes(status)) return empty("no_current_candidate", "Status is not ON HIRE or IDLE.");
  if (!controlNumber || !feet || !containerNumber || !supplierName || !collectionDate) return empty("held", "Container Control requires number, supported 20/40-foot type, collection date, container number and hire supplier.");
  if (!priorEnd || !dueDate) return empty("held", "No verified previous 30-day period and specific next due date are available; AP will not infer or catch up hire history.");
  const expectedDueDate = addDays(priorEnd, 1);
  if (!sameSydneyDay(expectedDueDate, dueDate)) return empty("held", "The next billing date is not consecutive to the verified prior period; no gap or catch-up proposal is allowed.");
  if (!sameOrBeforeSydney(dueDate, now)) return empty("no_current_candidate", "The next consecutive 30-day period is not due yet.");
  // A date older than one period indicates a missed period. Do not backfill it.
  if (now.getTime() - dueDate.getTime() > 31 * 86_400_000) return empty("held", "The next due period is historical; no catch-up or bulk proposal is allowed.");

  const existing = input.existingDocumentNumbers ?? [];
  const documentNumber = nextRecurringHirePoNumber(controlNumber, existing);
  const periodEnd = addDays(dueDate, rules.defaults.recurringHireDays - 1);
  const itemCode = feet === 20 ? rules.itemCodes.recurringHire20 : rules.itemCodes.recurringHire40;
  const intent: ProposedFinancialDocument = {
    documentFamily: "purchase_order",
    documentType: "recurring_for_hire",
    proposedAction: "create_draft",
    proposedDocumentNumber: documentNumber,
    reference: controlNumber,
    partyName: supplierName,
    partySourceId: null,
    accountCode: rules.accounts.recurringHire,
    gstTreatment: "GST_EXCLUSIVE",
    currency: "AUD",
    subtotal: 0,
    taxAmount: 0,
    total: 0,
    issueDate: dueDate,
    dueDate: null,
    lineItems: [{ itemCode, description: `${containerNumber}, ${feet}' Container Extended Hire — ${sydneyCalendarDate(dueDate)} to ${sydneyCalendarDate(periodEnd)}`, quantity: rules.defaults.recurringHireDays, unitAmount: 0, lineAmount: 0, accountCode: rules.accounts.recurringHire, taxRate: rules.defaults.gstRatePercent, gstTreatment: "GST_EXCLUSIVE" }],
    sourceWorkflow: "recurring_for_hire",
    sourceRecordId: input.sourceRecordId,
    validationStatus: "held",
  };
  return { outcome: "candidate", reason: "One current next consecutive 30-day hire period is due. Xero GET-only item-rate and exact Draft/collision preflight are required before evidence.", billingPeriodStart: dueDate, billingPeriodEnd: periodEnd, intents: [intent], noRecurringJdPo: true };
}

/**
 * Enriches a recurring-hire candidate from the read-only Xero preflight. It
 * requires the current HC 20 E or HC 40 E purchase price and treats an existing
 * non-Draft exact PO as a hold. No source date or ledger state is advanced.
 */
export async function preflightRecurringForHireCandidate(candidate: RecurringSelectorCandidate): Promise<RecurringSelectorCandidate> {
  if (candidate.outcome !== "candidate" || candidate.intents.length !== 1) return candidate;
  const xeroPreflight = await preflightFinancialXeroIntents(candidate.intents);
  const preflight = xeroPreflight[0];
  const rate = preflight?.itemChecks[0]?.purchaseUnitPrice ?? null;
  const nonDraftCollision = preflight?.duplicateState === "found" && upper(preflight.status) !== "DRAFT";
  const collision = ["found", "ambiguous"].includes(preflight?.duplicateState ?? "");
  if (!preflight || rate === null || rate <= 0) return { ...candidate, outcome: "held", reason: "Current Xero HC 20 E / HC 40 E PurchaseDetails.UnitPrice is missing or unavailable; no recurring proposal is eligible.", xeroPreflight };
  if (collision || nonDraftCollision) return { ...candidate, outcome: "held", reason: "The exact recurring PO reference already exists or is non-Draft; it remains held without a suffix bypass.", xeroPreflight };
  const intent = candidate.intents[0]!;
  const line = intent.lineItems[0]!;
  const quantity = line.quantity;
  const unitAmount = rate;
  const subtotal = Number((quantity * unitAmount).toFixed(2));
  const taxAmount = Number((subtotal * 0.1).toFixed(2));
  return {
    ...candidate,
    reason: "GET-only Xero item rate and exact PO preflight are clear. Candidate remains disabled until separate activation and approval.",
    intents: [{ ...intent, subtotal, taxAmount, total: Number((subtotal + taxAmount).toFixed(2)), validationStatus: "valid", lineItems: [{ ...line, unitAmount, lineAmount: subtotal }] }],
    xeroPreflight,
  };
}

/**
 * Builds a recurring-storage proposal only from a verified local execution
 * event. It never discovers history from VTiger and intentionally returns only
 * a GD customer invoice plus a GD supplier PO (account 311): recurring JD is
 * structurally impossible here.
 */
export function selectRecurringStorageCandidate(input: RecurringStorageSelectorInput): RecurringSelectorCandidate {
  const rules = input.rules ?? resolveFinancialAutomationRules();
  const now = input.now ?? new Date();
  const nextBillingDate = date(input.nextBillingDate);
  const billedThrough = date(input.billedThroughDate);
  const feet = supportedFeet(input.containerType);
  const dealNumber = text(input.dealNumber);
  const customer = text(input.customerName);
  const supplier = text(input.storageSupplierName);
  const container = text(input.containerNumber);
  if (!input.activationVerified) return empty("no_current_candidate", "No verified AP activation/finalisation execution state exists for this storage event.");
  if (upper(input.finalisationStatus) !== "OPEN") return empty("no_current_candidate", "Storage event is finalised or not active.");
  if (!nextBillingDate || !billedThrough || !feet || !dealNumber || !customer || !supplier || !container) return empty("held", "Verified active storage event requires a next billing date, billed-through date, Deal, container/type, customer and storage supplier.");
  if (!sameSydneyDay(addDays(billedThrough, 1), nextBillingDate)) return empty("held", "Storage next billing date is not consecutive to verified billed-through date; no catch-up proposal is allowed.");
  if (!sameOrBeforeSydney(nextBillingDate, now)) return empty("no_current_candidate", "The verified next storage period is not due yet.");
  if (now.getTime() - nextBillingDate.getTime() > 31 * 86_400_000) return empty("held", "Storage next billing date is historical; no catch-up or bulk proposal is allowed.");
  if (input.hasApExecutionCollision || input.hasXeroCollision) return empty("held", "AP execution or exact Xero document collision exists for this billing period.");
  const periodEnd = addDays(nextBillingDate, 29);
  const digits = dealNumber.replace(/\D/g, "");
  if (!digits) return empty("held", "Storage event Deal reference has no numeric invoice/PO suffix.");
  const invoiceNumber = `INV-${digits}-S`;
  const poNumber = `GD${digits}`;
  const customerItem = feet === 20 ? rules.itemCodes.gd20 : rules.itemCodes.gd40;
  const customerRate = feet === 20 ? rules.rates.storageCustomer20Weekly : rules.rates.storageCustomer40Weekly;
  const supplierRate = feet === 20 ? rules.rates.storageSupplier20WeeklyExGst : rules.rates.storageSupplier40WeeklyExGst;
  const customerSubtotal = Number(customerRate.toFixed(2));
  const supplierSubtotal = Number(supplierRate.toFixed(2));
  const customerIntent: ProposedFinancialDocument = {
    documentFamily: "customer_invoice", documentType: "recurring_storage", proposedAction: "create_draft", proposedDocumentNumber: invoiceNumber, reference: `Storage ${input.storageBillingEventId}`, partyName: customer, partySourceId: null, accountCode: null, gstTreatment: "PENDING_CONFIGURATION", currency: "AUD", subtotal: customerSubtotal, taxAmount: 0, total: customerSubtotal, issueDate: nextBillingDate, dueDate: null,
    lineItems: [{ itemCode: customerItem, description: `${feet}' Container Storage — ${container}`, quantity: 1, unitAmount: customerRate, lineAmount: customerSubtotal, accountCode: "", taxRate: rules.defaults.gstRatePercent, gstTreatment: "GST_INCLUSIVE" }], sourceWorkflow: "recurring_storage", sourceRecordId: String(input.storageBillingEventId), validationStatus: "held",
  };
  const supplierIntent: ProposedFinancialDocument = {
    documentFamily: "purchase_order", documentType: "gd_storage", proposedAction: "create_draft", proposedDocumentNumber: poNumber, reference: `Storage ${input.storageBillingEventId}`, partyName: supplier, partySourceId: null, accountCode: rules.accounts.gdStorage, gstTreatment: "GST_EXCLUSIVE", currency: "AUD", subtotal: supplierSubtotal, taxAmount: Number((supplierSubtotal * 0.1).toFixed(2)), total: Number((supplierSubtotal * 1.1).toFixed(2)), issueDate: nextBillingDate, dueDate: null,
    lineItems: [{ itemCode: customerItem, description: `${feet}' Container Storage — ${container}`, quantity: 1, unitAmount: supplierRate, lineAmount: supplierSubtotal, accountCode: rules.accounts.gdStorage, taxRate: rules.defaults.gstRatePercent, gstTreatment: "GST_EXCLUSIVE" }], sourceWorkflow: "recurring_storage", sourceRecordId: String(input.storageBillingEventId), validationStatus: "valid",
  };
  return { outcome: "candidate", reason: "One verified active storage period is due. The disabled selector proposes only GD customer/supplier documents; recurring JD is excluded.", billingPeriodStart: nextBillingDate, billingPeriodEnd: periodEnd, intents: [customerIntent, supplierIntent], noRecurringJdPo: true };
}
