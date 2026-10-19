import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { FinancialLineItem, ProposedFinancialDocument } from "./financialWorkflowEngine";

export const MAIN_CUSTOMER_INVOICE_ACCOUNT_CODE = "200" as const;
export const MAIN_CUSTOMER_INVOICE_RULES_VERSION = "main-customer-invoice-v7-optional-pickup-date-operations-fallback" as const;
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
  /** VTiger Container Situation (Select One), re-read from the current Deal. */
  containerSituation: string;
  /** Current Deal Origin Suburb; never sourced from the webhook body. */
  originSuburb: string;
  /** Current Deal Destination Suburb; never sourced from the webhook body. */
  destinationSuburb: string;
  /** Current Potentials Full Container Pickup DATE, after metadata-confirmed mapping. */
  fullContainerPickupDate: string;
  /** Current Potentials Deposit Status, after metadata-confirmed mapping. */
  depositStatus: string;
  /** Exact current Potentials custom-field API names used for date/status facts. */
  mappingEvidence: Record<string, string>;
  /** Schema/scalar/date evidence failure; the proposal must remain held. */
  sourceHoldReason: string | null;
  sourceRefreshedAt: string | null;
  serviceLines: MainCustomerInvoiceServiceLineFacts[];
};

export type MainCustomerInvoicePreview = {
  eligible: boolean;
  holdReason: string | null;
  proposedInvoiceNumber: string | null;
  document: ProposedFinancialDocument | null;
};

