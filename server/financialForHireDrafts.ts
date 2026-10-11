import { Temporal } from "@js-temporal/polyfill";
import type { FinancialLineItem, ProposedFinancialDocument } from "./financialWorkflowEngine";

export type ForHireContainerControlFacts = {
  recordId: string;
  controlNumber: string;
  acquisition: string;
  status: string;
  containerNumber: string;
  containerType: string;
  collectionDate: string;
  supplierVtigerId: string;
  supplierName: string;
  monthlyCostInclusive: number | null;
  purchasePriceInclusive: number | null;
  liftAndBookingFeesInclusive: number | null;
  sourceRefreshedAt: string | null;
};

export type ForHirePoPreview = {
  kind: "initial" | "recurring";
  eligible: boolean;
  holdReason: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  proposedPoNumber: string | null;
  document: ProposedFinancialDocument | null;
  itemNativeDescription: string | null;
};

const GST_RATE = 0.1;
const ACCOUNT_CODE = "312";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalized(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, " ");
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function inclusiveToExclusive(value: number): number {
  return money(value / (1 + GST_RATE));
}

function feet(value: unknown): 20 | 40 | null {
  const candidate = normalized(value);
  if (/\b20\b/.test(candidate)) return 20;
  if (/\b40\b/.test(candidate)) return 40;
  return null;
}

function plainDate(value: unknown): Temporal.PlainDate | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Temporal.PlainDate.from(raw);
    const match = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (match) return Temporal.PlainDate.from({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) });
  } catch {
    return null;
  }
  return null;
}

function plainToUtc(value: Temporal.PlainDate): Date {
  return new Date(`${value.toString()}T00:00:00.000Z`);
}

export function formatForHireDate(value: string): string {
  const parsed = plainDate(value);
  if (!parsed) return "Invalid date";
  return `${String(parsed.day).padStart(2, "0")}/${String(parsed.month).padStart(2, "0")}/${String(parsed.year % 100).padStart(2, "0")}`;
}

export function forHireInitialReference(controlNumber: string): string {
  const safe = text(controlNumber);
  if (!safe) throw new Error("A Container Control number is required for the initial For Hire reference.");
  return `H${safe}`;
}

/** Returns the only consecutive extension reference; callers must preflight this exact number. */
export function forHireExtensionReference(controlNumber: string, lastVerifiedExtensionSuffix: number | null): string {
  const initial = forHireInitialReference(controlNumber);
  const next = lastVerifiedExtensionSuffix === null ? 2 : lastVerifiedExtensionSuffix + 1;
  if (!Number.isInteger(next) || next < 2) throw new Error("For Hire extension sequence is invalid.");
  return `${initial}-${next}`;
}

function commonEligibility(facts: ForHireContainerControlFacts): { feet: 20 | 40 | null; collection: Temporal.PlainDate | null; reason: string | null } {
  if (normalized(facts.acquisition) !== "FOR HIRE") return { feet: null, collection: null, reason: "Container Control acquisition is not FOR HIRE." };
  const containerFeet = feet(facts.containerType);
  if (!containerFeet) return { feet: null, collection: null, reason: "Only 20-foot and 40-foot Container Controls are eligible." };
  const collection = plainDate(facts.collectionDate);
  if (!collection) return { feet: containerFeet, collection: null, reason: "Collection Date is missing or invalid." };
  if (!text(facts.controlNumber) || !text(facts.recordId)) return { feet: containerFeet, collection, reason: "Container Control ID and business number are required." };
  if (!text(facts.containerNumber)) return { feet: containerFeet, collection, reason: "Container number is missing." };
  if (!text(facts.supplierVtigerId) || !text(facts.supplierName)) return { feet: containerFeet, collection, reason: "Assigned supplier/Vendor reference is missing." };
  return { feet: containerFeet, collection, reason: null };
}

