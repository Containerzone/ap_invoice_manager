import axios from "axios";
import { AsyncLocalStorage } from "node:async_hooks";
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

/** A deliberately narrow authenticated capability for other financial read helpers. */
export type VtigerFinancialReadSession = {
  query<T>(query: string): Promise<T>;
};

type AuthenticatedVtigerFinancialReadSession = VtigerFinancialReadSession & {
  request<T>(params: Record<string, string>): Promise<T>;
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

function retryAfterHeader(error: unknown): unknown {
  const response = (error as { response?: { status?: unknown; headers?: unknown } })?.response;
  // Do not infer throttling from any other response or a date-form header: this
  // narrow exception exists only for a literal 429 Retry-After response.
  if (response?.status !== 429 || !response.headers) return undefined;
  const headers = response.headers as { get?: (name: string) => unknown } & Record<string, unknown>;
  if (typeof headers.get === "function") {
    const value = headers.get("retry-after");
    if (value !== undefined && value !== null) return value;
  }
  return Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
}

/** Returns a bounded delay only for an explicit numeric Retry-After value. */
function retryAfterDelayMs(error: unknown): number | null {
  const value = retryAfterHeader(error);
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+(?:\.\d+)?$/.test(String(value))) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 5) return null;
  return Math.ceil(seconds * 1_000);
}

function financialReadRetryDelayMs(error: unknown): number | null {
  const retryAfterDelay = retryAfterDelayMs(error);
  if (retryAfterDelay !== null) return retryAfterDelay;
  return isTransientVtigerReadFailure(error) ? 250 : null;
}

async function vtigerGetRead<T>(params: Record<string, string>): Promise<T> {
  const response = await axios.get(endpoint(), { params, timeout: 20_000 });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger read request failed");
  return response.data.result as T;
}

/**
 * Executes an idempotent VTiger GET with at most one retry. Existing transport
 * and gateway failures wait 250ms. A 429 gets the same one retry only when its
 * literal Retry-After header is numeric and no more than five seconds.
 */
