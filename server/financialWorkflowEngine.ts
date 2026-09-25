import { createHash } from "node:crypto";

export const FINANCIAL_WORKFLOW_TYPES = [
  "container_control_acquisition",
  "recurring_for_hire",
  "storage_activation",
  "recurring_storage",
  "storage_finalisation",
  "main_customer_invoice",
  "deposit_invoice",
  "final_weight_adjustment",
  "extra_hire",
  "warranty_reconciliation",
] as const;

export type FinancialWorkflowType = typeof FINANCIAL_WORKFLOW_TYPES[number];
export type FinancialTriggerType = "webhook" | "scheduled" | "manual" | "re_evaluation";
export type FinancialDocumentFamily = "purchase_order" | "customer_invoice";
export type ProposedAction = "create_draft" | "update_draft" | "validate_only" | "hold";
export type ValidationStatus = "valid" | "warning" | "held" | "invalid";

export type FinancialSourceData = Record<string, unknown>;

export type FinancialWorkflowInput = {
  workflowType: FinancialWorkflowType;
  triggerType: FinancialTriggerType;
  sourceRecordId?: string;
  sourceRecordNumber?: string;
  sourceRecordType?: string;
  /** Explicit event or re-evaluation marker; never derived from a secret. */
  idempotencySalt?: string;
  sourceData: FinancialSourceData;
  existingDocumentNumbers?: string[];
  now?: Date;
};

export type FinancialLineItem = {
  itemCode: string;
  description: string;
  quantity: number;
  unitAmount: number;
  lineAmount: number;
  accountCode: string;
  taxRate: number;
  gstTreatment: "GST_EXCLUSIVE" | "GST_INCLUSIVE";
};

export type ProposedFinancialDocument = {
  documentFamily: FinancialDocumentFamily;
  documentType: string;
  proposedAction: ProposedAction;
  proposedDocumentNumber: string | null;
  reference: string | null;
  partyName: string | null;
  partySourceId: string | null;
  accountCode: string | null;
  gstTreatment: "GST_EXCLUSIVE" | "GST_INCLUSIVE" | "PENDING_CONFIGURATION";
  currency: "AUD";
  subtotal: number;
  taxAmount: number;
  total: number;
  issueDate: Date | null;
  dueDate: Date | null;
  lineItems: FinancialLineItem[];
  sourceWorkflow: FinancialWorkflowType;
  sourceRecordId: string | null;
  validationStatus: ValidationStatus;
};

export type FinancialValidationIssue = {
  code: string;
  severity: "warning" | "error";
  title: string;
  details: string;
  documentIndex?: number;
};

export type FinancialWorkflowEvaluation = {
  workflowType: FinancialWorkflowType;
  mode: "shadow";
  idempotencyKey: string;
  sourceSummary: Record<string, unknown>;
  intents: ProposedFinancialDocument[];
  issues: FinancialValidationIssue[];
  outcome: "passed" | "warning" | "failed";
  safeRequestSummary: Record<string, unknown>;
};

