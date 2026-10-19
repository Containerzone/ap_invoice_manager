import axios from "axios";
import { createHash } from "node:crypto";
import { retryReadOnceWhen } from "./transientReadRetry";

export type VtigerFinancialConnectionStatus = {
  configured: boolean;
  missing: Array<"VTIGER_URL" | "VTIGER_USERNAME" | "VTIGER_ACCESS_KEY">;
};

export type VtigerFinancialConnectionTest = VtigerFinancialConnectionStatus & {
  outcome: "passed" | "blocked" | "failed";
  checkedAt: Date;
  message: string;
};

function config() {
  const url = process.env.VTIGER_URL?.trim().replace(/\/$/, "") ?? "";
  const username = process.env.VTIGER_USERNAME?.trim() ?? "";
  const accessKey = process.env.VTIGER_ACCESS_KEY?.trim() ?? "";
  return { url, username, accessKey };
}

/** Reports configuration presence only; credentials and tokens are never returned. */
export function getVtigerFinancialConnectionStatus(): VtigerFinancialConnectionStatus {
  const values = config();
  const missing: VtigerFinancialConnectionStatus["missing"] = [];
  if (!values.url) missing.push("VTIGER_URL");
  if (!values.username) missing.push("VTIGER_USERNAME");
  if (!values.accessKey) missing.push("VTIGER_ACCESS_KEY");
  return { configured: missing.length === 0, missing };
}

function endpoint(): string {
  const { url } = config();
  if (!url) throw new Error("VTiger is not configured for read-only financial shadow evaluation");
  return `${url}/webservice.php`;
}

function validRecordId(recordId: string): boolean {
  // VTiger webservice records are IDs such as 4x12345. Restricting the format
  // avoids turning this read-only helper into an arbitrary upstream request.
  return /^\d+x\d+$/i.test(recordId.trim());
}