function line(input: Omit<FinancialLineItem, "lineAmount">): FinancialLineItem {
  return { ...input, lineAmount: money(input.quantity * input.unitAmount) };
}

function documentFromLines(input: {
  kind: "initial" | "recurring";
  facts: ForHireContainerControlFacts;
  poNumber: string;
  issueDate: Temporal.PlainDate;
  lines: FinancialLineItem[];
}): ProposedFinancialDocument {
  const subtotal = money(input.lines.reduce((sum, item) => sum + item.lineAmount, 0));
  const taxAmount = money(subtotal * GST_RATE);
  return {
    documentFamily: "purchase_order",
    documentType: input.kind === "initial" ? "initial_for_hire" : "recurring_for_hire",
    proposedAction: "create_draft",
    proposedDocumentNumber: input.poNumber,
    reference: input.facts.controlNumber,
    partyName: input.facts.supplierName,
    partySourceId: null,
    accountCode: ACCOUNT_CODE,
    gstTreatment: "GST_EXCLUSIVE",
    currency: "AUD",
    subtotal,
    taxAmount,
    total: money(subtotal + taxAmount),
    issueDate: plainToUtc(input.issueDate),
    dueDate: null,
    lineItems: input.lines,
    sourceWorkflow: input.kind === "initial" ? "container_control_acquisition" : "recurring_for_hire",
    sourceRecordId: input.facts.recordId,
    validationStatus: "valid",
  };
}

/**
 * Builds the Request-event PO only. It intentionally does not require ON HIRE
 * or IDLE: later cutover must route the existing Request action to AP, rather
 * than AP polling a changed Container Control state.
 */
export function buildInitialForHirePo(facts: ForHireContainerControlFacts): ForHirePoPreview {
  const eligibility = commonEligibility(facts);
  if (eligibility.reason || !eligibility.feet || !eligibility.collection) {
    return { kind: "initial", eligible: false, holdReason: eligibility.reason, periodStart: null, periodEnd: null, proposedPoNumber: null, document: null, itemNativeDescription: null };
  }
  const initialCost = number(facts.monthlyCostInclusive);
  const unitAmount = initialCost !== null && initialCost > 0
    ? inclusiveToExclusive(initialCost)
    : eligibility.feet === 20 ? 120 : 240;
  const periodEnd = eligibility.collection.add({ days: 30 });
  const lines: FinancialLineItem[] = [line({
    itemCode: eligibility.feet === 20 ? "HC 20" : "HC 40",
    description: `${eligibility.feet}' Container Hire from ${formatForHireDate(eligibility.collection.toString())} to ${formatForHireDate(periodEnd.toString())}`,
    quantity: 1,
    unitAmount,
    accountCode: ACCOUNT_CODE,
    taxRate: 10,
    gstTreatment: "GST_EXCLUSIVE",
  })];
  const liftFee = number(facts.liftAndBookingFeesInclusive);
  if (liftFee !== null && liftFee > 0) lines.push(line({
    itemCode: "",
    description: "Lift & Booking Fees",
    quantity: 1,
    unitAmount: inclusiveToExclusive(liftFee),
    accountCode: ACCOUNT_CODE,
    taxRate: 10,
    gstTreatment: "GST_EXCLUSIVE",
  }));
  const poNumber = forHireInitialReference(facts.controlNumber);
  return {
    kind: "initial",
    eligible: true,
    holdReason: null,
    periodStart: eligibility.collection.toString(),
    periodEnd: periodEnd.toString(),
    proposedPoNumber: poNumber,
    document: documentFromLines({ kind: "initial", facts, poNumber, issueDate: eligibility.collection, lines }),
    itemNativeDescription: null,
  };
}