export type MainCustomerInvoiceTransportItemCode = "SER9" | "SER60";
export type MainCustomerInvoiceContainerSaleItemCode = "20' Sale" | "40' Sale";
export type MainCustomerInvoiceContainerHireItemCode = "20' Hire" | "40' Hire";

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normal(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function upper(value: string): string {
  return normal(value).toUpperCase();
}

/**
 * Accept the date-only representation returned by VTiger plus the requested
 * Australian display/input representations. This never delegates ambiguous
 * locale parsing to JavaScript and therefore rejects rollover dates.
 */
export function mainCustomerInvoiceBusinessDate(value: string): Temporal.PlainDate | null {
  const raw = value.trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const australian = raw.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  const normalized = iso
    ? `${iso[1]}-${iso[2]}-${iso[3]}`
    : australian
      ? `${australian[3]!.length === 2 ? `20${australian[3]}` : australian[3]}-${australian[2]}-${australian[1]}`
      : null;
  if (!normalized) return null;
  try {
    return Temporal.PlainDate.from(normalized, { overflow: "reject" });
  } catch {
    return null;
  }
}

function xeroBusinessDate(value: Temporal.PlainDate): Date {
  // A VTiger date field has no time or offset.  Retain that calendar date in
  // Xero's Date/Date UTC transport representation rather than applying host
  // or UTC-instant arithmetic.
  return new Date(`${value.toString()}T00:00:00.000Z`);
}

/** The original Operations Main Invoice uses its Sydney creation day when no pickup date is available. */
function sydneyBusinessDate(now: Date): Temporal.PlainDate {
  const date = Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO("Australia/Sydney")
    .toPlainDate();
  return date;
}

/**
 * The mapping is deliberately restricted to the current VTiger picklist values.
 * IMPORT and any new/unknown value must hold rather than silently choosing the
 * hired/purchased sales item.
 */
export function mainCustomerInvoiceTransportItemCode(containerSituation: string): MainCustomerInvoiceTransportItemCode | null {
  const situation = upper(containerSituation);
  if (situation === "SHIPPER OWN") return "SER9";
  if (situation === "PURCHASED" || situation === "HIRED") return "SER60";
  return null;
}

/**
 * Transport presentation applies only to an explicitly transport-named Quote
 * service. A container-sale or other Quote line must never inherit the route
 * wording just because the Deal also has a transport leg.
 */
export function isMainCustomerInvoiceTransportService(description: string): boolean {
  return /^TRANSPORT(?:\s|[-–—]|$)/i.test(normal(description));
}

/**
 * Select a Sale item only for an identifiable container product. A hire service
 * is a Quote-controlled customer line: it retains its Quote description and
 * does not inherit a Sale item or a transport item by inference.
 */
export function mainCustomerInvoiceContainerSaleItemCode(description: string): MainCustomerInvoiceContainerSaleItemCode | null {
  const value = upper(description);
  if (!value.includes("CONTAINER") || /\bHIRE(?:D)?\b/.test(value)) return null;
  if (/^20\b/.test(value) || value.includes("20 FOOT")) return "20' Sale";
  if (/^40\b/.test(value) || value.includes("40 FOOT")) return "40' Sale";
  return null;
}

/**
 * Current Xero evidence confirms these active sales items: 20' Hire (name
 * "20 Foot Hire") and 40' Hire (name "40 foot hire"). Only a Quote Service
 * that explicitly describes a 20/40-foot container hire can select either
 * item. The service description remains the financial-document description.
 */
export function mainCustomerInvoiceContainerHireItemCode(description: string): MainCustomerInvoiceContainerHireItemCode | null {
  const value = upper(description);
  if (!value.includes("CONTAINER") || !/\bHIRE(?:D)?\b/.test(value)) return null;
  if (/(?:^|\s)20(?:\s*FOOT|\s*')/.test(value)) return "20' Hire";
  if (/(?:^|\s)40(?:\s*FOOT|\s*')/.test(value)) return "40' Hire";
  return null;
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

/**
 * Renders the native Xero sales-item description only when it exposes the two
 * intended route placeholders. The exact native prefix/capitalisation is kept;
 * AP substitutes the freshly re-read Deal suburbs and never invents wording.
 */
export function renderMainCustomerInvoiceRouteDescription(input: {
  nativeDescription: string;
  originSuburb: string;
  destinationSuburb: string;
}): string | null {
  const template = normal(input.nativeDescription);
  const origin = normal(input.originSuburb);
  const destination = normal(input.destinationSuburb);
  if (!template || !origin || !destination) return null;
  const rendered = template.replace(/<>\s+to\s+<>/i, `${origin} to ${destination}`);
  if (rendered === template || rendered.includes("<>")) return null;
  return rendered;
}

function toFinancialLine(line: MainCustomerInvoiceServiceLineFacts, transportItemCode: MainCustomerInvoiceTransportItemCode | null): FinancialLineItem {
  const isTransport = isMainCustomerInvoiceTransportService(line.description);
  const itemCode = isTransport
    ? transportItemCode
    : mainCustomerInvoiceContainerHireItemCode(line.description) ?? mainCustomerInvoiceContainerSaleItemCode(line.description);
  return {
    // Only a transport description is temporary: it is rendered from the
    // current native Xero route template before writing. Other lines retain the
    // exact current Quote service name.
    itemCode: itemCode ?? "",
    description: isTransport ? `Pending current Xero ${transportItemCode} route description` : normal(line.description),
    quantity: line.quantity,
    unitAmount: money(line.unitAmount),
    lineAmount: money(line.quantity * line.unitAmount),
    accountCode: MAIN_CUSTOMER_INVOICE_ACCOUNT_CODE,
    taxRate: 10,
    gstTreatment: "GST_EXCLUSIVE",
  };
}

/** Replaces only SER9/SER60 transport-line descriptions with the current Xero template. */
export function applyMainCustomerInvoiceXeroTransportDescription(input: {
  document: ProposedFinancialDocument;
  nativeDescription: string;
  originSuburb: string;
  destinationSuburb: string;
}): ProposedFinancialDocument | null {
  if (input.document.documentType !== "main_customer_invoice") return null;
  const description = renderMainCustomerInvoiceRouteDescription(input);
  if (!description || !input.document.lineItems.length) return null;
  const transportCodes = new Set(["SER9", "SER60"]);
  if (!input.document.lineItems.some((line) => transportCodes.has(line.itemCode))) return input.document;
  return {
    ...input.document,
    lineItems: input.document.lineItems.map((line) => transportCodes.has(line.itemCode) ? { ...line, description } : line),
  };
}

/**
 * Builds exactly one Draft ACCREC proposal from re-read Deal, Quote and Service
 * evidence. Warranty is intentionally excluded: it has a separately guarded
 * lifecycle and must not be inferred or bundled during Main Invoice migration.
 */
export function buildMainCustomerInvoice(facts: MainCustomerInvoiceFacts, now = new Date()): MainCustomerInvoicePreview {
  if (facts.sourceHoldReason) {
    return { eligible: false, holdReason: facts.sourceHoldReason, proposedInvoiceNumber: null, document: null };
  }
  const pickupDate = facts.fullContainerPickupDate.trim();
  const pickupBusinessDate = pickupDate ? mainCustomerInvoiceBusinessDate(pickupDate) : null;
  if (pickupDate && !pickupBusinessDate) {
    return { eligible: false, holdReason: "When provided, Full Container Pickup DATE must be a valid DD/MM/YY or DD/MM/YYYY business date.", proposedInvoiceNumber: null, document: null };
  }
  if (!/^\d+x\d+$/i.test(facts.dealId) || !facts.dealNumber.trim()) {
    return { eligible: false, holdReason: "A current VTiger Deal ID and Deal number are required.", proposedInvoiceNumber: null, document: null };
  }
  if (!/^\d+x\d+$/i.test(facts.quoteId) || !facts.quoteNumber.trim()) {
    return { eligible: false, holdReason: "A current linked VTiger Quote is required.", proposedInvoiceNumber: null, document: null };
  }
  if (!/^\d+x\d+$/i.test(facts.customerVtigerId) || !normal(facts.customerName)) {
    return { eligible: false, holdReason: "A current Deal or Quote customer organisation/contact is required.", proposedInvoiceNumber: null, document: null };
  }
  const hasTransportLine = facts.serviceLines.some((line) => isMainCustomerInvoiceTransportService(line.description));
  const transportItemCode = hasTransportLine ? mainCustomerInvoiceTransportItemCode(facts.containerSituation) : null;
  if (hasTransportLine && !transportItemCode) {
    return { eligible: false, holdReason: "Current Deal Container Situation must be exactly SHIPPER OWN, PURCHASED or HIRED for the Main Invoice transport item.", proposedInvoiceNumber: null, document: null };
  }
  if (hasTransportLine && (!normal(facts.originSuburb) || !normal(facts.destinationSuburb))) {
    return { eligible: false, holdReason: "Current Deal Origin Suburb and Destination Suburb are required for the Main Invoice transport description.", proposedInvoiceNumber: null, document: null };
  }
  if (!facts.serviceLines.length || facts.serviceLines.some((line) => !validServiceLine(line))) {
    return { eligible: false, holdReason: "The linked VTiger Quote requires one or more current billable Service line items with quantity and list price.", proposedInvoiceNumber: null, document: null };
  }
  // A supplied pickup date remains the source for Date and DueDate. Where it
  // is absent, preserve Operations behaviour: create the Main Invoice on the
  // current Sydney business date and omit DueDate rather than inventing one.
  const issueDate = xeroBusinessDate(pickupBusinessDate ?? sydneyBusinessDate(now));
  const dueDate = pickupBusinessDate
    ? xeroBusinessDate(pickupBusinessDate.add({ days: upper(facts.depositStatus) === "ON ACCOUNT" ? 14 : 2 }))
    : null;
  const lineItems = facts.serviceLines.map((line) => toFinancialLine(line, transportItemCode));
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
      dueDate,
      lineItems,
      sourceWorkflow: "main_customer_invoice",
      sourceRecordId: facts.dealId,
      validationStatus: "valid",
    },
  };
}