function isTransientVtigerReadFailure(error: unknown): boolean {
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code.toUpperCase()
    : "";
  if (["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) return true;
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  if ([502, 503, 504].includes(status as number)) return true;
  return error instanceof Error && /\b(?:ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN)\b/i.test(error.message);
}

async function vtigerGetRead<T>(params: Record<string, string>): Promise<T> {
  const response = await axios.get(endpoint(), { params, timeout: 20_000 });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger read request failed");
  return response.data.result as T;
}

/** Each idempotent VTiger GET may be retried once for a transport/gateway failure. */
async function vtigerRequest<T>(params: Record<string, string>): Promise<T> {
  return retryReadOnceWhen(() => vtigerGetRead<T>(params), isTransientVtigerReadFailure);
}

/**
 * VTiger's documented login endpoint requires form-urlencoded POST data. This
 * authenticates a short-lived session only; it does not create or alter a CRM
 * record, workflow URL or schedule.
 */
async function vtigerLogin<T>(params: Record<string, string>): Promise<T> {
  const response = await axios.post(endpoint(), new URLSearchParams(params).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger login request failed");
  return response.data.result as T;
}

function isTransientVtigerLoginRejection(error: unknown): boolean {
  return error instanceof Error && /invalid username or password/i.test(error.message);
}

/**
 * Opens a short-lived read-only session. Each idempotent GET has its own
 * bounded transport/gateway retry. VTiger's known intermittent login rejection
 * receives at most one new challenge/login cycle; it cannot replay a CRM or
 * Xero write and the second rejection is returned as a hold.
 */
async function readOnlyVtigerSession(): Promise<string> {
  const { username, accessKey } = config();
  const status = getVtigerFinancialConnectionStatus();
  if (!status.configured || !username || !accessKey)
    throw new Error("VTiger is not configured for read-only financial evaluation.");
  return retryReadOnceWhen(async () => {
    const challenge = await vtigerRequest<{ token?: string }>({
      operation: "getchallenge",
      username,
    });
    if (!challenge?.token)
      throw new Error("VTiger challenge did not return a usable temporary token.");
    const accessKeyHash = createHash("md5")
      .update(`${challenge.token}${accessKey}`)
      .digest("hex");
    const login = await vtigerLogin<{ sessionName?: string }>({
      operation: "login",
      username,
      accessKey: accessKeyHash,
    });
    if (!login?.sessionName)
      throw new Error("VTiger read-only login did not return a usable session.");
    return login.sessionName;
  }, isTransientVtigerLoginRejection);
}

function safeMessage(error: unknown): string {
  const response = (error as any)?.response;
  if (response?.status === 401 || response?.status === 403) return "VTiger rejected the configured AP Management credentials.";
  if (typeof response?.status === "number") return `VTiger read request returned HTTP ${response.status}.`;
  return error instanceof Error ? error.message : "VTiger read request could not be completed.";
}

/**
 * Verifies the configured credential through VTiger's documented GET challenge
 * plus form-POST login exchange. A challenge only proves that the username is
 * recognised; a login is required before reporting the AP read credential as
 * healthy. It never creates a record, changes a workflow URL or invokes a CRM
 * mutation.
 */
export async function testVtigerFinancialConnection(): Promise<VtigerFinancialConnectionTest> {
  const status = getVtigerFinancialConnectionStatus();
  const checkedAt = new Date();
  if (!status.configured) return { ...status, outcome: "blocked", checkedAt, message: "VTiger read-only configuration is incomplete." };
  try {
    await readOnlyVtigerSession();
    return { ...status, outcome: "passed", checkedAt, message: "Read-only VTiger challenge and documented form-login passed. No CRM record, workflow URL or schedule was changed." };
  } catch (error) {
    return { ...status, outcome: "failed", checkedAt, message: safeMessage(error) };
  }
}

/**
 * Retrieves the current VTiger record using the standard GET challenge,
 * form-POST login and GET retrieve API. It establishes no workflow or Xero side
 * effect. The session token is held in memory for this request only.
 */
export async function retrieveCurrentVtigerFinancialRecord(recordId: string): Promise<Record<string, unknown>> {
  if (!validRecordId(recordId)) throw new Error("VTiger record ID must use the standard moduleId x recordId format");
  const sessionName = await readOnlyVtigerSession();
  return vtigerRequest<Record<string, unknown>>({ operation: "retrieve", id: recordId.trim(), sessionName });
}

/** One bounded, exact, read-only query for a human-readable VTiger reference. */
export async function queryCurrentVtigerFinancialRecords(moduleName: string, fieldName: string, value: string): Promise<Array<Record<string, unknown>>> {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(moduleName) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)) throw new Error("VTiger query module or field is invalid.");
  const exactValue = value.trim();
  if (!exactValue || exactValue.length > 128 || /[\r\n]/.test(exactValue)) throw new Error("VTiger exact query value is invalid.");
  const sessionName = await readOnlyVtigerSession();
  const escaped = exactValue.replace(/'/g, "''");
  const result = await vtigerRequest<unknown>({ operation: "query", query: `select * from ${moduleName} where ${fieldName}='${escaped}';`, sessionName });
  const records: unknown[] = Array.isArray((result as any)?.records) ? (result as any).records : Array.isArray(result) ? result : [];
  return records.filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === "object");
}

/**
 * Reads VTiger module metadata through the authenticated GET-only webservice
 * API. It validates disabled post-success mapping configuration and never
 * creates a note/task or changes a source record.
 */
export async function describeVtigerFinancialModule(moduleName: string): Promise<{ name: string; fields: string[] }> {
  const described = await describeVtigerFinancialModuleFields(moduleName);
  return { name: described.name, fields: described.fields.map((field) => field.name) };
}

/** Authenticated metadata-only describe; labels/picklist values come from VTiger, not guessed field aliases. */
export async function describeVtigerFinancialModuleFields(moduleName: string): Promise<{
  name: string;
  idPrefix?: string;
  fields: Array<{ name: string; label: string; type: Record<string, unknown>; mandatory: boolean }>;
}> {
  const normalized = moduleName.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalized)) throw new Error("VTiger module name is invalid.");
  const sessionName = await readOnlyVtigerSession();
  const described = await vtigerRequest<{ name?: string; idPrefix?: string; fields?: Array<{ name?: string; label?: string; type?: Record<string, unknown>; mandatory?: boolean }> }>({
    operation: "describe",
    elementType: normalized,
    sessionName,
  });
  return {
    name: typeof described?.name === "string" ? described.name : normalized,
    ...(described?.idPrefix ? { idPrefix: String(described.idPrefix) } : {}),
    fields: (described?.fields ?? []).filter((field): field is typeof field & { name: string } => typeof field?.name === "string" && Boolean(field.name))
      .map((field) => ({ name: field.name, label: field.label ?? "", type: field.type ?? {}, mandatory: field.mandatory === true })),
  };
}
