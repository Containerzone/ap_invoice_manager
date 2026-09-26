import type { FinancialWorkflowEvaluation, FinancialWorkflowType } from "./financialWorkflowEngine";
import type { FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import type { FinancialAutomationRules } from "./financialAutomationRules";

export type FinancialSourceMapping = Record<string, unknown>;

type Primitive = string | number | boolean | null;

export type ShadowExpectedResult = {
  proposedDocumentNumbers?: string[];
  partyNames?: string[];
  accountCodes?: string[];
  itemCodes?: string[];
  gstTreatments?: string[];
  issueDates?: Array<string | null>;
  dueDates?: Array<string | null>;
  totals?: number[];
  lineCounts?: number[];
  /** Optional field-value assertions for opaque business fields, e.g. { "intents.0.lineItems.0.quantity": 30 }. */
  assertions?: Record<string, Primitive>;
};

export type ShadowFieldComparison = {
  field: string;
  expected: unknown;
  actual: unknown;
  outcome: "match" | "different" | "not_provided";
  explanation: string;
};

export type RulesBasedExpectedFacts = {
  /** Generated from active AP rules; an administrator still must review and confirm it. */
  expectedResult: ShadowExpectedResult;
  ruleFacts: Array<{ field: string; configuredRule: unknown; liveSourceValue: unknown; explanation: string }>;
};

function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) return /^\d+$/.test(key) ? current[Number(key)] : undefined;
    return typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
  }, value);
}

function formattedDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function actualResult(evaluation: FinancialWorkflowEvaluation, preflight: FinancialXeroPreflight[]) {
  return {
    mode: "shadow",
    xeroWritePermitted: false,
    workflowOutcome: evaluation.outcome,
    safeRequestSummary: evaluation.safeRequestSummary,
    intents: evaluation.intents.map((intent, index) => ({
      proposedDocumentNumber: intent.proposedDocumentNumber,
      documentFamily: intent.documentFamily,
      documentType: intent.documentType,
      proposedAction: intent.proposedAction,
      partyName: intent.partyName,
      accountCode: intent.accountCode,
      gstTreatment: intent.gstTreatment,
      issueDate: formattedDate(intent.issueDate),
      dueDate: formattedDate(intent.dueDate),
      subtotal: intent.subtotal,
      taxAmount: intent.taxAmount,
      total: intent.total,
      lineItems: intent.lineItems,
      xeroPreflight: preflight[index] ?? null,
    })),
    issues: evaluation.issues,
  };
}

function compareArray(field: string, expected: unknown[] | undefined, actual: unknown[]): ShadowFieldComparison[] {
  if (expected === undefined) return [];
  const max = Math.max(expected.length, actual.length);
  return Array.from({ length: max }, (_, index) => {
    const wanted = expected[index];
    const received = actual[index];
    const isNumber = typeof wanted === "number";
    const matches = isNumber ? Number(wanted) === Number(received) : String(wanted ?? "") === String(received ?? "");
    return {
      field: `${field}[${index}]`, expected: wanted ?? null, actual: received ?? null,
      outcome: matches ? "match" : "different",
      explanation: matches ? "Expected and actual values match." : "Expected and actual values differ.",
    };
  });
}

/**
 * Compares only business-supplied expected facts. Missing expectations never
 * become an invented pass: callers label the test needs-data until a business
 * owner supplies them.
 */
export function compareShadowExpectedResult(
  expected: ShadowExpectedResult,
  evaluation: FinancialWorkflowEvaluation,
  preflight: FinancialXeroPreflight[],
): { actual: ReturnType<typeof actualResult>; comparisons: ShadowFieldComparison[]; hasExpectedFacts: boolean } {
  const actual = actualResult(evaluation, preflight);
  const intents = actual.intents;
  const comparisons: ShadowFieldComparison[] = [
    ...compareArray("proposedDocumentNumbers", expected.proposedDocumentNumbers, intents.map((intent) => intent.proposedDocumentNumber)),
    ...compareArray("partyNames", expected.partyNames, intents.map((intent) => intent.partyName)),
    ...compareArray("accountCodes", expected.accountCodes, intents.map((intent) => intent.accountCode)),
    ...compareArray("gstTreatments", expected.gstTreatments, intents.map((intent) => intent.gstTreatment)),
    ...compareArray("issueDates", expected.issueDates, intents.map((intent) => intent.issueDate)),
    ...compareArray("dueDates", expected.dueDates, intents.map((intent) => intent.dueDate)),
    ...compareArray("totals", expected.totals, intents.map((intent) => intent.total)),
    ...compareArray("lineCounts", expected.lineCounts, intents.map((intent) => intent.lineItems.length)),
    ...compareArray("itemCodes", expected.itemCodes, intents.flatMap((intent) => intent.lineItems.map((line) => line.itemCode))),
  ];
  for (const [path, wanted] of Object.entries(expected.assertions ?? {})) {
    const received = getPath(actual, path);
    const matches = typeof wanted === "number" ? Number(wanted) === Number(received) : wanted === received;
    comparisons.push({
      field: path, expected: wanted, actual: received ?? null, outcome: matches ? "match" : "different",
      explanation: matches ? "Expected and actual values match." : "Expected and actual values differ.",
    });
  }
  const hasExpectedFacts = comparisons.length > 0;
  return { actual, comparisons, hasExpectedFacts };
}

/**
 * Builds a reviewable expected-facts draft from the active, non-secret AP
 * rules and the deterministic evaluation. This helper never marks a test as
 * passed: an administrator must confirm/reject the evidence with a comment.
 */
