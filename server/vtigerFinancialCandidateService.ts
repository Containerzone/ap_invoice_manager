import axios from "axios";
import { createHash } from "node:crypto";

export type FinancialCandidateCategory = "deal" | "container_control";

export type FinancialCandidateFinderRule = {
  module: string;
  businessNumberFields: string[];
  selectFields: string[];
};

export type FinancialCandidateFinderConfig = Record<FinancialCandidateCategory, FinancialCandidateFinderRule[]>;

export type FinancialCandidate = {
  recordId: string;
  module: string;
  matchedField: string;
  sourceCategory: FinancialCandidateCategory;
  businessNumber: string;
  sourceRefreshedAt: Date | null;
  summary: Record<string, unknown>;
};

export type FinancialCandidateLookup = {
  outcome: "found" | "not_found" | "ambiguous" | "blocked";
  sourceCategory: FinancialCandidateCategory;
  businessNumber: string;
  candidates: FinancialCandidate[];
  message: string;
};

/**
 * These are safe starting aliases only. An administrator can adjust non-secret
 * aliases in Financial Automation Settings when their own VTiger fields differ.
 * Every actual lookup remains an exact equality search for one business number.
 */
export const DEFAULT_FINANCIAL_CANDIDATE_FINDER_CONFIG: FinancialCandidateFinderConfig = {
  deal: [{
    module: "Potentials",
    businessNumberFields: ["potentials_no", "potential_no", "cf_deal_number", "deal_number"],
    // Verified against this VTiger instance's Potentials metadata. Keep the
    // default projection deliberately narrow: a single unavailable custom
    // field makes VTiger reject the whole exact query, even when the matching
    // business-number field itself is valid.
    selectFields: ["id", "potential_no", "potentialname", "modifiedtime"],
  }],
  container_control: [{
    module: "ContainerControl",
    businessNumberFields: ["container_control_no", "cf_container_control", "container_control_number", "name"],
    selectFields: ["id", "container_control_no", "cf_container_control", "container_control_number", "name", "accountname", "modifiedtime"],
  }],
};

function config() {
  const url = process.env.VTIGER_URL?.trim().replace(/\/$/, "") ?? "";
  const username = process.env.VTIGER_USERNAME?.trim() ?? "";
  const accessKey = process.env.VTIGER_ACCESS_KEY?.trim() ?? "";
  return { url, username, accessKey };
}

function endpoint() {
  const { url } = config();
  if (!url) throw new Error("VTiger is not configured for candidate discovery.");
  return `${url}/webservice.php`;
}

function safeIdentifier(value: string): string | null {
  const normalized = value.trim();
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(normalized) ? normalized : null;
}

function safeBusinessNumber(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f]/.test(normalized)) return null;
  return normalized;
}

function exactLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function uniqueValid(values: string[], max: number): string[] {
  return Array.from(new Set(values.map(safeIdentifier).filter((value): value is string => Boolean(value)))).slice(0, max);
}

function normalizeRules(candidate: unknown): FinancialCandidateFinderConfig {
  const input = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
  const normalizeCategory = (category: FinancialCandidateCategory) => {
    const rules = Array.isArray(input[category]) ? input[category] : DEFAULT_FINANCIAL_CANDIDATE_FINDER_CONFIG[category];
    return rules.slice(0, 5).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const rule = item as Record<string, unknown>;
      const module = typeof rule.module === "string" ? safeIdentifier(rule.module) : null;
      const businessNumberFields = Array.isArray(rule.businessNumberFields)
        ? uniqueValid(rule.businessNumberFields.filter((field): field is string => typeof field === "string"), 8)
        : [];
      const selectFields = Array.isArray(rule.selectFields)
        ? uniqueValid(rule.selectFields.filter((field): field is string => typeof field === "string"), 12)
        : [];
      if (!module || businessNumberFields.length === 0) return [];
      return [{ module, businessNumberFields, selectFields: Array.from(new Set(["id", ...selectFields])).slice(0, 12) }];
    });
  };
  return { deal: normalizeCategory("deal"), container_control: normalizeCategory("container_control") };
}

