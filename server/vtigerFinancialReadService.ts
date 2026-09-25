import axios from "axios";
import { createHash } from "node:crypto";

export type VtigerFinancialConnectionStatus = {
  configured: boolean;
  missing: Array<"VTIGER_URL" | "VTIGER_USERNAME" | "VTIGER_ACCESS_KEY">;
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

async function vtigerRequest<T>(params: Record<string, string>): Promise<T> {
  const response = await axios.get(endpoint(), { params, timeout: 20_000 });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger read request failed");
  return response.data.result as T;
}

/**
 * Retrieves the current VTiger record using the standard challenge/login/read
 * API. It only performs GET operations and establishes no workflow or Xero side
 * effect. The session token is held in memory for this request only.
 */
export async function retrieveCurrentVtigerFinancialRecord(recordId: string): Promise<Record<string, unknown>> {
  if (!validRecordId(recordId)) throw new Error("VTiger record ID must use the standard moduleId x recordId format");
  const { username, accessKey } = config();
  const status = getVtigerFinancialConnectionStatus();
  if (!status.configured || !username || !accessKey) throw new Error("VTiger is not configured for read-only financial shadow evaluation");

  const challenge = await vtigerRequest<{ token: string }>({ operation: "getchallenge", username });
  const accessKeyHash = createHash("md5").update(`${challenge.token}${accessKey}`).digest("hex");
  const login = await vtigerRequest<{ sessionName: string }>({ operation: "login", username, accessKey: accessKeyHash });
  return vtigerRequest<Record<string, unknown>>({ operation: "retrieve", id: recordId.trim(), sessionName: login.sessionName });
}
