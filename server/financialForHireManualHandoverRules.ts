import { Temporal } from "@js-temporal/polyfill";
import type { ForHireContainerControlFacts } from "./financialForHireDrafts";
import { financialSha256, stableFinancialJson } from "./financialProposalIntegrity";

/** Version changes require a new owner verification; this is not a Draft receipt. */
export const MANUAL_FOR_HIRE_HANDOVER_RULES_HASH = financialSha256("manual-for-hire-handover/2026-11-15/v2");

/** Server-reviewed historical lump sum, never a rate or a quantity-derived period. */
export type ManualForHireLumpSumEvidence = {
  confirmed: true;
  reviewedBy: number;
  /** Zero-based index in the untouched manual PO LineItems. */
  lineIndex: number;
  /** Exact positive AUD net amount as supplied on the selected line, not calculated. */
  amount: number;
};

/**
 * The caller must freshly verify the vendor/contact mapping. The current Xero
 * API cannot automatically prove scoped history; Accounts must attest coverage
 * unless a genuinely complete scoped source is available. Never turn unknown
 * history/empty results into complete:true. All reviewedBy values and explicit
 * confirmations are populated by the trusted server after reviewer authorization,
 * never accepted as client-supplied reviewer IDs. This pure module cannot itself
 * authenticate an actor. Missing native dates additionally require a separately
 * confirmed coveredThrough, even when complete scoped history is available.
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
    confirmedCoveredThrough?: true;
    /** Strict ISO or day-first DD/MM/YY/YYYY; normalized only for comparison. */
    coveredThrough?: string;
  };
  /** Required for recognized legacy-code lump sums or recurring HC E quantity 1. */
  lumpSumManual?: ManualForHireLumpSumEvidence;
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
  /** Unknown for Accounts-attested legacy coverage; never back-calculated. */
  manualPeriodStart: string | null;
  coverageSource: "native_description" | "accounts_attested";
  numberingConvention: "legacy_suffix_zero_initial" | "ap_initial_ordinal_one";
  coveredThrough: string;
  nextPeriodStart: string;
  nextPeriodEnd: string;
  nextPoNumber: string;
  /** Unsuffixed opening PO is suffix 0; extensions are 1, 2, 3, ... . */
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
const positiveReviewer = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

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
    lumpSumManual: stableBusinessValue(evidence.lumpSumManual),
    manualPo: poBusinessEvidence(evidence.manualPo), relatedPurchaseOrders: related });
}

function containerFeet(type: string): 20 | 40 {
  const sizes = new Set(type.match(/\b(?:20|40)(?!\d)/g));
  requireFact(sizes.size === 1, "A single supported 20-foot or 40-foot container type is required.");
  return sizes.has("20") ? 20 : 40;
}

function itemCode(line: Record<string, any>): string {
  return normalized(line.ItemCode).replace(/\s+/g, "");
}

function legacyHireSize(line: Record<string, any>): 20 | 40 | null {
  // Purchase-side allowlist only. No approximate match or sales/storage aliases.
  const code = normalized(line.ItemCode);
  if (code === "20' HIRE" || code === "HIRE 20HC") return 20;
  if (code === "40' HIRE" || code === "HIRE 40HC") return 40;
  return null;
}