async function vtigerRequest<T>(params: Record<string, string>): Promise<T> {
  try {
    return await vtigerGetRead<T>(params);
  } catch (error) {
    const retryDelayMs = financialReadRetryDelayMs(error);
    if (retryDelayMs === null) throw error;
    if (retryDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    return vtigerGetRead<T>(params);
  }
}

/**
 * VTiger's documented login endpoint requires form-urlencoded POST data. This
 * authenticates a short-lived session only; it does not create or alter a CRM
 * record, workflow URL or schedule. It is intentionally never transport-retried.
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

/** Opens one fresh challenge/form-login cycle; only a known VTiger rejection can trigger a second cycle. */
async function openReadOnlyVtigerSession(): Promise<string> {
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

// A live lease is shared only by overlapping financial read operations. It
// prevents concurrent source reads from opening duplicate sessions, but no token
// is retained after the final caller completes.
let activeReadOnlySession: Promise<string> | undefined;
let activeReadOnlySessionUsers = 0;
// Source helpers call the exported retrieve/query/describe functions rather
// than receiving an authenticated transport. Keep the authenticated capability
// private, but make it available to those nested calls for the lifetime of the
// outer read scope only. This avoids treating an unrelated overlapping source
// read as the parent of a nested operation.
const financialReadSessionContext = new AsyncLocalStorage<AuthenticatedVtigerFinancialReadSession>();

async function withAuthenticatedVtigerFinancialReadSession<T>(operation: (session: AuthenticatedVtigerFinancialReadSession) => Promise<T>): Promise<T> {
  const contextualSession = financialReadSessionContext.getStore();
  if (contextualSession) return operation(contextualSession);

  if (!activeReadOnlySession) activeReadOnlySession = openReadOnlyVtigerSession();
  const sessionPromise = activeReadOnlySession;
  activeReadOnlySessionUsers += 1;
  let sessionActive = false;
  let sessionName: string | undefined;
  try {
    sessionName = await sessionPromise;
    sessionActive = true;
    const request = <Result>(params: Record<string, string>) => {
      if (!sessionActive || !sessionName) throw new Error("VTiger financial read session scope has ended.");
      return vtigerRequest<Result>({ ...params, sessionName });
    };
    const session: AuthenticatedVtigerFinancialReadSession = {
      request,
      query: <Result>(query: string) => request<Result>({ operation: "query", query }),
    };
    return await financialReadSessionContext.run(session, () => operation(session));
  } finally {
    sessionActive = false;
    sessionName = undefined;
    activeReadOnlySessionUsers -= 1;
    if (activeReadOnlySessionUsers === 0 && activeReadOnlySession === sessionPromise) activeReadOnlySession = undefined;
  }
}

/**
 * Runs a bounded financial source read through the shared GET-only session.
 * Callers receive query capability only: no endpoint, credentials, session name,
 * or POST transport is exposed.
 */
export async function withVtigerFinancialReadSession<T>(operation: (session: VtigerFinancialReadSession) => Promise<T>): Promise<T> {
  return withAuthenticatedVtigerFinancialReadSession(async (session) => operation({ query: session.query }));
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
    await withAuthenticatedVtigerFinancialReadSession(async () => undefined);
    return { ...status, outcome: "passed", checkedAt, message: "Read-only VTiger challenge and documented form-login passed. No CRM record, workflow URL or schedule was changed." };
  } catch (error) {
    return { ...status, outcome: "failed", checkedAt, message: safeMessage(error) };
  }
}

/**
 * Retrieves the current VTiger record using the standard GET challenge,
 * form-POST login and GET retrieve API. It establishes no workflow or Xero side
 * effect. The session is shared only with overlapping financial source reads.
 */
export async function retrieveCurrentVtigerFinancialRecord(recordId: string): Promise<Record<string, unknown>> {
  if (!validRecordId(recordId)) throw new Error("VTiger record ID must use the standard moduleId x recordId format");
  return withAuthenticatedVtigerFinancialReadSession((session) => session.request<Record<string, unknown>>({ operation: "retrieve", id: recordId.trim() }));
}

/** One bounded, exact, read-only query for a human-readable VTiger reference. */
export async function queryCurrentVtigerFinancialRecords(moduleName: string, fieldName: string, value: string): Promise<Array<Record<string, unknown>>> {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(moduleName) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)) throw new Error("VTiger query module or field is invalid.");
  const exactValue = value.trim();
  if (!exactValue || exactValue.length > 128 || /[\r\n]/.test(exactValue)) throw new Error("VTiger exact query value is invalid.");
  const escaped = exactValue.replace(/'/g, "''");
  return withAuthenticatedVtigerFinancialReadSession(async (session) => {
    const result = await session.request<unknown>({ operation: "query", query: `select * from ${moduleName} where ${fieldName}='${escaped}';` });
    const records: unknown[] = Array.isArray((result as any)?.records) ? (result as any).records : Array.isArray(result) ? result : [];
    return records.filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === "object");
  });
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
  return withAuthenticatedVtigerFinancialReadSession(async (session) => {
    const described = await session.request<{ name?: string; idPrefix?: string; fields?: Array<{ name?: string; label?: string; type?: Record<string, unknown>; mandatory?: boolean }> }>({
      operation: "describe",
      elementType: normalized,
    });
    return {
      name: typeof described?.name === "string" ? described.name : normalized,
      ...(described?.idPrefix ? { idPrefix: String(described.idPrefix) } : {}),
      fields: (described?.fields ?? []).filter((field): field is typeof field & { name: string } => typeof field?.name === "string" && Boolean(field.name))
        .map((field) => ({ name: field.name, label: field.label ?? "", type: field.type ?? {}, mandatory: field.mandatory === true })),
    };
  });
}