async function request<T>(params: Record<string, string>): Promise<T> {
  const response = await axios.get(endpoint(), { params, timeout: 20_000 });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger read request failed");
  return response.data.result as T;
}

/** VTiger requires form-urlencoded POST transport for session login only. */
async function login<T>(params: Record<string, string>): Promise<T> {
  const response = await axios.post(endpoint(), new URLSearchParams(params).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger login request failed");
  return response.data.result as T;
}

async function readOnlySession(): Promise<string> {
  const { username, accessKey } = config();
  if (!username || !accessKey || !config().url) throw new Error("VTiger is not configured for AP-side candidate discovery.");
  const challenge = await request<{ token?: string }>({ operation: "getchallenge", username });
  if (!challenge?.token) throw new Error("VTiger challenge did not return a token.");
  const accessKeyHash = createHash("md5").update(`${challenge.token}${accessKey}`).digest("hex");
  const session = await login<{ sessionName?: string }>({ operation: "login", username, accessKey: accessKeyHash });
  if (!session?.sessionName) throw new Error("VTiger read-only login did not return a session.");
  return session.sessionName;
}

function sourceRefreshedAt(row: Record<string, unknown>): Date | null {
  for (const key of ["modifiedtime", "modifiedTime", "updated_at", "updatedAt", "createdtime"]) {
    const value = row[key];
    if (typeof value !== "string") continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function messageFor(error: unknown): string {
  const status = (error as any)?.response?.status;
  if (status === 401 || status === 403) return "VTiger rejected AP Management's read-only credentials.";
  if (typeof status === "number") return `VTiger candidate lookup returned HTTP ${status}.`;
  return error instanceof Error ? error.message : "VTiger candidate lookup could not be completed.";
}

/**
 * Finds at most two exact matches for one named Deal or Container Control. It
 * issues a GET challenge, a form-POST login and GET exact-query calls only. It
 * never enumerates a module or writes a CRM record.
 */
export async function findExactFinancialCandidate(input: {
  sourceCategory: FinancialCandidateCategory;
  businessNumber: string;
  configuration?: unknown;
}): Promise<FinancialCandidateLookup> {
  const businessNumber = safeBusinessNumber(input.businessNumber);
  if (!businessNumber) throw new Error("Enter one valid business number for candidate discovery.");
  const rules = normalizeRules(input.configuration);
  const categoryRules = rules[input.sourceCategory];
  if (categoryRules.length === 0) {
    return { outcome: "blocked", sourceCategory: input.sourceCategory, businessNumber, candidates: [], message: "No valid non-secret VTiger candidate finder rule is configured for this source category." };
  }
  try {
    const sessionName = await readOnlySession();
    const candidates = new Map<string, FinancialCandidate>();
    const queryProblems: string[] = [];
    let successfulQueries = 0;
    for (const rule of categoryRules) {
      for (const field of rule.businessNumberFields) {
        const query = `SELECT ${rule.selectFields.join(",")} FROM ${rule.module} WHERE ${field} = ${exactLiteral(businessNumber)};`;
        let rows: Array<Record<string, unknown>>;
        try {
          rows = await request<Array<Record<string, unknown>>>({ operation: "query", sessionName, query });
          successfulQueries += 1;
        } catch (error) {
          queryProblems.push(`${rule.module}.${field}`);
          continue;
        }
        for (const row of rows.slice(0, 2)) {
          const recordId = typeof row.id === "string" ? row.id.trim() : "";
          if (!/^\d+x\d+$/i.test(recordId)) continue;
          candidates.set(recordId, {
            recordId,
            module: rule.module,
            matchedField: field,
            sourceCategory: input.sourceCategory,
            businessNumber,
            sourceRefreshedAt: sourceRefreshedAt(row),
            summary: row,
          });
          if (candidates.size >= 2) break;
        }
        if (candidates.size >= 2) break;
      }
      if (candidates.size >= 2) break;
    }
    const result = Array.from(candidates.values());
    if (result.length === 0 && successfulQueries === 0) return { outcome: "blocked", sourceCategory: input.sourceCategory, businessNumber, candidates: [], message: `VTiger rejected every configured exact candidate alias (${queryProblems.join(", ") || "none"}). Review AP-side candidate finder field configuration.` };
    if (result.length === 0) return { outcome: "not_found", sourceCategory: input.sourceCategory, businessNumber, candidates: [], message: "No exact VTiger candidate matched this business number in the configured AP-side fields." };
    if (result.length > 1) return { outcome: "ambiguous", sourceCategory: input.sourceCategory, businessNumber, candidates: result, message: "More than one exact VTiger record matched. Select the correct record before creating shadow evidence." };
    return { outcome: "found", sourceCategory: input.sourceCategory, businessNumber, candidates: result, message: "Exact VTiger candidate found through AP Management's read-only lookup." };
  } catch (error) {
    return { outcome: "blocked", sourceCategory: input.sourceCategory, businessNumber, candidates: [], message: messageFor(error) };
  }
}

export function getFinancialCandidateFinderConfig(candidate?: unknown): FinancialCandidateFinderConfig {
  return normalizeRules(candidate);
}

export type CurrentFinancialCandidatePredicate = {
  field: string;
  operator: "equals" | "not_empty";
  value?: string;
};

export type CurrentFinancialCandidateQuery = {
  module: string;
  sourceCategory: FinancialCandidateCategory;
  selectFields: string[];
  predicates: CurrentFinancialCandidatePredicate[];
  sortField: string;
  eligibilityReasons: string[];
};

export type CurrentFinancialCandidateLookup = {
  outcome: "found" | "no_current_candidate" | "blocked";
  sourceCategory: FinancialCandidateCategory;
  candidates: Array<FinancialCandidate & { eligibilityReasons: string[] }>;
  message: string;
};

function safeCurrentPredicate(value: unknown): CurrentFinancialCandidatePredicate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const field = typeof row.field === "string" ? safeIdentifier(row.field) : null;
  const operator = row.operator === "equals" || row.operator === "not_empty" ? row.operator : null;
  const exactValue = typeof row.value === "string" ? safeBusinessNumber(row.value) : null;
  if (!field || !operator || (operator === "equals" && !exactValue)) return null;
  return { field, operator, value: exactValue ?? undefined };
}

function normalizeCurrentQuery(value: CurrentFinancialCandidateQuery): CurrentFinancialCandidateQuery | null {
  const module = safeIdentifier(value.module);
  const sourceCategory = value.sourceCategory === "deal" || value.sourceCategory === "container_control" ? value.sourceCategory : null;
  const selectFields = uniqueValid(value.selectFields, 16);
  const predicates = value.predicates.map(safeCurrentPredicate).filter((entry): entry is CurrentFinancialCandidatePredicate => Boolean(entry)).slice(0, 6);
  const sortField = safeIdentifier(value.sortField);
  const eligibilityReasons = Array.from(new Set(value.eligibilityReasons.map((entry) => entry.trim()).filter(Boolean))).slice(0, 12);
  // A discovery without a positive current-eligibility predicate would become a
  // broad CRM enumeration, so it is deliberately rejected.
  if (!module || !sourceCategory || !sortField || selectFields.length === 0 || predicates.length === 0) return null;
  return {
    module,
    sourceCategory,
    selectFields: Array.from(new Set(["id", ...selectFields])).slice(0, 16),
    predicates,
    sortField,
    eligibilityReasons,
  };
}

function currentQueryText(query: CurrentFinancialCandidateQuery): string {
  const where = query.predicates.map((predicate) => predicate.operator === "not_empty"
    ? `${predicate.field} != ''`
    : `${predicate.field} = ${exactLiteral(predicate.value!)}`,
  ).join(" AND ");
  return `SELECT ${query.selectFields.join(",")} FROM ${query.module} WHERE ${where} ORDER BY ${query.sortField} DESC LIMIT 10;`;
}

/**
 * Finds at most ten **current** candidates across explicit, positive VTiger
 * predicates. This is intentionally separate from the older exact-reference
 * finder: callers must provide a narrow current-state query for one family and
 * this helper rejects any unbounded or historical-style scan.
 *
 * Authentication is the same GET challenge + form POST session login used by
 * the exact finder; every record query is a GET and no CRM data is changed.
 */
export async function findCurrentFinancialCandidates(input: {
  sourceCategory: FinancialCandidateCategory;
  queries: CurrentFinancialCandidateQuery[];
}): Promise<CurrentFinancialCandidateLookup> {
  const configured = input.queries
    .filter((query) => query.sourceCategory === input.sourceCategory)
    .map(normalizeCurrentQuery)
    .filter((query): query is CurrentFinancialCandidateQuery => Boolean(query))
    .slice(0, 4);
  if (configured.length === 0) {
    return {
      outcome: "blocked",
      sourceCategory: input.sourceCategory,
      candidates: [],
      message: "No bounded AP-side current-candidate field mapping is configured for this family. Configure a current status/stage predicate before discovery; AP will not enumerate VTiger.",
    };
  }

  try {
    const sessionName = await readOnlySession();
    const candidates = new Map<string, FinancialCandidate & { eligibilityReasons: string[] }>();
    const failures: string[] = [];
    let successfulQueries = 0;
    for (const query of configured) {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await request<Array<Record<string, unknown>>>({ operation: "query", sessionName, query: currentQueryText(query) });
        successfulQueries += 1;
      } catch {
        failures.push(`${query.module}.${query.sortField}`);
        continue;
      }
      for (const row of rows.slice(0, 10)) {
        const recordId = typeof row.id === "string" ? row.id.trim() : "";
        if (!/^\d+x\d+$/i.test(recordId)) continue;
        const businessNumber = ["potential_no", "potentials_no", "container_control_no", "container_control_number", "name"]
          .map((key) => row[key])
          .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? recordId;
        const existing = candidates.get(recordId);
        candidates.set(recordId, {
          recordId,
          module: query.module,
          matchedField: "current_eligibility",
          sourceCategory: input.sourceCategory,
          businessNumber,
          sourceRefreshedAt: sourceRefreshedAt(row),
          summary: row,
          eligibilityReasons: Array.from(new Set([...(existing?.eligibilityReasons ?? []), ...query.eligibilityReasons])),
        });
        if (candidates.size >= 10) break;
      }
      if (candidates.size >= 10) break;
    }
    if (successfulQueries === 0) {
      return {
        outcome: "blocked",
        sourceCategory: input.sourceCategory,
        candidates: [],
        message: `VTiger rejected each configured bounded current-candidate query (${failures.join(", ") || "none"}). Review AP-side field mapping; no broad fallback was attempted.`,
      };
    }
    const sorted = Array.from(candidates.values())
      .sort((left, right) => (right.sourceRefreshedAt?.getTime() ?? 0) - (left.sourceRefreshedAt?.getTime() ?? 0))
      .slice(0, 10);
    if (sorted.length === 0) {
      return {
        outcome: "no_current_candidate",
        sourceCategory: input.sourceCategory,
        candidates: [],
        message: "NO_CURRENT_CANDIDATE: the bounded current-eligibility query returned no records. This is a factual readiness result, not a pass or failure.",
      };
    }
    return {
      outcome: "found",
      sourceCategory: input.sourceCategory,
      candidates: sorted,
      message: `Found ${sorted.length} bounded current review candidate${sorted.length === 1 ? "" : "s"}. Administrator selection is still required before Candidate Roster evidence can be created.`,
    };
  } catch (error) {
    return { outcome: "blocked", sourceCategory: input.sourceCategory, candidates: [], message: messageFor(error) };
  }
}
