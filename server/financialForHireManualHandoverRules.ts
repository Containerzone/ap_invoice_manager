import { Temporal } from "@js-temporal/polyfill";
import type { ForHireContainerControlFacts } from "./financialForHireDrafts";
import { financialSha256, stableFinancialJson } from "./financialProposalIntegrity";

/** Version changes require a new owner verification; this is not a Draft receipt. */
export const MANUAL_FOR_HIRE_HANDOVER_RULES_HASH = financialSha256("manual-for-hire-handover/2026-11-15/v1");

/**
 * The caller must freshly verify the vendor/contact mapping. The current Xero
 * API cannot automatically prove scoped history; Accounts must attest coverage
 * unless a genuinely complete scoped source is available. Never turn unknown
 * history/empty results into complete:true. reviewedBy is set by the admin service.
 */
export type ManualForHireEvidence = {
  manualPo: Record<string, any>;
  relatedPurchaseOrders: Record<string, any>[];
  supplierContactId: string;
  tenantId: string;
  complete: boolean;
  coverageAttestation?: {
    confirmedLatestCoverage: true;
    confirmedNoOtherFutureCoverage: true;
    reviewedBy: number;
  };
};

export type ManualForHireHandoverPlan = {
  containerControlId: string;
  containerControlNumber: string;
  containerNumber: string;
  containerType: string;
  supplierVtigerId: string;
  supplierName: string;
  supplierContactId: string;
  manualPoId: string;
  manualPoNumber: string;
  manualPoStatus: string;
  manualPeriodStart: string;
  coveredThrough: string;
  nextPeriodStart: string;
  nextPeriodEnd: string;
  nextPoNumber: string;
  /** The unsuffixed opening PO is ordinal 1; extensions are 2, 3, ... . */
  manualSuffix: number;
  nextSuffix: number;
  effectiveFrom: string;
  sourceIdentityHash: string;
  xeroEvidenceHash: string;
  planHash: string;
  rulesHash: string;
};

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Manual For Hire handover held: ${message}`);
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const normalized = (value: unknown): string => text(value).toUpperCase().replace(/\s+/g, " ");
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strict plain business dates only. Slash dates are explicitly day-first, never
 * guessed as US month-first; 01/02/26 means 1 February. Two-digit years are 2000–2099.
 * Timestamps, hyphenated DMY, rollover dates and US-only dates are rejected.
 */
export function normalizeHandoverDate(value: string): string {
  requireFact(typeof value === "string", "A strict ISO or DD/MM/YY/YYYY date is required.");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const native = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(value);
  requireFact(iso || native, "A strict ISO or DD/MM/YY/YYYY date is required; US dates are not inferred.");
  const year = iso ? Number(iso[1]) : Number(native![3]) + (native![3].length === 2 ? 2000 : 0);
  const month = Number(iso ? iso[2] : native![2]);
  const day = Number(iso ? iso[3] : native![1]);
  requireFact(year >= 1 && year <= 9999, "The date year is invalid.");
  try {
    return Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" }).toString();
  } catch {
    throw new Error("Manual For Hire handover held: Invalid calendar date; rollover and US month-first dates are not allowed.");
  }
}

/** Only persistent source identity; status and current prices remain live checks. */
export function manualForHireSourceIdentityHash(facts: ForHireContainerControlFacts): string {
  return financialSha256({
    recordId: text(facts.recordId), controlNumber: text(facts.controlNumber),
    acquisition: normalized(facts.acquisition), containerNumber: text(facts.containerNumber),
    containerType: text(facts.containerType), supplierVtigerId: text(facts.supplierVtigerId),
    supplierName: text(facts.supplierName),
  });
}

// Whitelist business PO fields, not response envelopes, links or API refresh metadata.
const PO_BUSINESS_FIELDS = [
  "PurchaseOrderID", "PurchaseOrderNumber", "Status", "Contact", "CurrencyCode",
  "Description", "Reference", "LineAmountTypes", "LineItems", "Date", "DateString",
  "DueDate", "DueDateString", "DeliveryDate", "DeliveryAddress", "AttentionTo",
  "Telephone", "DeliveryInstructions", "SubTotal", "TotalTax", "Total", "TotalDiscount",
  "HasErrors", "ValidationErrors", "IsDeleted", "IsVoided",
] as const;

function stableBusinessValue(value: any): any {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableBusinessValue);
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !/^updated(?:date(?:utc)?|at)$/i.test(key))
    .map((key) => [key, stableBusinessValue(value[key])]));
}

function poBusinessEvidence(po: Record<string, any>): Record<string, any> {
  return Object.fromEntries(PO_BUSINESS_FIELDS.map((field) => [field, stableBusinessValue(po[field])]));
}

/** Every supplied row must be scoped to this container/series by the read-only caller. */
export function manualForHireEvidenceHash(evidence: ManualForHireEvidence): string {
  requireFact(evidence && evidence.manualPo && Array.isArray(evidence.relatedPurchaseOrders), "Manual and scoped related PO evidence is required.");
  const related = evidence.relatedPurchaseOrders.map(poBusinessEvidence).sort((left, right) => {
    const a = String(left.PurchaseOrderID ?? "");
    const b = String(right.PurchaseOrderID ?? "");
    return a < b ? -1 : a > b ? 1 : stableFinancialJson(left).localeCompare(stableFinancialJson(right));
  });
  return financialSha256({ tenantId: evidence.tenantId, supplierContactId: evidence.supplierContactId,
    complete: evidence.complete, coverageAttestation: stableBusinessValue(evidence.coverageAttestation),
    manualPo: poBusinessEvidence(evidence.manualPo), relatedPurchaseOrders: related });
}

function containerFeet(type: string): 20 | 40 {
  const sizes = new Set(type.match(/\b(?:20|40)\b/g));
  requireFact(sizes.size === 1, "A single supported 20-foot or 40-foot container type is required.");
  return sizes.has("20") ? 20 : 40;
}

function itemCode(line: Record<string, any>): string {
  return normalized(line.ItemCode).replace(/\s+/g, "");
}

function isHireOrContainerLine(line: Record<string, any>): boolean {
  const code = itemCode(line);
  if (/^(?:HC|JD|GD|A|C)\d/.test(code)) return true;
  const description = text(line.Description);
  if (/\b(?:hire|hiring|rental|rent)\b/i.test(description)) return true;
  // Optional transport/lift/booking fees are not hire coverage or container sales.
  if (/\b(?:lift|booking|delivery|transport|freight)\b/i.test(description)
    && !/\b(?:sale|purchase|storage)\b/i.test(description)) return false;
  return /\bcontainer\b/i.test(description) || /\b[A-Z]{4}\d{7}\b/i.test(description);
}

type HirePeriod = { start: Temporal.PlainDate; end: Temporal.PlainDate };

function hirePeriod(description: unknown): HirePeriod {
  requireFact(typeof description === "string", "The hire line must have a native period description.");
  const ranges = Array.from(description.matchAll(/\bfrom\s+(\d{2}\/\d{2}\/\d{2})(?!\d)\s+to\s+(\d{2}\/\d{2}\/\d{2})(?!\d)/gi));
  const dates = Array.from(description.matchAll(/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g));
  const fromWords = description.match(/\bfrom\b/gi) ?? [];
  const toWords = description.match(/\bto\b/gi) ?? [];
  requireFact(ranges.length === 1 && dates.length === 2 && fromWords.length === 1 && toWords.length === 1,
    "Exactly one native from DD/MM/YY to DD/MM/YY hire period is required; multiple or non-native periods are unsafe.");
  const start = Temporal.PlainDate.from(normalizeHandoverDate(ranges[0][1]));
  const end = Temporal.PlainDate.from(normalizeHandoverDate(ranges[0][2]));
  requireFact(Temporal.PlainDate.compare(start, end) <= 0, "Hire period end must not precede its start.");
  return { start, end };
}

function exactToken(description: string, token: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(token)}(?![A-Za-z0-9])`).test(description);
}

