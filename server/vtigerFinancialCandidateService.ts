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
    selectFields: ["id", "potentials_no", "potential_no", "cf_deal_number", "accountname", "cf_container_control", "modifiedtime"],
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

async function readOnlySession(): Promise<string> {
  const { username, accessKey } = config();
  if (!username || !accessKey || !config().url) throw new Error("VTiger is not configured for AP-side candidate discovery.");
  const challenge = await request<{ token?: string }>({ operation: "getchallenge", username });
  if (!challenge?.token) throw new Error("VTiger challenge did not return a token.");
  const accessKeyHash = createHash("md5").update(`${challenge.token}${accessKey}`).digest("hex");
  const login = await request<{ sessionName?: string }>({ operation: "login", username, accessKey: accessKeyHash });
  if (!login?.sessionName) throw new Error("VTiger read-only login did not return a session.");
  return login.sessionName;
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
 * issues GET challenge/login/query calls only and never enumerates a module.
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
    return { outcome: "found", sourceCategory: input.sourceCategory, businessNumber, candidates: result, message: "Exact VTiger candidate found through AP Management's GET-only lookup." };
  } catch (error) {
    return { outcome: "blocked", sourceCategory: input.sourceCategory, businessNumber, candidates: [], message: messageFor(error) };
  }
}

export function getFinancialCandidateFinderConfig(candidate?: unknown): FinancialCandidateFinderConfig {
  return normalizeRules(candidate);
}