const GST_RATE = 0.1;
const AUSTRALIA_TZ = "Australia/Sydney";

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalized(value: unknown): string {
  return asText(value)?.toUpperCase() ?? "";
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function digits(value: unknown): string {
  return (asText(value) ?? "").replace(/\D/g, "");
}

function containerFeet(value: unknown): 20 | 40 | null {
  const text = normalized(value);
  if (text.includes("20")) return 20;
  if (text.includes("40")) return 40;
  return null;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isoDate(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

function displayDate(date: Date | null): string {
  return date
    ? new Intl.DateTimeFormat("en-AU", { timeZone: AUSTRALIA_TZ, day: "2-digit", month: "short", year: "numeric" }).format(date)
    : "TBC";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createFinancialIdempotencyKey(input: Pick<FinancialWorkflowInput, "workflowType" | "sourceRecordId" | "sourceRecordNumber" | "sourceData" | "idempotencySalt">): string {
  const payload = stableJson({
    workflowType: input.workflowType,
    sourceRecordId: input.sourceRecordId ?? null,
    sourceRecordNumber: input.sourceRecordNumber ?? null,
    idempotencySalt: input.idempotencySalt ?? null,
    sourceData: input.sourceData,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function nextAvailableSuffix(baseNumber: string, existingNumbers: string[], reservedSuffixes: string[] = ["D"]): string {
  const upperExisting = new Set(existingNumbers.map((number) => number.trim().toUpperCase()));
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = `${baseNumber}-${suffix}`;
    if (!upperExisting.has(candidate.toUpperCase()) && !reservedSuffixes.includes(String(suffix).toUpperCase())) return candidate;
  }
  throw new Error(`Unable to find a free suffix for ${baseNumber}`);
}

export function nextRecurringHirePoNumber(containerControlNumber: string, existingNumbers: string[]): string {
  const base = `HC${containerControlNumber.replace(/\D/g, "")}`;
  const existing = new Set(existingNumbers.map((value) => value.trim().toUpperCase()));
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate.toUpperCase())) return candidate;
  }
  throw new Error(`Unable to find a free recurring-hire reference for ${containerControlNumber}`);
}

function emptyTotals(lineItems: FinancialLineItem[], gstTreatment: "GST_EXCLUSIVE" | "GST_INCLUSIVE" | "PENDING_CONFIGURATION") {
  const amount = money(lineItems.reduce((sum, item) => sum + item.lineAmount, 0));
  if (gstTreatment === "GST_INCLUSIVE") {
    const subtotal = money(amount / (1 + GST_RATE));
    return { subtotal, taxAmount: money(amount - subtotal), total: amount };
  }
  return { subtotal: amount, taxAmount: money(amount * GST_RATE), total: money(amount * (1 + GST_RATE)) };
}

function line(opts: Omit<FinancialLineItem, "lineAmount">): FinancialLineItem {
  return { ...opts, lineAmount: money(opts.quantity * opts.unitAmount) };
}

function makeIntent(
  input: FinancialWorkflowInput,
  values: Omit<ProposedFinancialDocument, "sourceWorkflow" | "sourceRecordId" | "subtotal" | "taxAmount" | "total">,
): ProposedFinancialDocument {
  const totals = emptyTotals(values.lineItems, values.gstTreatment);
  return {
    ...values,
    ...totals,
    sourceWorkflow: input.workflowType,
    sourceRecordId: input.sourceRecordId ?? null,
  };
}

function issue(
  issues: FinancialValidationIssue[],
  code: string,
  title: string,
  details: string,
  severity: "warning" | "error" = "error",
  documentIndex?: number,
): void {
  issues.push({ code, title, details, severity, documentIndex });
}

function requireValue(issues: FinancialValidationIssue[], value: unknown, name: string, documentIndex?: number): string | null {
  const text = asText(value);
  if (!text) issue(issues, "MISSING_SOURCE_DATA", `Missing ${name}`, `${name} is required before this financial document can be proposed.`, "error", documentIndex);
  return text;
}

function requireSupportedContainer(issues: FinancialValidationIssue[], type: unknown, documentIndex?: number): 20 | 40 | null {
  const feet = containerFeet(type);
  if (!feet) issue(issues, "UNSUPPORTED_CONTAINER_TYPE", "Unsupported container type", "Only valid 20-foot and 40-foot containers can be evaluated.", "error", documentIndex);
  return feet;
}

function party(source: FinancialSourceData, prefix: string): { name: string | null; id: string | null } {
  return {
    name: asText(source[`${prefix}OrganisationName`]) ?? asText(source[`${prefix}CustomerName`]) ?? asText(source[`${prefix}ContactName`]) ?? asText(source[`${prefix}Name`]),
    id: asText(source[`${prefix}XeroContactId`]) ?? asText(source[`${prefix}Id`]),
  };
}

function sourceSummary(input: FinancialWorkflowInput): Record<string, unknown> {
  return {
    sourceRecordId: input.sourceRecordId ?? null,
    sourceRecordNumber: input.sourceRecordNumber ?? null,
    sourceRecordType: input.sourceRecordType ?? null,
    triggerType: input.triggerType,
    mode: "shadow",
  };
}

function acquisition(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const controlNumber = requireValue(issues, source.containerControlNumber, "Container Control number");
  const stage = normalized(source.status ?? source.containerControlStatus);
  if (stage && stage !== "REQUEST") issue(issues, "UNEXPECTED_TRIGGER_STATUS", "Container Control is not at REQUEST", `Expected REQUEST but received ${stage}. The result remains shadow-only.`, "warning");
  const feet = requireSupportedContainer(issues, source.containerType);
  const collectionDate = asDate(source.collectionDate);
  if (!collectionDate) issue(issues, "MISSING_COLLECTION_DATE", "Missing Collection Date", "Collection Date is required for the initial hire period.");
  const supplier = party(source, "supplier");
  const hireSupplier = party(source, "hireSupplier");
  const intents: ProposedFinancialDocument[] = [];

  const createAcquisitionPo = (key: "asset" | "customerSale", prefix: "A" | "S", type: string) => {
    const amount = asNumber(source[`${key}AmountExGst`]);
    if (amount === null || amount <= 0) return;
    const selectedParty = key === "asset" ? supplier : party(source, "customerSaleSupplier");
    if (!selectedParty.name) issue(issues, "MISSING_SUPPLIER", `Missing ${type} supplier`, `${type} PO requires an allocated supplier.`, "error", intents.length);
    intents.push(makeIntent(input, {
      documentFamily: "purchase_order", documentType: type, proposedAction: "create_draft",
      proposedDocumentNumber: controlNumber ? `${prefix}${controlNumber}` : null, reference: controlNumber,
      partyName: selectedParty.name, partySourceId: selectedParty.id, accountCode: "322", gstTreatment: "GST_EXCLUSIVE",
      currency: "AUD", issueDate: null, dueDate: null,
      lineItems: [line({ itemCode: key === "asset" ? "Container Asset" : "Container Sale", description: `${type} — Container Control ${controlNumber ?? "TBC"}`, quantity: 1, unitAmount: amount, accountCode: "322", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })],
      validationStatus: selectedParty.name && controlNumber ? "valid" : "held",
    }));
  };
  createAcquisitionPo("asset", "A", "asset_purchase");
  createAcquisitionPo("customerSale", "S", "customer_sale");

  if (normalized(source.acquisition) === "FOR HIRE") {
    const cost = asNumber(source.hireCostExGst) ?? (feet === 20 ? 120 : feet === 40 ? 240 : null);
    if (cost === null) issue(issues, "MISSING_HIRE_COST", "Missing hire cost", "A valid 20-foot or 40-foot hire cost is required.", "error", intents.length);
    if (!hireSupplier.name) issue(issues, "MISSING_HIRE_SUPPLIER", "Missing hire supplier", "Initial For Hire PO requires an allocated supplier.", "error", intents.length);
    const end = collectionDate ? addDays(collectionDate, 30) : null;
    const footLabel = feet ? `${feet}'` : "Container";
    intents.push(makeIntent(input, {
      documentFamily: "purchase_order", documentType: "initial_for_hire", proposedAction: "create_draft",
      proposedDocumentNumber: controlNumber ? `H${controlNumber}` : null, reference: controlNumber,
      partyName: hireSupplier.name, partySourceId: hireSupplier.id, accountCode: "312", gstTreatment: "GST_EXCLUSIVE",
      currency: "AUD", issueDate: collectionDate, dueDate: null,
      lineItems: cost === null ? [] : [line({ itemCode: feet === 20 ? "HC 20" : "HC 40", description: `${footLabel} Container Hire from ${displayDate(collectionDate)} to ${displayDate(end)}`, quantity: 1, unitAmount: cost, accountCode: "312", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })],
      validationStatus: controlNumber && feet && collectionDate && hireSupplier.name && cost !== null ? "valid" : "held",
    }));
  }
  if (intents.length === 0) issue(issues, "NO_ACQUISITION_DOCUMENTS", "No acquisition cost was supplied", "No Asset, Customer Sale or initial For Hire PO can be proposed from the supplied source data.", "warning");
  return intents;
}

function recurringHire(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const controlNumber = requireValue(issues, source.containerControlNumber, "Container Control number");
  const acquisitionType = normalized(source.acquisition);
  const status = normalized(source.status ?? source.containerControlStatus);
  if (acquisitionType !== "FOR HIRE") issue(issues, "INELIGIBLE_ACQUISITION", "Recurring hire requires FOR HIRE acquisition", `Received ${acquisitionType || "blank"}.`, "error");
  if (!["ON HIRE", "IDLE"].includes(status)) issue(issues, "INELIGIBLE_CONTAINER_STATUS", "Container is not eligible for recurring hire", "Only ON HIRE and IDLE Container Controls are eligible; DEHIRED, REQUEST and READY are excluded.", "error");
  const feet = requireSupportedContainer(issues, source.containerType);
  const containerNumber = requireValue(issues, source.containerNumber, "Container Number");
  const periodStart = asDate(source.periodStart) ?? new Date(Date.UTC((input.now ?? new Date()).getUTCFullYear(), (input.now ?? new Date()).getUTCMonth() + 1, 1));
  const periodEnd = asDate(source.periodEnd) ?? addDays(periodStart, 29);
  const dailyRate = asNumber(source.purchaseDailyRateExGst);
  if (dailyRate === null || dailyRate <= 0) issue(issues, "MISSING_XERO_ITEM_RATE", "Missing Xero purchase-side daily rate", "Recurring For Hire must read the applicable daily rate from the Xero item at execution; supply it for this shadow evaluation.");
  const supplier = party(source, "supplier");
  if (!supplier.name) issue(issues, "MISSING_SUPPLIER", "Missing hire supplier", "Recurring For Hire PO requires an allocated supplier.");
  const poNumber = controlNumber ? nextRecurringHirePoNumber(controlNumber, input.existingDocumentNumbers ?? []) : null;
  return [makeIntent(input, {
    documentFamily: "purchase_order", documentType: "recurring_for_hire", proposedAction: "create_draft", proposedDocumentNumber: poNumber,
    reference: controlNumber, partyName: supplier.name, partySourceId: supplier.id, accountCode: "312", gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: periodStart, dueDate: null,
    lineItems: dailyRate === null || !feet ? [] : [line({ itemCode: feet === 20 ? "HC 20 E" : "HC 40 E", description: `${containerNumber ?? "Container TBC"}, ${feet}' Container Extended Hire per day rate from ${displayDate(periodStart)} to ${displayDate(periodEnd)}`, quantity: 30, unitAmount: dailyRate, accountCode: "312", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })],
    validationStatus: controlNumber && feet && containerNumber && supplier.name && dailyRate && acquisitionType === "FOR HIRE" && ["ON HIRE", "IDLE"].includes(status) ? "valid" : "held",
  })];
}

function storageActivation(input: FinancialWorkflowInput, issues: FinancialValidationIssue[], recurring = false): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const dealDigits = digits(input.sourceRecordNumber ?? source.dealNumber ?? source.dealId);
  if (!dealDigits) issue(issues, "MISSING_DEAL_NUMBER", "Missing Deal number", "Storage billing documents require a Deal number.");
  const feet = requireSupportedContainer(issues, source.containerType);
  const containerNumber = requireValue(issues, source.containerNumber, "Container Number");
  const customer = party(source, "customer");
  if (!customer.name) issue(issues, "MISSING_XERO_CUSTOMER", "Missing Xero customer", "Storage customer invoice requires the current organisation name or customer contact.");
  const dateIn = asDate(source.dateIn);
  if (!dateIn) issue(issues, "MISSING_DATE_IN", "Missing Date In", "Storage activation requires Date In.");
  const stage = requireValue(issues, source.storageStage, "storage stage");
  const transportSupplier = party(source, "transportSupplier");
  const storageSupplier = party(source, "storageSupplier");
  const customerWeeklyRate = asNumber(source.customerStorageWeeklyRate) ?? (feet === 20 ? 65 : feet === 40 ? 95 : null);
  const supplierWeeklyRate = asNumber(source.supplierStorageWeeklyRateExGst) ?? (feet === 20 ? 50 : feet === 40 ? 70 : null);
  const transportRate = asNumber(source.transportRateExGst) ?? (feet === 20 ? 275 : feet === 40 ? 375 : null);
  const baseInvoiceNumber = asText(source.storageInvoiceNumber) ?? (dealDigits ? `INV-${dealDigits}-S` : null);
  if (!asText(source.storageInvoiceNumber)) issue(issues, "STORAGE_INVOICE_REFERENCE_ASSUMED", "Storage invoice reference is provisional", "The plan does not specify a storage-invoice numbering rule; INV-<Deal>-S is displayed for shadow visibility only and must be confirmed in configuration before any cutover.", "warning");
  const customerItem = feet === 20 ? "GD 20" : "GD 40";
  const documents: ProposedFinancialDocument[] = [makeIntent(input, {
    documentFamily: "customer_invoice", documentType: recurring ? "recurring_storage" : "storage_activation", proposedAction: "create_draft", proposedDocumentNumber: baseInvoiceNumber,
    reference: `Storage ${stage ?? "TBC"}`, partyName: customer.name, partySourceId: customer.id, accountCode: null,
    gstTreatment: "PENDING_CONFIGURATION", currency: "AUD", issueDate: dateIn, dueDate: null,
    lineItems: customerWeeklyRate === null || !feet ? [] : [line({ itemCode: customerItem, description: `${feet}' Container Storage — ${containerNumber ?? "Container TBC"}`, quantity: 1, unitAmount: customerWeeklyRate, accountCode: "", taxRate: 10, gstTreatment: "GST_INCLUSIVE" })],
    validationStatus: customer.name && feet && containerNumber && dateIn && stage && customerWeeklyRate ? "warning" : "held",
  })];
  if (!recurring) {
    if (!transportSupplier.name) issue(issues, "MISSING_TRANSPORT_SUPPLIER", "Missing transport supplier", "JD storage activation PO requires an allocated transport supplier.", "error", documents.length);
    documents.push(makeIntent(input, {
      documentFamily: "purchase_order", documentType: "jd_transport", proposedAction: "create_draft", proposedDocumentNumber: dealDigits ? `JD${dealDigits}` : null,
      reference: `Storage ${stage ?? "TBC"}`, partyName: transportSupplier.name, partySourceId: transportSupplier.id, accountCode: "310", gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: dateIn, dueDate: null,
      lineItems: transportRate === null || !feet ? [] : [line({ itemCode: feet === 20 ? "JD 20" : "JD 40", description: `${feet}' Container transport to storage — ${containerNumber ?? "Container TBC"}`, quantity: 1, unitAmount: transportRate, accountCode: "310", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })],
      validationStatus: transportSupplier.name && feet && transportRate && dealDigits ? "valid" : "held",
    }));
  }
  if (!storageSupplier.name) issue(issues, "MISSING_STORAGE_SUPPLIER", "Missing storage supplier", "GD storage PO requires an allocated storage supplier.", "error", documents.length);
  documents.push(makeIntent(input, {
    documentFamily: "purchase_order", documentType: "gd_storage", proposedAction: "create_draft", proposedDocumentNumber: dealDigits ? `GD${dealDigits}` : null,
    reference: `Storage ${stage ?? "TBC"}`, partyName: storageSupplier.name, partySourceId: storageSupplier.id, accountCode: "311", gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: dateIn, dueDate: null,
    lineItems: supplierWeeklyRate === null || !feet ? [] : [line({ itemCode: feet === 20 ? "GD 20" : "GD 40", description: `${feet}' Container Storage — ${containerNumber ?? "Container TBC"}`, quantity: 1, unitAmount: supplierWeeklyRate, accountCode: "311", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })],
    validationStatus: storageSupplier.name && feet && supplierWeeklyRate && dealDigits ? "valid" : "held",
  }));
  return documents;
}

function storageFinalisation(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const eventId = requireValue(issues, source.storageBillingEventId, "storage billing event ID");
  const nonDraft = [source.customerInvoiceStatus, source.jdPoStatus, source.gdPoStatus].filter((status) => status && normalized(status) !== "DRAFT");
  if (nonDraft.length > 0) issue(issues, "NON_DRAFT_DOCUMENT_CONFLICT", "Storage finalisation cannot amend a non-Draft document", `Found non-Draft status: ${nonDraft.join(", ")}. Shadow mode will create an exception rather than amend it.`);
  const finalWeeks = asNumber(source.finalPeriodWeeks);
  if (finalWeeks === null || finalWeeks < 0) issue(issues, "MISSING_FINAL_PERIOD", "Missing final storage period", "A non-negative capped final period is required.");
  const recoveryRequested = source.recoverMissingDocuments === true;
  if (recoveryRequested) issue(issues, "CONTROLLED_RECOVERY_REQUIRES_REVIEW", "Missing-document recovery held", "Recovery is represented as a held shadow proposal until the existing controlled conditions are supplied and separately approved.", "warning");
  const action: ProposedAction = nonDraft.length > 0 || recoveryRequested ? "hold" : "update_draft";
  return [makeIntent(input, {
    documentFamily: "customer_invoice", documentType: "storage_finalisation", proposedAction: action, proposedDocumentNumber: asText(source.customerInvoiceNumber), reference: eventId,
    partyName: asText(source.customerName), partySourceId: asText(source.customerXeroContactId), accountCode: null, gstTreatment: "PENDING_CONFIGURATION", currency: "AUD", issueDate: null, dueDate: asDate(source.dateOut),
    lineItems: [], validationStatus: action === "update_draft" && finalWeeks !== null ? "warning" : "held",
  })];
}

function mainInvoice(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const dealDigits = digits(input.sourceRecordNumber ?? source.dealNumber ?? source.dealId);
  if (!dealDigits) issue(issues, "MISSING_DEAL_NUMBER", "Missing Deal number", "Main customer invoice requires a Deal number.");
  const customer = party(source, "customer");
  if (!customer.name) issue(issues, "MISSING_XERO_CUSTOMER", "Missing Xero customer", "Use organisation name before contact name for customer invoices.");
  const quoteLines = Array.isArray(source.quoteServiceLines) ? source.quoteServiceLines as Array<Record<string, unknown>> : [];
  if (quoteLines.length === 0) issue(issues, "MISSING_QUOTE_LINES", "Missing Quote Service lines", "Main invoice must be calculated from current VTiger Quote Service lines.");
  const lines = quoteLines.map((quoteLine, index) => {
    const amount = asNumber(quoteLine.amountExGst ?? quoteLine.amount) ?? 0;
    const quantity = asNumber(quoteLine.quantity) ?? 1;
    return line({ itemCode: asText(quoteLine.itemCode) ?? `QUOTE-${index + 1}`, description: asText(quoteLine.description) ?? "Quote Service", quantity, unitAmount: money(amount / quantity), accountCode: asText(quoteLine.accountCode) ?? "", taxRate: asNumber(quoteLine.taxRate) ?? 10, gstTreatment: "GST_EXCLUSIVE" });
  });
  return [makeIntent(input, {
    documentFamily: "customer_invoice", documentType: "main_customer_invoice", proposedAction: "create_draft", proposedDocumentNumber: dealDigits ? `INV-${dealDigits}` : null,
    reference: asText(source.quoteNumber), partyName: customer.name, partySourceId: customer.id, accountCode: null, gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: asDate(source.issueDate), dueDate: asDate(source.dueDate), lineItems: lines,
    validationStatus: dealDigits && customer.name && lines.length > 0 ? "valid" : "held",
  })];
}

function depositInvoice(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const dealDigits = digits(input.sourceRecordNumber ?? source.dealNumber ?? source.dealId);
  const depositStatus = normalized(source.depositStatus);
  const amount = asNumber(source.depositAmountRequired);
  if (depositStatus && depositStatus !== "PENDING") issue(issues, "INELIGIBLE_DEPOSIT_STATUS", "Deposit status is not blank or Pending", `Received ${depositStatus}.`);
  if (amount === null || amount <= 0) issue(issues, "INVALID_DEPOSIT_AMOUNT", "Deposit Amount Required must be positive", "No Draft deposit invoice will be proposed without a positive amount.");
  const customer = party(source, "customer");
  if (!customer.name) issue(issues, "MISSING_XERO_CUSTOMER", "Missing Xero customer", "Deposit invoice requires a customer.");
  const mainStatus = normalized(source.mainInvoiceStatus);
  if (mainStatus && mainStatus !== "DRAFT") issue(issues, "NON_DRAFT_MAIN_INVOICE", "Main invoice deduction is held", "The deposit can only adjust a Draft main invoice; no non-Draft main invoice will be amended.", "warning");
  return [makeIntent(input, {
    documentFamily: "customer_invoice", documentType: "deposit_invoice", proposedAction: "create_draft", proposedDocumentNumber: dealDigits ? `INV-${dealDigits}-D` : null,
    reference: asText(source.quoteNumber), partyName: customer.name, partySourceId: customer.id, accountCode: null, gstTreatment: "GST_INCLUSIVE", currency: "AUD", issueDate: asDate(source.issueDate), dueDate: asDate(source.dueDate),
    lineItems: amount === null || amount <= 0 ? [] : [line({ itemCode: "Deposit Required", description: "Deposit Required", quantity: 1, unitAmount: amount, accountCode: "", taxRate: 10, gstTreatment: "GST_INCLUSIVE" })],
    validationStatus: dealDigits && customer.name && amount && amount > 0 && (!depositStatus || depositStatus === "PENDING") ? (mainStatus && mainStatus !== "DRAFT" ? "warning" : "valid") : "held",
  })];
}

function finalWeight(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const dealDigits = digits(input.sourceRecordNumber ?? source.dealNumber ?? source.dealId);
  const direction = normalized(source.weightDirection);
  const mainStatus = normalized(source.mainInvoiceStatus);
  const mainNumber = asText(source.mainInvoiceNumber) ?? (dealDigits ? `INV-${dealDigits}` : null);
  if (!["OVERWEIGHT", "UNDERWEIGHT"].includes(direction)) issue(issues, "INVALID_WEIGHT_DIRECTION", "Weight direction must be OVERWEIGHT or UNDERWEIGHT", "No financial change can be proposed.");
  if (mainStatus !== "DRAFT") issue(issues, "NON_DRAFT_MAIN_INVOICE", "Final weight adjustment is held", "Final-weight workflow never updates a non-Draft main invoice.");
  const adjustment = asNumber(source.excessWeightAmountExGst);
  if (direction === "OVERWEIGHT" && (adjustment === null || adjustment <= 0)) issue(issues, "INVALID_EXCESS_WEIGHT_AMOUNT", "Overweight adjustment must be positive", "SER70 cannot be created from a missing or negative amount.");
  const dueDate = asDate(source.dueDate);
  if (direction === "UNDERWEIGHT" && !dueDate) issue(issues, "MISSING_DUE_DATE", "Underweight adjustment requires a due date", "Underweight must update only the due date and cannot create a negative weight line.");
  const editable = mainStatus === "DRAFT";
  return [makeIntent(input, {
    documentFamily: "customer_invoice", documentType: direction === "UNDERWEIGHT" ? "underweight_due_date" : "overweight_adjustment", proposedAction: editable ? "update_draft" : "hold", proposedDocumentNumber: mainNumber,
    reference: asText(source.quoteNumber), partyName: asText(source.customerName), partySourceId: asText(source.customerXeroContactId), accountCode: null, gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: null, dueDate: direction === "UNDERWEIGHT" ? dueDate : null,
    lineItems: direction === "OVERWEIGHT" && adjustment && adjustment > 0 ? [line({ itemCode: "SER70", description: asText(source.excessWeightDescription) ?? "Excess weight", quantity: 1, unitAmount: adjustment, accountCode: asText(source.accountCode) ?? "", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })] : [],
    validationStatus: editable && ((direction === "OVERWEIGHT" && adjustment && adjustment > 0) || (direction === "UNDERWEIGHT" && dueDate)) ? "valid" : "held",
  })];
}

function extraHire(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const dealDigits = digits(input.sourceRecordNumber ?? source.dealNumber ?? source.dealId);
  const hireDuration = asNumber(source.hireDurationDays);
  const hireEnd = asDate(source.hireEndDate);
  const feet = requireSupportedContainer(issues, source.containerType);
  const containerNumber = requireValue(issues, source.containerNumber, "Container Number");
  if (hireDuration !== 30) issue(issues, "INELIGIBLE_HIRE_DURATION", "Extra hire requires a 30-day Hire Duration", `Received ${hireDuration ?? "blank"} days.`);
  if (!hireEnd) issue(issues, "MISSING_HIRE_END_DATE", "Missing current Hire End Date", "Extra Hire must have a valid current Hire End Date.");
  const customer = party(source, "customer");
  if (!customer.name) issue(issues, "MISSING_XERO_CUSTOMER", "Missing Xero customer", "Extra Hire invoice requires a customer.");
  const baseNumber = dealDigits ? `INV-${dealDigits}` : null;
  const number = baseNumber ? nextAvailableSuffix(baseNumber, input.existingDocumentNumbers ?? [], ["D"]) : null;
  const weeklyRate = feet === 20 ? 45 : feet === 40 ? 70 : null;
  return [makeIntent(input, {
    documentFamily: "customer_invoice", documentType: "extra_hire", proposedAction: "create_draft", proposedDocumentNumber: number,
    reference: containerNumber, partyName: customer.name, partySourceId: customer.id, accountCode: "210", gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: hireEnd, dueDate: null,
    lineItems: weeklyRate === null || !feet ? [] : [line({ itemCode: feet === 20 ? "20' Hire" : "40' Hire", description: `${feet}' Extra Hire — ${containerNumber ?? "Container TBC"}`, quantity: 4.286, unitAmount: weeklyRate, accountCode: "210", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })],
    validationStatus: dealDigits && customer.name && hireDuration === 30 && hireEnd && feet && containerNumber ? "valid" : "held",
  })];
}

function warranty(input: FinancialWorkflowInput, issues: FinancialValidationIssue[]): ProposedFinancialDocument[] {
  const source = input.sourceData;
  const dealDigits = digits(input.sourceRecordNumber ?? source.dealNumber ?? source.dealId);
  const addedService = asText(source.addedService ?? source.warrantyAddedService);
  if (!addedService) issue(issues, "MISSING_ADDED_SERVICE", "Missing Added Services warranty", "Warranty reconciliation uses Added Services only; Warranty Confirmed is deliberately ignored.");
  const mapping = (source.warrantyMapping && typeof source.warrantyMapping === "object" ? source.warrantyMapping : null) as Record<string, unknown> | null;
  const itemCode = asText(mapping?.itemCode ?? source.warrantyItemCode);
  const premium = asNumber(mapping?.premiumExGst ?? source.warrantyPremiumExGst);
  const nativeDescription = asText(mapping?.nativeDescription ?? source.warrantyDescription);
  if (!itemCode || premium === null || premium <= 0 || !nativeDescription) issue(issues, "WARRANTY_MAPPING_REQUIRED", "Warranty mapping is incomplete", "Configure the WAR item code, native Xero description and GST-exclusive premium for the selected Added Services value.");
  const mainStatus = normalized(source.mainInvoiceStatus);
  const customer = party(source, "customer");
  const baseNumber = dealDigits ? `INV-${dealDigits}` : null;
  const invoiceNumber = mainStatus === "DRAFT" ? baseNumber : baseNumber ? nextAvailableSuffix(baseNumber, input.existingDocumentNumbers ?? [], ["D"]) : null;
  const customerAction: ProposedAction = mainStatus === "DRAFT" ? "update_draft" : "create_draft";
  if (mainStatus && mainStatus !== "DRAFT") issue(issues, "WARRANTY_NON_DRAFT_MAIN", "Warranty will use a separate Draft suffix invoice", "No replacement or amendment of a non-Draft main invoice is proposed.", "warning");
  const warrantyLine = itemCode && premium && nativeDescription ? [line({ itemCode, description: nativeDescription, quantity: 1, unitAmount: premium, accountCode: "", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" })] : [];
  const documents: ProposedFinancialDocument[] = [makeIntent(input, {
    documentFamily: "customer_invoice", documentType: "warranty_invoice", proposedAction: customerAction, proposedDocumentNumber: invoiceNumber,
    reference: addedService, partyName: customer.name, partySourceId: customer.id, accountCode: null, gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: asDate(source.issueDate), dueDate: asDate(source.dueDate), lineItems: warrantyLine,
    validationStatus: dealDigits && customer.name && warrantyLine.length > 0 ? (mainStatus && mainStatus !== "DRAFT" ? "warning" : "valid") : "held",
  })];
  const aviso = party(source, "avisoSupplier");
  const avisoName = aviso.name ?? "Aviso Broking Pty Ltd";
  documents.push(makeIntent(input, {
    documentFamily: "purchase_order", documentType: "aviso_warranty", proposedAction: "create_draft", proposedDocumentNumber: dealDigits ? `I${dealDigits}` : null,
    reference: addedService, partyName: avisoName, partySourceId: aviso.id, accountCode: "313", gstTreatment: "GST_EXCLUSIVE", currency: "AUD", issueDate: asDate(source.issueDate), dueDate: null, lineItems: warrantyLine.map((item) => ({ ...item, accountCode: "313" })),
    validationStatus: dealDigits && warrantyLine.length > 0 ? "valid" : "held",
  }));
  return documents;
}

export function evaluateFinancialWorkflow(input: FinancialWorkflowInput): FinancialWorkflowEvaluation {
  const issues: FinancialValidationIssue[] = [];
  let intents: ProposedFinancialDocument[];
  switch (input.workflowType) {
    case "container_control_acquisition": intents = acquisition(input, issues); break;
    case "recurring_for_hire": intents = recurringHire(input, issues); break;
    case "storage_activation": intents = storageActivation(input, issues, false); break;
    case "recurring_storage": intents = storageActivation(input, issues, true); break;
    case "storage_finalisation": intents = storageFinalisation(input, issues); break;
    case "main_customer_invoice": intents = mainInvoice(input, issues); break;
    case "deposit_invoice": intents = depositInvoice(input, issues); break;
    case "final_weight_adjustment": intents = finalWeight(input, issues); break;
    case "extra_hire": intents = extraHire(input, issues); break;
    case "warranty_reconciliation": intents = warranty(input, issues); break;
  }
  const hasErrors = issues.some((entry) => entry.severity === "error");
  const hasWarnings = issues.some((entry) => entry.severity === "warning") || intents.some((intent) => intent.validationStatus === "warning");
  const outcome = hasErrors ? "failed" : hasWarnings ? "warning" : "passed";
  const summary = sourceSummary(input);
  return {
    workflowType: input.workflowType,
    mode: "shadow",
    idempotencyKey: createFinancialIdempotencyKey(input),
    sourceSummary: summary,
    intents,
    issues,
    outcome,
    safeRequestSummary: {
      ...summary,
      proposedDocumentCount: intents.length,
      proposedNumbers: intents.map((intent) => intent.proposedDocumentNumber),
      xeroWritePermitted: false,
      liveModePermitted: false,
      sourceDates: { now: isoDate(input.now ?? new Date()) },
    },
  };
}
