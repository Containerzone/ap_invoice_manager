import axios from "axios";
import { createHash } from "node:crypto";
import {
  claimFinancialPostSuccessAction,
  getFinancialPostSuccessActionById,
  getFinancialWorkflowConfig,
  getRetryableFinancialPostSuccessActions,
  markFinancialPostSuccessActionFailed,
  markFinancialPostSuccessActionSucceeded,
} from "./financialWorkflowDb";
import { FinancialWriteDisabledError } from "./financialProductionWriter";

export const FINANCIAL_VTIGER_POST_SUCCESS_CONFIG_KEY = "financial-automation.vtiger-post-success" as const;

export type FinancialPostSuccessVtigerConfig = {
  enabled: boolean;
  assignedUserId: string | null;
  notes: { enabled: boolean; module: string; recordLinkField: string; commentField: string };
  tasks: { enabled: boolean; module: string; recordLinkField: string; subjectField: string; dueDateField: string };
  hireEndUpdate: { enabled: boolean; module: string; fieldName: string };
};

const DEFAULT_POST_SUCCESS_CONFIG: FinancialPostSuccessVtigerConfig = {
  enabled: false,
  assignedUserId: null,
  notes: { enabled: false, module: "ModComments", recordLinkField: "related_to", commentField: "commentcontent" },
  tasks: { enabled: false, module: "Calendar", recordLinkField: "parent_id", subjectField: "subject", dueDateField: "due_date" },
  hireEndUpdate: { enabled: false, module: "Potentials", fieldName: "" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function configuredText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * Non-secret VTiger write mapping. It defaults fully disabled; no inferred CRM
 * module/field name is ever written without the AP-approved mapping.
 */
export function resolveFinancialPostSuccessVtigerConfig(value: unknown): FinancialPostSuccessVtigerConfig {
  if (!isRecord(value)) return { ...DEFAULT_POST_SUCCESS_CONFIG, notes: { ...DEFAULT_POST_SUCCESS_CONFIG.notes }, tasks: { ...DEFAULT_POST_SUCCESS_CONFIG.tasks }, hireEndUpdate: { ...DEFAULT_POST_SUCCESS_CONFIG.hireEndUpdate } };
  const notes = isRecord(value.notes) ? value.notes : {};
  const tasks = isRecord(value.tasks) ? value.tasks : {};
  const hireEndUpdate = isRecord(value.hireEndUpdate) ? value.hireEndUpdate : {};
  return {
    enabled: value.enabled === true,
    assignedUserId: typeof value.assignedUserId === "string" && /^\d+x\d+$/i.test(value.assignedUserId.trim()) ? value.assignedUserId.trim() : null,
    notes: {
      enabled: notes.enabled === true,
      module: configuredText(notes.module, DEFAULT_POST_SUCCESS_CONFIG.notes.module),
      recordLinkField: configuredText(notes.recordLinkField, DEFAULT_POST_SUCCESS_CONFIG.notes.recordLinkField),
      commentField: configuredText(notes.commentField, DEFAULT_POST_SUCCESS_CONFIG.notes.commentField),
    },
    tasks: {
      enabled: tasks.enabled === true,
      module: configuredText(tasks.module, DEFAULT_POST_SUCCESS_CONFIG.tasks.module),
      recordLinkField: configuredText(tasks.recordLinkField, DEFAULT_POST_SUCCESS_CONFIG.tasks.recordLinkField),
      subjectField: configuredText(tasks.subjectField, DEFAULT_POST_SUCCESS_CONFIG.tasks.subjectField),
      dueDateField: configuredText(tasks.dueDateField, DEFAULT_POST_SUCCESS_CONFIG.tasks.dueDateField),
    },
    hireEndUpdate: {
      enabled: hireEndUpdate.enabled === true,
      module: configuredText(hireEndUpdate.module, DEFAULT_POST_SUCCESS_CONFIG.hireEndUpdate.module),
      fieldName: typeof hireEndUpdate.fieldName === "string" ? hireEndUpdate.fieldName.trim() : "",
    },
  };
}

export function isFinancialPostSuccessVtigerWriteEnabled(): boolean {
  return process.env.FINANCIAL_VTIGER_POST_SUCCESS_ENABLED === "true";
}

function config() {
  const url = process.env.VTIGER_URL?.trim().replace(/\/$/, "") ?? "";
  const username = process.env.VTIGER_USERNAME?.trim() ?? "";
  const accessKey = process.env.VTIGER_ACCESS_KEY?.trim() ?? "";
  if (!url || !username || !accessKey) throw new FinancialWriteDisabledError("VTiger AP credentials are not configured for post-success work.");
  return { url, username, accessKey };
}

async function vtigerLogin(): Promise<{ endpoint: string; sessionName: string }> {
  const { url, username, accessKey } = config();
  const endpoint = `${url}/webservice.php`;
  const challengeResponse = await axios.get(endpoint, { params: { operation: "getchallenge", username }, timeout: 20_000 });
  if (!challengeResponse.data?.success || !challengeResponse.data?.result?.token) {
    throw new Error(challengeResponse.data?.error?.message ?? "VTiger did not return a usable challenge token.");
  }
  const accessKeyHash = createHash("md5").update(`${challengeResponse.data.result.token}${accessKey}`).digest("hex");
  const loginResponse = await axios.post(endpoint, new URLSearchParams({ operation: "login", username, accessKey: accessKeyHash }).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  if (!loginResponse.data?.success || !loginResponse.data?.result?.sessionName) {
    throw new Error(loginResponse.data?.error?.message ?? "VTiger did not return a usable post-success session.");
  }
  return { endpoint, sessionName: String(loginResponse.data.result.sessionName) };
}

async function vtigerCreate(input: { endpoint: string; sessionName: string; elementType: string; element: Record<string, unknown> }): Promise<string | null> {
  const payload = new URLSearchParams({
    operation: "create",
    sessionName: input.sessionName,
    elementType: input.elementType,
    element: JSON.stringify(input.element),
  });
  const response = await axios.post(input.endpoint, payload.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger post-success create failed.");
  return response.data?.result?.id ? String(response.data.result.id) : null;
}

async function vtigerRetrieve(input: { endpoint: string; sessionName: string; recordId: string }): Promise<Record<string, unknown>> {
  const response = await axios.get(input.endpoint, { params: { operation: "retrieve", sessionName: input.sessionName, id: input.recordId }, timeout: 20_000 });
  if (!response.data?.success || !isRecord(response.data?.result)) throw new Error(response.data?.error?.message ?? "VTiger source retrieve failed for post-success work.");
  return response.data.result;
}

async function vtigerRevise(input: { endpoint: string; sessionName: string; element: Record<string, unknown> }): Promise<string | null> {
  const payload = new URLSearchParams({ operation: "revise", sessionName: input.sessionName, element: JSON.stringify(input.element) });
  const response = await axios.post(input.endpoint, payload.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  if (!response.data?.success) throw new Error(response.data?.error?.message ?? "VTiger post-success revision failed.");
  return response.data?.result?.id ? String(response.data.result.id) : null;
}

function actionMessage(summary: Record<string, unknown>, workflowType: string): string {
  if (workflowType === "storage_activation" && typeof summary.customerInvoice === "string" && typeof summary.transportPurchaseOrder === "string" && typeof summary.storagePurchaseOrder === "string") {
    return `[AP Storage Drafts Created]\nLocation: ${summary.storageLocation === "destination" ? "Destination" : "Origin"}\nCustomer invoice: ${summary.customerInvoice} (Draft)\nTransport PO: ${summary.transportPurchaseOrder} (Draft)\nStorage PO: ${summary.storagePurchaseOrder} (Draft)\nBilling period: ${typeof summary.billingPeriod === "string" ? summary.billingPeriod : "see AP ledger"}`;
  }
  const documentNumber = typeof summary.documentNumber === "string" ? summary.documentNumber : "(unnumbered Draft)";
  const xeroDocumentId = typeof summary.xeroDocumentId === "string" ? summary.xeroDocumentId : "(unavailable)";
  const location = typeof summary.storageLocation === "string" ? ` Location: ${summary.storageLocation}.` : "";
  return `AP Management created and verified Xero Draft ${documentNumber} (${xeroDocumentId}) for ${workflowType}.${location} This note was recorded after exact Draft read-back.`;
}

/**
 * Runs one AP-owned post-success action after a confirmed Xero Draft. This may
 * create a VTiger note/task or revise the explicitly mapped hire-end field, but
 * only after both deployment and non-secret configuration locks are enabled.
 * It never calls the Xero writer and is safe to retry independently.
 */
export async function runFinancialPostSuccessAction(actionId: number): Promise<{ outcome: "succeeded" | "failed"; message?: string }> {
  const action = await getFinancialPostSuccessActionById(actionId);
  if (!action) throw new Error("Financial post-success action was not found.");
  if (action.status === "succeeded") return { outcome: "succeeded", message: "Post-success action was already completed." };
  if (action.status === "reconciliation_required") return { outcome: "failed", message: "Post-success action requires manual reconciliation." };

  const claimed = await claimFinancialPostSuccessAction(actionId);
  if (!claimed) return { outcome: "failed", message: "Post-success action is already running, completed, or unavailable for retry." };
  try {
    if (!isFinancialPostSuccessVtigerWriteEnabled()) {
      throw new FinancialWriteDisabledError("VTiger post-success deployment lock is disabled.");
    }
    const configurationRows = await getFinancialWorkflowConfig();
    const config = resolveFinancialPostSuccessVtigerConfig(
      configurationRows.find((entry) => entry.configKey === FINANCIAL_VTIGER_POST_SUCCESS_CONFIG_KEY)?.configValue,
    );
    if (!config.enabled || !config.assignedUserId) {
      throw new FinancialWriteDisabledError("VTiger post-success mapping is not enabled with an assigned AP user.");
    }
    const session = await vtigerLogin();
    const summary = isRecord(claimed.safePayloadSummary) ? claimed.safePayloadSummary : {};
    let vtigerRecordId: string | null = null;

    if (claimed.actionType === "vtiger_note") {
      if (!config.notes.enabled) throw new FinancialWriteDisabledError("VTiger post-success note mapping is disabled.");
      vtigerRecordId = await vtigerCreate({
        ...session,
        elementType: config.notes.module,
        element: {
          assigned_user_id: config.assignedUserId,
          [config.notes.recordLinkField]: claimed.sourceRecordId,
          [config.notes.commentField]: actionMessage(summary, claimed.workflowType),
        },
      });
    } else if (claimed.actionType === "vtiger_task") {
      if (!config.tasks.enabled) throw new FinancialWriteDisabledError("VTiger post-success task mapping is disabled.");
      const dueDate = typeof summary.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(summary.dueDate)
        ? summary.dueDate
        : new Date().toISOString().slice(0, 10);
      const subject = typeof summary.taskSubject === "string" && summary.taskSubject.trim()
        ? summary.taskSubject.trim()
        : actionMessage(summary, claimed.workflowType);
      vtigerRecordId = await vtigerCreate({
        ...session,
        elementType: config.tasks.module,
        element: {
          assigned_user_id: config.assignedUserId,
          [config.tasks.recordLinkField]: claimed.sourceRecordId,
          [config.tasks.subjectField]: subject,
          [config.tasks.dueDateField]: dueDate,
        },
      });
    } else {
      if (!config.hireEndUpdate.enabled || !config.hireEndUpdate.fieldName) {
        throw new FinancialWriteDisabledError("VTiger hire-end mapping is disabled or has no verified field name.");
      }
      const nextHireEnd = typeof summary.nextHireEndDate === "string" ? summary.nextHireEndDate : null;
      if (!nextHireEnd) throw new Error("Post-success hire-end update has no approved nextHireEndDate value.");
      const existing = await vtigerRetrieve({ ...session, recordId: claimed.sourceRecordId });
      vtigerRecordId = await vtigerRevise({
        ...session,
        element: { ...existing, [config.hireEndUpdate.fieldName]: nextHireEnd },
      });
    }

    await markFinancialPostSuccessActionSucceeded({ actionId: claimed.id, vtigerRecordId });
    return { outcome: "succeeded" };
  } catch (error) {
    const reconciliationRequired = claimed.attemptCount >= 3;
    await markFinancialPostSuccessActionFailed({ actionId: claimed.id, error, reconciliationRequired });
    throw error;
  }
}

/**
 * Bounded retry worker for VTiger-only post-success actions. It has no path to
 * any Xero financial write; each action retains its own Xero read-back evidence.
 */
export async function retryFinancialPostSuccessActions(limit = 20): Promise<{
  considered: number;
  succeeded: number;
  failed: number;
}> {
  const candidates = await getRetryableFinancialPostSuccessActions(limit);
  let succeeded = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await runFinancialPostSuccessAction(candidate.id);
      if (result.outcome === "succeeded") succeeded += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { considered: candidates.length, succeeded, failed };
}