function isHireOrContainerLine(line: Record<string, any>): boolean {
  const code = itemCode(line);
  // Explicit coverage codes cannot be disguised as an optional fee by their text.
  if (/^(?:HC|JD|GD|A|C)\d/.test(code) || legacyHireSize(line) !== null) return true;
  const description = text(line.Description);
  const withoutPrepaidDehire = description.replace(/\b(?:pre[\s-]*paid\s+)?de[\s-]*hire\s+(?:fees?|charges?)\b/gi, "");
  const coverageCode = normalized(line.ItemCode).replace(/\b(?:pre[\s-]*paid\s+)?de[\s-]*hire\s+(?:fees?|charges?)\b/gi, "");
  const actualCoverage = /\b(?:hire|hiring|rental|rent|sale|sales|purchase|storage)\b/i.test(`${withoutPrepaidDehire} ${coverageCode}`)
    || /^(?:HIRE|HIRING|RENTAL|RENT|SALE|SALES|STORAGE)\d/.test(code);
  const feeCode = /^(?:LIFTFEE|BOOKINGFEE|DELIVERYFEE|TRANSPORT|FREIGHT|PREPAIDDEHIRE(?:CHARGES|FEES)|DEHIREFEE|RETURNLIFTFEE)/.test(code.replace(/[^A-Z0-9]/g, ""));
  const feeDescription = /\b(?:lift|booking|delivery|transport|freight)\b/i.test(description)
    || /\b(?:pre[\s-]*paid\s+)?de[\s-]*hire\s+(?:fees?|charges?)\b/i.test(description);
  // Fee container tokens and any dates on fees are not coverage. A mixed actual
  // rental/sales/storage line is never ignored merely because it mentions a fee.
  if ((feeCode || feeDescription) && !actualCoverage) return false;
  return actualCoverage || /\bcontainer\b/i.test(description) || /\b[A-Z]{4}\d{7}\b/i.test(description);
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

/** Only a genuinely date-free legacy description may use the fallback. */
function hasAnyPeriodSignal(description: string): boolean {
  return /\b(?:from|to|date|duedate|period)\b/i.test(description)
    || /\b\d{1,4}\s*[/-]\s*\d{1,4}(?:\s*[/-]\s*\d{1,4})?\b/.test(description)
    || /\b\d{1,4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,4}\b/.test(description)
    || /\b(?:19|20)\d{2}\b/.test(description)
    || /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(description);
}

function exactToken(description: string, token: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(token)}(?![A-Za-z0-9])`).test(description);
}

function suffixFor(number: string, base: string): number | null {
  if (number === base) return 0;
  const suffix = new RegExp(`^${escapeRegex(base)}-([1-9]\\d*)$`).exec(number);
  if (!suffix) return null;
  const ordinal = Number(suffix[1]);
  return Number.isSafeInteger(ordinal) && ordinal >= 1 ? ordinal : null;
}

function canonicalBase(controlNumber: string): string {
  const match = /^C([1-9]\d*)$/.exec(controlNumber);
  requireFact(match && Number.isSafeInteger(Number(match[1])) && String(Number(match[1])) === match[1], "Container Control number must be canonical C<positive safe-integer digits>, without zero or leading zeros.");
  return `H${controlNumber}`;
}

function hasErrors(row: Record<string, any>): boolean {
  return (row.HasErrors !== undefined && row.HasErrors !== false)
    || (Array.isArray(row.ValidationErrors) && row.ValidationErrors.length > 0);
}

function periodsOverlap(a: HirePeriod, b: HirePeriod): boolean {
  return Temporal.PlainDate.compare(a.start, b.end) <= 0 && Temporal.PlainDate.compare(b.start, a.end) <= 0;
}

function numericQuantity(line: Record<string, any>): number | null {
  if (typeof line.Quantity === "number" && Number.isFinite(line.Quantity)) return line.Quantity;
  if (typeof line.Quantity === "string" && /^(?:1|30)$/.test(line.Quantity)) return Number(line.Quantity);
  return null;
}

function verifyLumpSum(evidence: ManualForHireEvidence, line: Record<string, any>, lineIndex: number): void {
  const lump = evidence.lumpSumManual;
  requireFact(lump?.confirmed === true && positiveReviewer(lump.reviewedBy)
    && lump.reviewedBy === evidence.coverageAttestation?.reviewedBy,
  "A confirmed lumpSumManual with the same positive trusted Accounts reviewer is required.");
  requireFact(Number.isSafeInteger(lump.lineIndex) && lump.lineIndex >= 0 && lump.lineIndex === lineIndex,
    "lumpSumManual must explicitly identify the exact selected hire line index.");
  requireFact(typeof lump.amount === "number" && Number.isFinite(lump.amount) && lump.amount > 0,
    "lumpSumManual must explicitly state a positive finite historical net amount.");
  requireFact(evidence.manualPo.LineAmountTypes === "Exclusive", "Legacy lump-sum net amount requires explicit Exclusive line amounts; tax is not inferred.");
  // Quantity is already exactly 1. Compare a supplied amount; never multiply,
  // derive a daily rate, assume a 30-day term or alter the historical line.
  const amount = line.LineAmount === undefined ? line.UnitAmount : line.LineAmount;
  requireFact((typeof amount === "number" && Number.isFinite(amount))
    || (typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount)), "The selected lump-sum line must supply its explicit net amount.");
  requireFact(Number(amount) === lump.amount, "lumpSumManual amount must exactly match the selected line's supplied net amount.");
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
    && attestation.confirmedNoOtherFutureCoverage === true && positiveReviewer(attestation.reviewedBy);
  requireFact(evidence && (evidence.complete === true || attested),
    "Complete current scoped-series evidence or explicit Accounts latest/no-future-coverage attestation with a positive reviewer is required.");
  requireFact(text(evidence.tenantId) && text(evidence.supplierContactId), "An exact tenant and expected supplier ContactID are required.");
  requireFact(evidence.manualPo && typeof evidence.manualPo === "object" && !Array.isArray(evidence.manualPo)
    && Array.isArray(evidence.relatedPurchaseOrders), "Manual PO and complete related PO records are required.");
  const base = canonicalBase(facts.controlNumber);
  const manualSuffix = typeof input.manualPoNumber === "string" ? suffixFor(input.manualPoNumber, base) : null;
  requireFact(manualSuffix !== null && Number.isSafeInteger(manualSuffix + 1), "Manual PO number must be the exact canonical H<ControlNumber> or -N (N >= 1), with a safe next suffix.");
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
  const lineIndex = manual.LineItems.indexOf(line);
  requireFact(line.AccountCode === "312" && line.TaxType === "INPUT", "Hire line must use account 312 and INPUT GST.");
  requireFact(typeof line.Description === "string" && text(line.Description), "The hire line must have a native period description or an explicit date-free legacy description.");
  const description = text(line.Description);
  const recurring = manualSuffix >= 1;
  const nativeCode = itemCode(line) === `HC${size}${recurring ? "E" : ""}`;
  const legacyCode = legacyHireSize(line);
  const period = hasAnyPeriodSignal(description) ? hirePeriod(description) : null;
  const coveredThrough = normalizeHandoverDate(input.coveredThrough);
  // An explicit confirmation is not allowed to contradict native dates either.
  if (attestation?.confirmedCoveredThrough !== undefined || attestation?.coveredThrough !== undefined) {
    requireFact(attested && attestation.confirmedCoveredThrough === true && typeof attestation.coveredThrough === "string",
      "Explicit Accounts coveredThrough requires confirmation, both coverage flags and a positive trusted reviewer.");
    requireFact(normalizeHandoverDate(attestation.coveredThrough) === coveredThrough,
      "Accounts-attested coveredThrough must exactly match owner-entered coveredThrough.");
  }
  const oppositeSize = size === 20 ? 40 : 20;
  requireFact(!new RegExp(`\\b${oppositeSize}\\s*(?:['′’]|ft\\b|foot\\b|feet\\b|HC\\b|GP\\b|DC\\b|standard\\b|high\\b)`, "i").test(description), "Hire description has a mismatched container size.");
  const describedContainers = description.match(/\b[A-Z]{4}\d{7}\b/gi) ?? [];
  requireFact(describedContainers.every((token) => token === text(facts.containerNumber)), "Hire description contains a different or additional container.");
  let coverageSource: ManualForHireHandoverPlan["coverageSource"];
  if (period) {
    coverageSource = "native_description";
    requireFact(nativeCode, "Hire item must match the exact container size and initial/recurring suffix.");
    requireFact(numericQuantity(line) === (recurring ? 30 : 1), "Initial hire quantity must be 1; recurring hire quantity must be 30.");
    if (recurring) {
      requireFact(exactToken(description, text(facts.containerNumber)), "Recurring description must contain the exact current container token.");
      requireFact(exactToken(description, text(facts.containerType)), "Recurring description must contain the exact current container type.");
    }
    requireFact(period.end.equals(period.start.add({ days: recurring ? 29 : 30 })), "Manual hire period must end exactly start +30 days initially or +29 days recurring.");
    requireFact(period.end.toString() === coveredThrough, "Owner-entered coveredThrough must exactly match the native hire-line end date.");
  } else {
    coverageSource = "accounts_attested";
    requireFact(attested && attestation?.confirmedCoveredThrough === true && typeof attestation.coveredThrough === "string",
      "Missing native period dates require explicit Accounts confirmedCoveredThrough, matching coveredThrough, both coverage flags and a positive trusted reviewer.");
    requireFact(nativeCode || legacyCode === size, "Date-free legacy hire item must be an exact native HC item or recognized purchase-side legacy hire code of the same size.");
    requireFact(exactToken(description, text(facts.containerNumber)), "Legacy description must contain the exact current container token.");
    // The actual historical descriptor may differ from the current VTiger
    // subtype. Preserve both source identity and exact Xero text in the hashes;
    // Accounts/UI must review that difference, never rewrite either record.
    const quantity = numericQuantity(line);
    if (!nativeCode || (recurring && quantity === 1)) {
      requireFact(quantity === 1, "Legacy lump-sum manual hire quantity must be exactly 1; a duration is not inferred.");
      verifyLumpSum(evidence, line, lineIndex);
    } else {
      requireFact(quantity === (recurring ? 30 : 1), "Initial hire quantity must be 1; recurring hire quantity must be 30.");
      if (recurring) {
        requireFact(exactToken(description, text(facts.containerType)), "Recurring description must contain the exact current container type.");
      }
    }
  }
  const effectiveFrom = normalizeHandoverDate(input.effectiveFrom);
  const now = normalizeHandoverDate(input.now);
  requireFact(Temporal.PlainDate.compare(effectiveFrom, now) >= 0, "effectiveFrom must not be historical; no catch-up is allowed.");
  const coveredEnd = Temporal.PlainDate.from(coveredThrough);
  const nextStart = coveredEnd.add({ days: 1 });
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
      // No fallback for a different selected ID. An attestation for the selected
      // manual PO cannot establish the dates of other legacy coverage.
      const otherPeriod = hirePeriod(otherLine.Description);
      requireFact(period !== null, "Unknown manual period start cannot safely exclude overlaps with another active hire period.");
      requireFact(!periodsOverlap(otherPeriod, period) && !periodsOverlap(otherPeriod, nextPeriod)
        && Temporal.PlainDate.compare(otherPeriod.end, coveredEnd) <= 0,
      "Another active PO hire period overlaps the manual/next period or extends manual coverage beyond coveredThrough.");
    }
  }
  const plan: Omit<ManualForHireHandoverPlan, "planHash"> = {
    containerControlId: text(facts.recordId), containerControlNumber: text(facts.controlNumber),
    containerNumber: text(facts.containerNumber), containerType: text(facts.containerType),
    supplierVtigerId: text(facts.supplierVtigerId), supplierName: text(facts.supplierName),
    supplierContactId: evidence.supplierContactId, manualPoId: manual.PurchaseOrderID,
    manualPoNumber: input.manualPoNumber, manualPoStatus: manual.Status,
    manualPeriodStart: period?.start.toString() ?? null, coverageSource, numberingConvention: "legacy_suffix_zero_initial",
    coveredThrough, nextPeriodStart: nextStart.toString(), nextPeriodEnd: nextEnd.toString(),
    nextPoNumber, manualSuffix, nextSuffix, effectiveFrom,
    sourceIdentityHash: manualForHireSourceIdentityHash(facts), xeroEvidenceHash: manualForHireEvidenceHash(evidence),
    rulesHash: MANUAL_FOR_HIRE_HANDOVER_RULES_HASH,
  };
  return { ...plan, planHash: financialSha256(plan) };
}
