import { createHash } from "node:crypto";
import { getFinancialWorkflowConfig } from "./financialWorkflowDb";
import { evaluateAndPersistFinancialWorkflow } from "./financialWorkflowService";
import {
  FINANCIAL_AUTOMATION_RULE_CONFIG_KEY,
  FINANCIAL_VTIGER_SOURCE_MAPPING_CONFIG_KEY,
  resolveFinancialAutomationRules,
} from "./financialAutomationRules";
import {
  getFinancialWebhookRoute,
  isFinancialWebhookPaused,
  parseFinancialWebhookEnvelope,
  resolveFinancialWebhookControls,
  FINANCIAL_WEBHOOK_CONTROL_CONFIG_KEY,
  type FinancialWebhookEnvelope,
  type FinancialWebhookRoute,
} from "./financialWebhookContracts";
import { mapVtigerFinancialSource } from "./financialShadowValidation";

export type FinancialWebhookProposalResult = {
  status: "proposed" | "held" | "paused" | "rejected";
  route: FinancialWebhookRoute;
  envelope: FinancialWebhookEnvelope;
  workflowRunId: number | null;
  issueCount: number;
  proposedDocuments: Array<{
    documentNumber: string | null;
    documentType: string;
    action: string;
    total: number;
    gstTreatment: string;
    validationStatus: string;
  }>;
  safeSummary: Record<string, unknown>;
};

function sourceChangedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function payloadFingerprint(route: FinancialWebhookRoute, envelope: FinancialWebhookEnvelope): string {
  return createHash("sha256").update(JSON.stringify({
    routeKey: route.key,
    apiVersion: envelope.apiVersion,
    eventType: envelope.eventType,
    sourceRecordId: envelope.sourceRecordId,
    sourceChangedAt: envelope.sourceChangedAt ?? null,
    data: envelope.data,
  })).digest("hex");
}

export function buildFinancialWebhookSafeSummary(input: {
  route: FinancialWebhookRoute;
  envelope: FinancialWebhookEnvelope;
  mappingCount: number;
  paused: boolean;
  workflowOutcome?: string;
  proposedDocuments?: FinancialWebhookProposalResult["proposedDocuments"];
}): Record<string, unknown> {
  return {
    apiVersion: input.envelope.apiVersion,
    mode: input.envelope.mode,
    eventType: input.envelope.eventType,
    routeKey: input.route.key,
    workflowType: input.route.workflowType,
    sourceSystem: input.envelope.sourceSystem,
    sourceEntityType: input.envelope.sourceEntityType,
    sourceRecordNumber: input.envelope.sourceRecordNumber ?? null,
    sourceChangedAt: input.envelope.sourceChangedAt ?? null,
    mappingCount: input.mappingCount,
    paused: input.paused,
    financialWritePermitted: false,
    xeroWriteMethodsCalled: [],
    workflowOutcome: input.workflowOutcome ?? null,
    proposedDocuments: input.proposedDocuments ?? [],
  };
}

/**
 * Evaluates a verified, fixed-path webhook envelope. This is deliberately a
 * proposal path only: it maps data locally, records a financial shadow run and
 * returns no Xero transport instructions or source-system mutation.
 */
export async function evaluateFinancialWebhookProposal(input: {
  routeKey: string;
  payload: unknown;
}): Promise<FinancialWebhookProposalResult> {
  const route = getFinancialWebhookRoute(input.routeKey);
  if (!route) throw new Error("Unknown AP financial webhook route.");
  const parsed = parseFinancialWebhookEnvelope(input.payload);
  if ("error" in parsed) throw new Error(parsed.error);
  const envelope = parsed;
  if (!route.sourceEntityTypes.includes(envelope.sourceEntityType)) {
    throw new Error(`Route ${route.key} does not accept sourceEntityType ${envelope.sourceEntityType}.`);
  }

  const config = await getFinancialWorkflowConfig();
  const controls = resolveFinancialWebhookControls(
    config.find((entry) => entry.configKey === FINANCIAL_WEBHOOK_CONTROL_CONFIG_KEY)?.configValue,
  );
  const paused = isFinancialWebhookPaused(route.key, controls);
  const mapping = config.find((entry) => entry.configKey === FINANCIAL_VTIGER_SOURCE_MAPPING_CONFIG_KEY)?.configValue;
  const rules = resolveFinancialAutomationRules(
    config.find((entry) => entry.configKey === FINANCIAL_AUTOMATION_RULE_CONFIG_KEY)?.configValue,
  );
  const mapped = mapVtigerFinancialSource(envelope.data, mapping as Record<string, unknown> | undefined, route.workflowType);
  const sourceData = { ...mapped.sourceData, ...route.fixedFields };
  const base = {
    route,
    envelope,
    mappingCount: mapped.appliedMappings.length,
    paused,
  };

  if (paused) {
    return {
      status: "paused",
      route,
      envelope,
      workflowRunId: null,
      issueCount: 0,
      proposedDocuments: [],
      safeSummary: buildFinancialWebhookSafeSummary(base),
    };
  }

  const result = await evaluateAndPersistFinancialWorkflow({
    workflowType: route.workflowType,
    triggerType: "webhook",
    sourceRecordId: envelope.sourceRecordId,
    sourceRecordNumber: envelope.sourceRecordNumber,
    sourceRecordType: envelope.sourceEntityType,
    idempotencySalt: envelope.eventId,
    sourceData,
    rules,
    now: sourceChangedAt(envelope.sourceChangedAt) ?? undefined,
  });

  const proposedDocuments = result.evaluation.intents.map((intent) => ({
    documentNumber: intent.proposedDocumentNumber,
    documentType: intent.documentType,
    action: intent.proposedAction,
    total: intent.total,
    gstTreatment: intent.gstTreatment,
    validationStatus: intent.validationStatus,
  }));
  const status = result.evaluation.outcome === "passed" ? "proposed" : "held";
  return {
    status,
    route,
    envelope,
    workflowRunId: result.persistence.runId,
    issueCount: result.evaluation.issues.length,
    proposedDocuments,
    safeSummary: buildFinancialWebhookSafeSummary({
      ...base,
      workflowOutcome: result.evaluation.outcome,
      proposedDocuments,
    }),
  };
}

export function financialWebhookPayloadFingerprint(route: FinancialWebhookRoute, envelope: FinancialWebhookEnvelope): string {
  return payloadFingerprint(route, envelope);
}