/** Builds one exact 30-day extension. It never creates Lift & Booking Fees. */
export function buildRecurringForHirePo(input: {
  facts: ForHireContainerControlFacts;
  priorPeriodEnd: string | null;
  lastVerifiedExtensionSuffix: number | null;
  purchaseRate: number | null;
  itemNativeDescription?: string | null;
  now?: string;
}): ForHirePoPreview {
  const eligibility = commonEligibility(input.facts);
  if (eligibility.reason || !eligibility.feet || !eligibility.collection) {
    return { kind: "recurring", eligible: false, holdReason: eligibility.reason, periodStart: null, periodEnd: null, proposedPoNumber: null, document: null, itemNativeDescription: null };
  }
  const status = normalized(input.facts.status);
  if (status === "DEHIRED") return { kind: "recurring", eligible: false, holdReason: "Container Control is DEHIRED; recurring For Hire POs stop.", periodStart: null, periodEnd: null, proposedPoNumber: null, document: null, itemNativeDescription: null };
  if (!new Set(["ON HIRE", "IDLE"]).has(status)) return { kind: "recurring", eligible: false, holdReason: "Recurring For Hire requires status ON HIRE or IDLE.", periodStart: null, periodEnd: null, proposedPoNumber: null, document: null, itemNativeDescription: null };
  const priorEnd = plainDate(input.priorPeriodEnd);
  if (!priorEnd) return { kind: "recurring", eligible: false, holdReason: "No verified AP initial or prior extension receipt exists; AP will not import Operations history or infer a first extension.", periodStart: null, periodEnd: null, proposedPoNumber: null, document: null, itemNativeDescription: null };
  const start = priorEnd.add({ days: 1 });
  const end = start.add({ days: 29 });
  // Operations evaluates due periods using the Sydney business date. Preserve
  // that behavior here so the midnight UTC boundary cannot create an early or
  // deferred monthly extension. Explicit test input remains a plain date.
  const now = plainDate(input.now ?? Temporal.Now.zonedDateTimeISO("Australia/Sydney").toPlainDate().toString());
  if (now && Temporal.PlainDate.compare(start, now) > 0) return { kind: "recurring", eligible: false, holdReason: "The next consecutive extension period is not due.", periodStart: start.toString(), periodEnd: end.toString(), proposedPoNumber: null, document: null, itemNativeDescription: null };
  if (now && Temporal.PlainDate.compare(start, now.subtract({ days: 30 })) < 0) return { kind: "recurring", eligible: false, holdReason: "The next extension is historical; no catch-up or bulk extension is allowed.", periodStart: start.toString(), periodEnd: end.toString(), proposedPoNumber: null, document: null, itemNativeDescription: null };
  if (input.purchaseRate === null || !Number.isFinite(input.purchaseRate) || input.purchaseRate <= 0) return { kind: "recurring", eligible: false, holdReason: "Current Xero HC extension purchase rate is unavailable.", periodStart: start.toString(), periodEnd: end.toString(), proposedPoNumber: null, document: null, itemNativeDescription: input.itemNativeDescription ?? null };
  const poNumber = forHireExtensionReference(input.facts.controlNumber, input.lastVerifiedExtensionSuffix);
  const itemCode = eligibility.feet === 20 ? "HC 20 E" : "HC 40 E";
  const rate = money(input.purchaseRate);
  const period = `${formatForHireDate(start.toString())} to ${formatForHireDate(end.toString())}`;
  const extensionLine = { itemCode, description: `${input.facts.containerNumber}, ${text(input.facts.containerType)} Extended Hire @ $${rate.toFixed(2)} per day from ${period}`, quantity: 30, unitAmount: rate, accountCode: ACCOUNT_CODE, taxRate: 10, gstTreatment: "GST_EXCLUSIVE" as const };
  return {
    kind: "recurring", eligible: true, holdReason: null, periodStart: start.toString(), periodEnd: end.toString(), proposedPoNumber: poNumber,
    document: documentFromLines({ kind: "recurring", facts: input.facts, poNumber, issueDate: start, lines: [line(extensionLine)] }),
    itemNativeDescription: input.itemNativeDescription ?? null,
  };
}