export function deriveRulesBasedExpectedFacts(
  evaluation: FinancialWorkflowEvaluation,
  rules: FinancialAutomationRules,
  liveSource: Record<string, unknown>,
): RulesBasedExpectedFacts {
  const intents = evaluation.intents;
  const expectedResult: ShadowExpectedResult = {
    proposedDocumentNumbers: intents.map((intent) => intent.proposedDocumentNumber ?? ""),
    partyNames: intents.map((intent) => intent.partyName ?? ""),
    accountCodes: intents.map((intent) => intent.accountCode ?? ""),
    itemCodes: intents.flatMap((intent) => intent.lineItems.map((line) => line.itemCode)),
    gstTreatments: intents.map((intent) => intent.gstTreatment),
    issueDates: intents.map((intent) => formattedDate(intent.issueDate)),
    dueDates: intents.map((intent) => formattedDate(intent.dueDate)),
    totals: intents.map((intent) => intent.total),
    lineCounts: intents.map((intent) => intent.lineItems.length),
    assertions: Object.fromEntries(intents.flatMap((intent, intentIndex) => intent.lineItems.flatMap((line, lineIndex) => [
      [`intents.${intentIndex}.lineItems.${lineIndex}.description`, line.description],
      [`intents.${intentIndex}.lineItems.${lineIndex}.quantity`, line.quantity],
      [`intents.${intentIndex}.lineItems.${lineIndex}.unitAmount`, line.unitAmount],
      [`intents.${intentIndex}.lineItems.${lineIndex}.accountCode`, line.accountCode],
      [`intents.${intentIndex}.lineItems.${lineIndex}.gstTreatment`, line.gstTreatment],
    ]))),
  };
  const sourceValue = (...keys: string[]) => {
    for (const key of keys) if (liveSource[key] !== undefined && liveSource[key] !== null && liveSource[key] !== "") return liveSource[key];
    return null;
  };
  return {
    expectedResult,
    ruleFacts: [
      { field: "GST", configuredRule: `${rules.defaults.gstRatePercent}%`, liveSourceValue: sourceValue("taxRate", "gstRate"), explanation: "GST treatment and totals use the active AP rule configuration." },
      { field: "Recurring hire eligibility", configuredRule: rules.validation.allowedRecurringHireStatuses, liveSourceValue: sourceValue("hireStatus", "status", "containerStatus"), explanation: "Only the configured eligible hire statuses may propose recurring hire." },
      { field: "Initial hire fallback", configuredRule: { twentyFootExGst: rules.rates.initialHire20MonthlyExGst, fortyFootExGst: rules.rates.initialHire40MonthlyExGst }, liveSourceValue: sourceValue("hireCost", "sourceCost", "monthlyHireCost"), explanation: "Fallback pricing applies only when the live source hire cost is blank." },
      { field: "Extra hire default", configuredRule: { weeks: rules.defaults.extraHireWeeks, twentyFootWeeklyExGst: rules.rates.extraHire20WeeklyExGst, fortyFootWeeklyExGst: rules.rates.extraHire40WeeklyExGst }, liveSourceValue: sourceValue("hireEndDate", "hireDurationDays"), explanation: "Extra-hire quantity/rate comes from active AP rules and live hire dates/type." },
      { field: "Draft status guard", configuredRule: rules.validation.mainInvoiceDraftStatus, liveSourceValue: sourceValue("mainInvoiceStatus", "invoiceStatus"), explanation: "Any non-Draft source/Xero conflict remains held for review." },
    ],
  };
}

function resolveMappedValue(raw: Record<string, unknown>, candidate: unknown): unknown {
  const paths = Array.isArray(candidate) ? candidate : [candidate];
  for (const path of paths) {
    if (typeof path !== "string" || !path.trim()) continue;
    const value = getPath(raw, path.trim());
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * Keeps a complete raw VTiger snapshot while projecting administrator-defined
 * field aliases into evaluator field names. Mappings are non-secret config such
 * as { "shared": { "customerOrganisationName": ["accountname", "org_name"] } }.
 */
export function mapVtigerFinancialSource(
  rawSource: Record<string, unknown>,
  mapping: FinancialSourceMapping | undefined,
  workflowType: FinancialWorkflowType,
): { sourceData: Record<string, unknown>; appliedMappings: Array<{ target: string; source: string | string[] }> } {
  const sourceData = { ...rawSource };
  const map = mapping && typeof mapping === "object" && !Array.isArray(mapping) ? mapping as Record<string, unknown> : {};
  const shared = map.shared && typeof map.shared === "object" && !Array.isArray(map.shared) ? map.shared as Record<string, unknown> : {};
  const workflow = map[workflowType] && typeof map[workflowType] === "object" && !Array.isArray(map[workflowType]) ? map[workflowType] as Record<string, unknown> : {};
  const appliedMappings: Array<{ target: string; source: string | string[] }> = [];
  for (const [target, candidate] of Object.entries({ ...shared, ...workflow })) {
    const value = resolveMappedValue(rawSource, candidate);
    if (value === undefined) continue;
    sourceData[target] = value;
    appliedMappings.push({ target, source: Array.isArray(candidate) ? candidate.filter((entry): entry is string => typeof entry === "string") : String(candidate) });
  }
  return { sourceData, appliedMappings };
}

export function sourceRecordNumberFromVtiger(raw: Record<string, unknown>): string | undefined {
  const candidates = ["dealNumber", "deal_number", "potentials_no", "potential_no", "containerControlNumber", "container_control_number", "cf_deal_number"];
  for (const key of candidates) {
    const value = asText(raw[key]);
    if (value) return value;
  }
  return undefined;
}

export function sourceRefreshTimeFromVtiger(raw: Record<string, unknown>, readAt: Date): Date {
  const candidates = ["modifiedtime", "modifiedTime", "updated_at", "updatedAt", "createdtime"];
  for (const key of candidates) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return readAt;
}