function suffixFor(number: string, base: string): number | null {
  if (number === base) return 1;
  const suffix = new RegExp(`^${escapeRegex(base)}-([1-9]\\d*)$`).exec(number);
  if (!suffix) return null;
  const ordinal = Number(suffix[1]);
  return Number.isSafeInteger(ordinal) && ordinal >= 2 ? ordinal : null;
}

function hasErrors(row: Record<string, any>): boolean {
  return (row.HasErrors !== undefined && row.HasErrors !== false)
    || (Array.isArray(row.ValidationErrors) && row.ValidationErrors.length > 0);
}

function periodsOverlap(a: HirePeriod, b: HirePeriod): boolean {
  return Temporal.PlainDate.compare(a.start, b.end) <= 0 && Temporal.PlainDate.compare(b.start, a.end) <= 0;
}

/**
 * Verifies one untouched manual PO as an opening baseline, then plans just the
 * next consecutive period. No Xero writes, receipts, locked rates or catch-up.
 * The service owns freshness, tenant selection and exact VTiger→Xero mapping.
 */
export function buildManualForHireHandoverPlan(input: {
  facts: ForHireContainerControlFacts;
  evidence: ManualForHireEvidence;
  manualPoNumber: string;
  coveredThrough: string;
  effectiveFrom: string;
  now: string;
}): ManualForHireHandoverPlan {
  const { facts, evidence } = input;
  requireFact(facts && normalized(facts.acquisition) === "FOR HIRE", "Container Control acquisition must be FOR HIRE.");
  requireFact(["ON HIRE", "IDLE"].includes(normalized(facts.status)), "Current Container Control status must be ON HIRE or IDLE.");
  for (const field of ["recordId", "controlNumber", "containerNumber", "containerType", "supplierVtigerId", "supplierName"] as const) {
    requireFact(text(facts[field]), `Current Container Control/container/vendor ${field} is required.`);
  }
  // Completeness, not a source of inferred coverage or a hashed pricing baseline.
  normalizeHandoverDate(facts.collectionDate);
  const size = containerFeet(text(facts.containerType));
  const attestation = evidence?.coverageAttestation;
  const attested = attestation?.confirmedLatestCoverage === true
    && attestation.confirmedNoOtherFutureCoverage === true
    && Number.isSafeInteger(attestation.reviewedBy) && attestation.reviewedBy > 0;
  requireFact(evidence && (evidence.complete === true || attested),
    "Complete current scoped-series evidence or explicit Accounts latest/no-future-coverage attestation with a positive reviewer is required.");
  requireFact(text(evidence.tenantId) && text(evidence.supplierContactId), "An exact tenant and expected supplier ContactID are required.");
  requireFact(evidence.manualPo && typeof evidence.manualPo === "object" && !Array.isArray(evidence.manualPo)
    && Array.isArray(evidence.relatedPurchaseOrders), "Manual PO and complete related PO records are required.");
  const base = `H${text(facts.controlNumber)}`;
  const manualSuffix = typeof input.manualPoNumber === "string" ? suffixFor(input.manualPoNumber, base) : null;
  requireFact(manualSuffix !== null && Number.isSafeInteger(manualSuffix + 1), "Manual PO number must be the exact canonical H<ControlNumber> or -N (N >= 2), with a safe next suffix.");
  const manual = evidence.manualPo;
  requireFact(text(manual.PurchaseOrderID), "Exact manual PurchaseOrderID is required.");
  requireFact(manual.PurchaseOrderNumber === input.manualPoNumber, "Exact manual PurchaseOrderNumber must match the selected canonical Container Control number.");
  requireFact(["DRAFT", "AUTHORISED", "BILLED"].includes(manual.Status), "Manual PO status must be DRAFT, AUTHORISED or BILLED.");
  requireFact(manual.CurrencyCode === "AUD", "Manual PO currency must be AUD.");
  requireFact(!manual.IsDeleted && !manual.IsVoided, "Manual PO must not be deleted or voided.");
  requireFact(manual.Contact?.ContactID === evidence.supplierContactId, "Manual PO ContactID must match the exact expected supplier contact.");
  requireFact(!hasErrors(manual), "Manual PO has Xero errors.");
  requireFact(Array.isArray(manual.LineItems) && manual.LineItems.length > 0, "Complete manual PO line items are required.");
  requireFact(manual.LineItems.every((line: any) => line && typeof line === "object" && !Array.isArray(line)), "Malformed manual PO line evidence.");
  const hireLines = manual.LineItems.filter(isHireOrContainerLine);
  requireFact(hireLines.length === 1, "Exactly one hire line and no other hire/container lines are allowed.");
  const line = hireLines[0] as Record<string, any>;
  const recurring = manualSuffix >= 2;
  requireFact(itemCode(line) === `HC${size}${recurring ? "E" : ""}`, "Hire item must match the exact container size and initial/recurring suffix.");
  requireFact((typeof line.Quantity === "number" || typeof line.Quantity === "string")
    && Number(line.Quantity) === (recurring ? 30 : 1), "Initial hire quantity must be 1; recurring hire quantity must be 30.");
  requireFact(line.AccountCode === "312" && line.TaxType === "INPUT", "Hire line must use account 312 and INPUT GST.");
  const period = hirePeriod(line.Description);
  const description = text(line.Description);
  const oppositeSize = size === 20 ? 40 : 20;
  requireFact(!new RegExp(`\\b${oppositeSize}\\s*(?:['′’]|ft\\b|foot\\b|feet\\b)`, "i").test(description), "Hire description has a mismatched container size.");
  if (recurring) {
    requireFact(exactToken(description, text(facts.containerNumber)), "Recurring description must contain the exact current container token.");
    requireFact(exactToken(description, text(facts.containerType)), "Recurring description must contain the exact current container type.");
  }
  const describedContainers = description.match(/\b[A-Z]{4}\d{7}\b/gi) ?? [];
  requireFact(describedContainers.every((token) => token === text(facts.containerNumber)), "Hire description contains a different or additional container.");
  requireFact(period.end.equals(period.start.add({ days: recurring ? 29 : 30 })), "Manual hire period must end exactly start +30 days initially or +29 days recurring.");
  const coveredThrough = normalizeHandoverDate(input.coveredThrough);
  requireFact(period.end.toString() === coveredThrough, "Owner-entered coveredThrough must exactly match the native hire-line end date.");
  const effectiveFrom = normalizeHandoverDate(input.effectiveFrom);
  const now = normalizeHandoverDate(input.now);
  requireFact(Temporal.PlainDate.compare(effectiveFrom, now) >= 0, "effectiveFrom must not be historical; no catch-up is allowed.");
  const nextStart = period.end.add({ days: 1 });
  const nextEnd = nextStart.add({ days: 29 });
  requireFact(Temporal.PlainDate.compare(nextStart, effectiveFrom) >= 0 && Temporal.PlainDate.compare(nextStart, now) >= 0,
    "The next consecutive period must be on/after effectiveFrom and now; no catch-up, skipped periods or rolling forward.");
  const nextPeriod = { start: nextStart, end: nextEnd };
  const nextSuffix = manualSuffix + 1;
  const nextPoNumber = `${base}-${nextSuffix}`;
  const seen = new Set<string>();
  for (const related of evidence.relatedPurchaseOrders) {
    requireFact(related && typeof related === "object" && !Array.isArray(related), "Malformed scoped PO evidence.");
    const id = text(related.PurchaseOrderID);
    const number = related.PurchaseOrderNumber;
    requireFact(id && typeof number === "string" && number.length > 0, "Every scoped PO needs an exact ID and number.");
    requireFact(!seen.has(id), "Duplicate scoped PO IDs make the evidence ambiguous.");
    seen.add(id);
    if (id === manual.PurchaseOrderID) {
      requireFact(financialSha256(poBusinessEvidence(related)) === financialSha256(poBusinessEvidence(manual)), "Selected manual PO ID has conflicting scoped business evidence.");
      continue;
    }
    requireFact(number !== input.manualPoNumber, "A different PO ID occupies the selected manual number.");
    const ordinal = suffixFor(number, base);
    requireFact(ordinal === null || ordinal <= manualSuffix, "A higher canonical series suffix already exists in ANY status, including voided/deleted; no bypass is allowed.");
    requireFact(!number.startsWith(`${base}-`) || ordinal !== null, "A non-canonical or unsafe number exists in the scoped series.");
    // Reserved numbers are checked above, before excluding inactive coverage.
    if (["VOIDED", "DELETED"].includes(normalized(related.Status))) continue;
    requireFact(text(related.Status) && !related.IsDeleted && !related.IsVoided, "Scoped PO status is missing or has conflicting inactive flags.");
    requireFact(!hasErrors(related), "Scoped PO has Xero errors; complete coverage cannot be verified.");
    requireFact(Array.isArray(related.LineItems), "Complete active scoped PO line items are required; PO Date/DueDate cannot establish coverage.");
    for (const otherLine of related.LineItems) {
      requireFact(otherLine && typeof otherLine === "object" && !Array.isArray(otherLine), "Malformed scoped PO line evidence.");
      if (!isHireOrContainerLine(otherLine)) continue;
      const otherPeriod = hirePeriod(otherLine.Description);
      requireFact(!periodsOverlap(otherPeriod, period) && !periodsOverlap(otherPeriod, nextPeriod),
        "Another active PO hire period overlaps the manual/next period or extends manual coverage beyond coveredThrough.");
    }
  }
  const plan: Omit<ManualForHireHandoverPlan, "planHash"> = {
    containerControlId: text(facts.recordId), containerControlNumber: text(facts.controlNumber),
    containerNumber: text(facts.containerNumber), containerType: text(facts.containerType),
    supplierVtigerId: text(facts.supplierVtigerId), supplierName: text(facts.supplierName),
    supplierContactId: evidence.supplierContactId, manualPoId: manual.PurchaseOrderID,
    manualPoNumber: input.manualPoNumber, manualPoStatus: manual.Status,
    manualPeriodStart: period.start.toString(), coveredThrough, nextPeriodStart: nextStart.toString(),
    nextPeriodEnd: nextEnd.toString(), nextPoNumber, manualSuffix, nextSuffix, effectiveFrom,
    sourceIdentityHash: manualForHireSourceIdentityHash(facts), xeroEvidenceHash: manualForHireEvidenceHash(evidence),
    rulesHash: MANUAL_FOR_HIRE_HANDOVER_RULES_HASH,
  };
  return { ...plan, planHash: financialSha256(plan) };
}
