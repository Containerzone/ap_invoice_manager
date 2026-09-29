import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  extraHireRuns,
  financialCutoverAudits,
  financialCutoverControls,
  financialCutoverPacks,
  financialDocumentIntents,
  financialDocuments,
  financialExecutionApprovals,
  financialPostSuccessActions,
  financialCandidateDiscoveries,
  financialCandidateRoster,
  financialIntegrationAudits,
  financialReleaseAudits,
  financialReleaseFamilies,
  financialReleaseManifests,
  financialShadowTests,
  financialWebhookEvents,
  financialWriterExecutions,
  financialWorkflowConfig,
  financialWorkflowConfigAudits,
  financialWorkflowExceptionComments,
  financialWorkflowExceptions,
  financialWorkflowRuns,
  recurringHireRuns,
  storageBillingEvents,
  warrantyDocuments,
  workflowSchedules,
  type FinancialWorkflowConfig,
  type FinancialCutoverControl,
  type FinancialCutoverPack,
  type FinancialExecutionApproval,
  type FinancialPostSuccessAction,
  type FinancialCandidateDiscovery,
  type FinancialCandidateRoster,
  type FinancialIntegrationAudit,
  type FinancialReleaseAudit,
  type FinancialReleaseFamily,
  type FinancialReleaseManifest,
  type FinancialShadowTest,
  type FinancialWebhookEvent,
  type FinancialWriterExecution,
  type FinancialWorkflowException,
  type FinancialWorkflowRun,
} from "../drizzle/schema";
import { getDb } from "./db";
import { FINANCIAL_WORKFLOW_TYPES, type FinancialWorkflowEvaluation, type FinancialWorkflowInput } from "./financialWorkflowEngine";
import {
  FINANCIAL_WRITER_IMPLEMENTATION_VERSION,
  type FinancialDraftPayload,
  type FinancialDraftWriteResult,
} from "./financialProductionWriter";
import {
  FINANCIAL_AUTOMATION_RULE_CONFIG_KEY,
  resolveFinancialAutomationRules,
} from "./financialAutomationRules";
import {
  FINANCIAL_RELEASE_FAMILIES,
  FINANCIAL_LEGACY_WRITER_INVENTORY,
  frozenRuleVersion,
  releaseAuthenticationDescription,
  releaseEndpointIdentifier,
  releaseFamilyStatus,
  releaseRollbackPlan,
} from "./financialReleaseManifest";
import { preflightFinancialXeroIntents, testFinancialXeroConnection, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import { retrieveCurrentVtigerFinancialRecord, testVtigerFinancialConnection } from "./vtigerFinancialReadService";
import { FINANCIAL_POST_SUCCESS_MAPPING_CONFIG_KEY, validateDisabledPostSuccessMapping } from "./financialPostSuccessReadiness";
import { randomUUID } from "node:crypto";
import {
  FINANCIAL_PROPOSAL_VERSION,
  financialSha256,
  proposalHash as calculateProposalHash,
  rulesSnapshotHash,
  sourceSnapshotHash,
} from "./financialProposalIntegrity";

export type PersistedFinancialEvaluation = {
  runId: number;
  duplicate: boolean;
  intentIds: number[];
  exceptionIds: number[];
};

function runStatus(evaluation: FinancialWorkflowEvaluation): "evaluated" | "held" | "failed" {
  if (evaluation.outcome === "failed") return "failed";
  if (evaluation.outcome === "warning" || evaluation.intents.some((intent) => intent.validationStatus === "held")) return "held";
  return "evaluated";
}

function validationOutcome(evaluation: FinancialWorkflowEvaluation): "passed" | "warning" | "failed" {
  return evaluation.outcome;
}

export async function getFinancialWorkflowRunByKey(
  workflowType: string,
  idempotencyKey: string,
): Promise<FinancialWorkflowRun | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialWorkflowRuns).where(and(
    eq(financialWorkflowRuns.workflowType, workflowType),
    eq(financialWorkflowRuns.idempotencyKey, idempotencyKey),
  )).limit(1))[0];
}

/**
 * Persists a completed shadow calculation. It intentionally does not call any
 * Xero client and stores no Xero tokens or secrets in the audit record.
 */
export async function persistFinancialWorkflowEvaluation(
  input: FinancialWorkflowInput,
  evaluation: FinancialWorkflowEvaluation,
  createdBy?: number,
): Promise<PersistedFinancialEvaluation> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const existing = await getFinancialWorkflowRunByKey(evaluation.workflowType, evaluation.idempotencyKey);
  if (existing) return { runId: existing.id, duplicate: true, intentIds: [], exceptionIds: [] };

  const now = new Date();
  const status = runStatus(evaluation);
  const sourceHash = sourceSnapshotHash(input.sourceData);
  const ruleHash = rulesSnapshotHash(input.rules ?? resolveFinancialAutomationRules());
  const insert = await db.insert(financialWorkflowRuns).values({
    workflowType: evaluation.workflowType,
    triggerType: input.triggerType,
    sourceSystem: "vtiger",
    sourceRecordType: input.sourceRecordType ?? null,
    sourceRecordId: input.sourceRecordId ?? null,
    sourceRecordNumber: input.sourceRecordNumber ?? null,
    idempotencyKey: evaluation.idempotencyKey,
    mode: "shadow",
    status,
    validationOutcome: validationOutcome(evaluation),
    safeRequestSummary: evaluation.safeRequestSummary as any,
    sourceSnapshot: input.sourceData as any,
    validationResults: { outcome: evaluation.outcome, issues: evaluation.issues } as any,
    resultReferences: { liveXeroWrite: false, intentCount: evaluation.intents.length } as any,
    sourceSnapshotHash: sourceHash,
    rulesSnapshotHash: ruleHash,
    proposalVersion: FINANCIAL_PROPOSAL_VERSION,
    errorMessage: evaluation.outcome === "failed" ? evaluation.issues.map((entry) => entry.title).join("; ") : null,
    receivedAt: now,
    evaluatedAt: now,
    completedAt: now,
    createdBy: createdBy ?? null,
  });
  const runId = Number((insert[0] as any).insertId);

  const intentIds: number[] = [];
  for (const intent of evaluation.intents) {
    const intentInsert = await db.insert(financialDocumentIntents).values({
      workflowRunId: runId,
      documentFamily: intent.documentFamily,
      documentType: intent.documentType,
      proposedAction: intent.proposedAction,
      proposedDocumentNumber: intent.proposedDocumentNumber,
      reference: intent.reference,
      partyName: intent.partyName,
      partySourceId: intent.partySourceId,
      accountCode: intent.accountCode,
      gstTreatment: intent.gstTreatment,
      currency: intent.currency,
      subtotal: intent.subtotal.toFixed(2),
      taxAmount: intent.taxAmount.toFixed(2),
      total: intent.total.toFixed(2),
      issueDate: intent.issueDate,
      dueDate: intent.dueDate,
      lineItems: intent.lineItems as any,
      sourceWorkflow: intent.sourceWorkflow,
      sourceRecordId: intent.sourceRecordId,
      validationStatus: intent.validationStatus,
      validationSummary: { proposedOnly: true, xeroWritePermitted: false } as any,
      proposalHash: calculateProposalHash(intent),
      sourceSnapshotHash: sourceHash,
      rulesSnapshotHash: ruleHash,
      immutableAt: now,
    });
    intentIds.push(Number((intentInsert[0] as any).insertId));
  }

  const exceptionIds: number[] = [];
  for (let index = 0; index < evaluation.issues.length; index += 1) {
    const problem = evaluation.issues[index]!;
    const exceptionInsert = await db.insert(financialWorkflowExceptions).values({
      workflowRunId: runId,
      documentIntentId: problem.documentIndex === undefined ? null : intentIds[problem.documentIndex] ?? null,
      exceptionCode: problem.code,
      title: problem.title,
      details: problem.details,
      severity: problem.severity,
      status: "open",
      sourceContext: { workflowType: evaluation.workflowType, sourceRecordId: input.sourceRecordId ?? null, issueIndex: index } as any,
    });
    exceptionIds.push(Number((exceptionInsert[0] as any).insertId));
  }

  // Shadow reservations prevent duplicate future writes while never creating a Xero document.
  if (input.workflowType === "recurring_for_hire" && input.sourceRecordId) {
    const start = input.sourceData.periodStart ? new Date(String(input.sourceData.periodStart)) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const end = input.sourceData.periodEnd ? new Date(String(input.sourceData.periodEnd)) : new Date(start.getTime() + 29 * 86_400_000);
    await db.insert(recurringHireRuns).values({
      workflowRunId: runId,
      containerControlId: input.sourceRecordId,
      containerControlNumber: String(input.sourceData.containerControlNumber ?? ""),
      billingPeriodStart: start,
      billingPeriodEnd: end,
      reservationKey: `${input.sourceRecordId}:${start.toISOString().slice(0, 10)}`,
      proposedPoNumber: evaluation.intents[0]?.proposedDocumentNumber ?? null,
      status: status === "evaluated" ? "evaluated" : "held",
    }).onDuplicateKeyUpdate({ set: { workflowRunId: runId, updatedAt: now } });
  }

  if (input.workflowType === "extra_hire" && input.sourceRecordId) {
    const hireEnd = String(input.sourceData.hireEndDate ?? "");
    await db.insert(extraHireRuns).values({
      workflowRunId: runId,
      dealId: input.sourceRecordId,
      sourceHireEndDate: hireEnd,
      reservationKey: `${input.sourceRecordId}:${hireEnd}`,
      proposedInvoiceNumber: evaluation.intents[0]?.proposedDocumentNumber ?? null,
      status: status === "evaluated" ? "evaluated" : "held",
    }).onDuplicateKeyUpdate({ set: { workflowRunId: runId, updatedAt: now } });
  }

  // A storage event is an execution-state ledger record, not a shadow-evaluator
  // convenience row. Creating it here would allow a no-write preview to imply
  // an active recurring-storage obligation. Only verified activation/finalisation
  // execution code may create or advance this ledger in a later approved phase.

  if (input.workflowType === "warranty_reconciliation" && input.sourceRecordId) {
    await db.insert(warrantyDocuments).values({
      workflowRunId: runId,
      dealId: input.sourceRecordId,
      warrantyCode: typeof input.sourceData.warrantyItemCode === "string" ? input.sourceData.warrantyItemCode : null,
      warrantyDescription: typeof input.sourceData.addedService === "string" ? input.sourceData.addedService : null,
      reconciliationStatus: status === "evaluated" ? "proposed" : "held",
      sourceSnapshot: input.sourceData as any,
    });
  }

  return { runId, duplicate: false, intentIds, exceptionIds };
}

export type FinancialWorkflowRunRow = FinancialWorkflowRun & { intentCount: number; exceptionCount: number };

export async function getFinancialWorkflowRuns(limit = 100): Promise<FinancialWorkflowRunRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    run: financialWorkflowRuns,
    intentCount: sql<number>`count(distinct ${financialDocumentIntents.id})`,
    exceptionCount: sql<number>`count(distinct ${financialWorkflowExceptions.id})`,
  }).from(financialWorkflowRuns)
    .leftJoin(financialDocumentIntents, eq(financialDocumentIntents.workflowRunId, financialWorkflowRuns.id))
    .leftJoin(financialWorkflowExceptions, eq(financialWorkflowExceptions.workflowRunId, financialWorkflowRuns.id))
    .groupBy(financialWorkflowRuns.id)
    .orderBy(desc(financialWorkflowRuns.createdAt))
    .limit(limit);
  return rows.map(({ run, intentCount, exceptionCount }) => ({
    ...run,
    intentCount: Number(intentCount ?? 0),
    exceptionCount: Number(exceptionCount ?? 0),
  }));
}

export async function getFinancialWorkflowRunDetail(runId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const run = (await db.select().from(financialWorkflowRuns).where(eq(financialWorkflowRuns.id, runId)).limit(1))[0];
  if (!run) return undefined;
  const [intents, exceptions] = await Promise.all([
    db.select().from(financialDocumentIntents).where(eq(financialDocumentIntents.workflowRunId, runId)).orderBy(financialDocumentIntents.id),
    db.select().from(financialWorkflowExceptions).where(eq(financialWorkflowExceptions.workflowRunId, runId)).orderBy(desc(financialWorkflowExceptions.createdAt)),
  ]);
  return { run, intents, exceptions };
}

export async function getFinancialDocumentIntents(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialDocumentIntents).orderBy(desc(financialDocumentIntents.createdAt)).limit(limit);
}

export async function getFinancialWorkflowExceptions(limit = 200): Promise<FinancialWorkflowException[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialWorkflowExceptions).orderBy(desc(financialWorkflowExceptions.createdAt)).limit(limit);
}

export async function getFinancialExceptionComments(exceptionId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialWorkflowExceptionComments)
    .where(eq(financialWorkflowExceptionComments.exceptionId, exceptionId))
    .orderBy(financialWorkflowExceptionComments.createdAt);
}

export async function addFinancialExceptionComment(exceptionId: number, authorId: number, comment: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(financialWorkflowExceptionComments).values({ exceptionId, authorId, comment });
  return Number((result[0] as any).insertId);
}

export async function resolveFinancialWorkflowException(id: number, resolvedBy: number, notes?: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialWorkflowExceptions).set({
    status: "resolved",
    resolvedBy,
    resolvedAt: new Date(),
    resolutionNotes: notes?.trim() || null,
    updatedAt: new Date(),
  }).where(eq(financialWorkflowExceptions.id, id));
}

export async function assignFinancialWorkflowException(id: number, assignedTo: number | null): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialWorkflowExceptions).set({ assignedTo, updatedAt: new Date() }).where(eq(financialWorkflowExceptions.id, id));
}

export async function getFinancialWorkflowSchedules() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(workflowSchedules).orderBy(workflowSchedules.workflowType);
}

/** Locates a financial schedule only by its Heartbeat task UID. */
export async function getFinancialWorkflowScheduleByTaskUid(taskUid: string) {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(workflowSchedules)
    .where(eq(workflowSchedules.taskUid, taskUid)).limit(1))[0];
}

export async function recordFinancialWorkflowScheduleOutcome(input: {
  workflowType: string;
  taskUid: string;
  outcome: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(workflowSchedules).set({
    lastRunAt: new Date(),
    lastOutcome: input.outcome.slice(0, 80),
    updatedAt: new Date(),
  }).where(and(
    eq(workflowSchedules.workflowType, input.workflowType),
    eq(workflowSchedules.taskUid, input.taskUid),
  ));
}

/** No task is registered or enabled by this helper; it stores disabled metadata only. */
export async function upsertFinancialWorkflowSchedule(data: {
  workflowType: string;
  cronExpression?: string | null;
  taskUid?: string | null;
  enabled?: boolean;
  lastRunAt?: Date | null;
  nextRunAt?: Date | null;
  lastOutcome?: string | null;
  auditData?: unknown;
}): Promise<void> {
  if (data.enabled) throw new Error("Financial target schedules cannot be enabled during shadow mode");
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.insert(workflowSchedules).values({
    workflowType: data.workflowType,
    cronExpression: data.cronExpression ?? null,
    taskUid: data.taskUid ?? null,
    enabled: false,
    lastRunAt: data.lastRunAt ?? null,
    nextRunAt: data.nextRunAt ?? null,
    lastOutcome: data.lastOutcome ?? "not_configured",
    auditData: (data.auditData ?? { shadowOnly: true }) as any,
  }).onDuplicateKeyUpdate({ set: {
    cronExpression: data.cronExpression ?? null,
    taskUid: data.taskUid ?? null,
    enabled: false,
    lastRunAt: data.lastRunAt ?? null,
    nextRunAt: data.nextRunAt ?? null,
    lastOutcome: data.lastOutcome ?? "not_configured",
    auditData: (data.auditData ?? { shadowOnly: true }) as any,
    updatedAt: new Date(),
  } });
}

export async function getFinancialWorkflowConfig(): Promise<FinancialWorkflowConfig[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialWorkflowConfig).orderBy(financialWorkflowConfig.configKey);
}

export async function upsertFinancialWorkflowConfig(
  configKey: string,
  configValue: unknown,
  description: string | null,
  updatedBy: number,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const prior = (await db.select().from(financialWorkflowConfig)
    .where(eq(financialWorkflowConfig.configKey, configKey)).limit(1))[0];
  await db.insert(financialWorkflowConfig).values({ configKey, configValue: configValue as any, description, updatedBy }).onDuplicateKeyUpdate({
    set: { configValue: configValue as any, description, updatedBy, updatedAt: new Date() },
  });
  // Every administrator change to non-secret financial automation settings is
  // retained as an append-only audit record. Credentials never enter this table.
  await db.insert(financialWorkflowConfigAudits).values({
    configKey,
    previousValue: prior?.configValue ?? null,
    nextValue: configValue as any,
    description,
    changedBy: updatedBy,
  });
}

export async function getFinancialWorkflowConfigAudits(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialWorkflowConfigAudits)
    .orderBy(desc(financialWorkflowConfigAudits.changedAt))
    .limit(limit);
}

export type CreateFinancialShadowTest = {
  testKey: string;
  workflowType: string;
  branch: string;
  sourceRecordType?: string | null;
  sourceRecordId?: string | null;
  sourceRecordNumber?: string | null;
  expectedResult: unknown;
  actualResult?: unknown;
  fieldComparisons?: unknown;
  xeroPreflight?: unknown;
  status: "pending" | "passed" | "failed" | "held" | "needs_data" | "blocked";
  differenceExplanation?: string | null;
  sourceRefreshedAt?: Date | null;
  workflowRunId?: number | null;
  documentIntentIds?: number[];
  exceptionIds?: number[];
  initiatedBy?: number | null;
  testedAt?: Date | null;
  reviewStatus?: "pending" | "confirmed" | "rejected";
  reviewedBy?: number | null;
  reviewedAt?: Date | null;
  reviewerComment?: string | null;
};

/** Saves an evidence-only shadow test. The related run remains shadow-only. */
export async function createFinancialShadowTest(data: CreateFinancialShadowTest): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(financialShadowTests).values({
    testKey: data.testKey,
    workflowType: data.workflowType,
    branch: data.branch,
    sourceRecordType: data.sourceRecordType ?? null,
    sourceRecordId: data.sourceRecordId ?? null,
    sourceRecordNumber: data.sourceRecordNumber ?? null,
    expectedResult: data.expectedResult as any,
    actualResult: data.actualResult as any,
    fieldComparisons: data.fieldComparisons as any,
    xeroPreflight: data.xeroPreflight as any,
    status: data.status,
    differenceExplanation: data.differenceExplanation ?? null,
    sourceRefreshedAt: data.sourceRefreshedAt ?? null,
    workflowRunId: data.workflowRunId ?? null,
    documentIntentIds: data.documentIntentIds as any,
    exceptionIds: data.exceptionIds as any,
    initiatedBy: data.initiatedBy ?? null,
    testedAt: data.testedAt ?? new Date(),
    reviewStatus: data.reviewStatus ?? "pending",
    reviewedBy: data.reviewedBy ?? null,
    reviewedAt: data.reviewedAt ?? null,
    reviewerComment: data.reviewerComment ?? null,
  });
  return Number((result[0] as any).insertId);
}

export async function getFinancialShadowTests(limit = 250): Promise<FinancialShadowTest[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialShadowTests)
    .orderBy(desc(financialShadowTests.testedAt), desc(financialShadowTests.createdAt))
    .limit(limit);
}

export async function getFinancialShadowTestById(id: number): Promise<FinancialShadowTest | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialShadowTests).where(eq(financialShadowTests.id, id)).limit(1))[0];
}

export async function reviewFinancialShadowTest(input: {
  testId: number;
  reviewStatus: "confirmed" | "rejected";
  reviewerComment: string;
  reviewedBy: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialShadowTests).set({
    reviewStatus: input.reviewStatus,
    reviewerComment: input.reviewerComment.trim(),
    reviewedBy: input.reviewedBy,
    reviewedAt: new Date(),
    updatedAt: new Date(),
    status: input.reviewStatus === "confirmed" ? "passed" : "failed",
    differenceExplanation: input.reviewStatus === "confirmed"
      ? "Confirmed by AP administrator after reviewing live-source, rule and read-only Xero evidence."
      : "Rejected by AP administrator after reviewing shadow evidence.",
  }).where(eq(financialShadowTests.id, input.testId));
}

export async function createFinancialCandidateDiscovery(input: {
  familyKey?: string | null;
  sourceCategory: "deal" | "container_control" | "storage_billing_event";
  businessNumber: string;
  workflowType: string;
  outcome: "found" | "not_found" | "ambiguous" | "blocked" | "no_current_candidate";
  candidateRecordIds: string[];
  candidateSummaries?: unknown;
  sourceRefreshedAt?: Date | null;
  sourceSnapshotHash?: string | null;
  rulesSnapshotHash?: string | null;
  xeroPreflightHash?: string | null;
  message: string;
  initiatedBy: number;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(financialCandidateDiscoveries).values({
    ...input,
    familyKey: input.familyKey ?? null,
    candidateRecordIds: input.candidateRecordIds as any,
    candidateSummaries: input.candidateSummaries as any,
    sourceRefreshedAt: input.sourceRefreshedAt ?? null,
    sourceSnapshotHash: input.sourceSnapshotHash ?? null,
    rulesSnapshotHash: input.rulesSnapshotHash ?? null,
    xeroPreflightHash: input.xeroPreflightHash ?? null,
  });
  return Number((result[0] as any).insertId);
}

export async function getFinancialCandidateDiscoveries(limit = 100): Promise<FinancialCandidateDiscovery[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialCandidateDiscoveries)
    .orderBy(desc(financialCandidateDiscoveries.createdAt))
    .limit(limit);
}

export type CandidateRosterStatus = "draft" | "found" | "not_found" | "ambiguous" | "blocked" | "needs_data" | "no_current_candidate";

export async function getFinancialCandidateRoster(limit = 100): Promise<FinancialCandidateRoster[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialCandidateRoster)
    .orderBy(desc(financialCandidateRoster.updatedAt), desc(financialCandidateRoster.id))
    .limit(limit);
}

export async function getFinancialCandidateRosterEntry(id: number): Promise<FinancialCandidateRoster | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialCandidateRoster).where(eq(financialCandidateRoster.id, id)).limit(1))[0];
}

/**
 * Adds or deliberately re-plans one named candidate. Updating a business
 * reference resets its discovery state, so an old exact match cannot be reused
 * for a changed workflow branch.
 */
export async function upsertFinancialCandidateRosterEntry(input: {
  familyKey?: string | null;
  sourceCategory: "deal" | "container_control";
  businessNumber: string;
  workflowType: string;
  branch: string;
  businessNote?: string | null;
  ownerId?: number | null;
  reviewerId?: number | null;
  selectedPeriodStart?: Date | null;
  createdBy: number;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const familyKey = input.familyKey?.trim() || "legacy-manual";
  const existing = (await db.select().from(financialCandidateRoster).where(and(
    eq(financialCandidateRoster.sourceCategory, input.sourceCategory),
    eq(financialCandidateRoster.businessNumber, input.businessNumber),
    eq(financialCandidateRoster.familyKey, familyKey),
  )).limit(1))[0];
  const values = {
    familyKey,
    workflowType: input.workflowType,
    branch: input.branch,
    businessNote: input.businessNote?.trim() || null,
    ownerId: input.ownerId ?? null,
    reviewerId: input.reviewerId ?? null,
    discoveryStatus: "draft" as const,
    candidateRecordId: null,
    latestDiscoveryId: null,
    latestShadowTestId: null,
    lastDiscoveryMessage: null,
    lastResolvedAt: null,
    selectedPeriodStart: input.selectedPeriodStart ?? null,
    selectedPeriodEnd: null,
    evidenceStatus: "unverified" as const,
    sourceSnapshotHash: null,
    rulesSnapshotHash: null,
    xeroPreflightHash: null,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(financialCandidateRoster).set(values).where(eq(financialCandidateRoster.id, existing.id));
    return existing.id;
  }
  const result = await db.insert(financialCandidateRoster).values({
    sourceCategory: input.sourceCategory,
    businessNumber: input.businessNumber,
    createdBy: input.createdBy,
    ...values,
  });
  return Number((result[0] as any).insertId);
}

export async function updateFinancialCandidateRosterDiscovery(input: {
  id: number;
  discoveryStatus: Exclude<CandidateRosterStatus, "draft" | "needs_data">;
  candidateRecordId?: string | null;
  latestDiscoveryId: number;
  message: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialCandidateRoster).set({
    discoveryStatus: input.discoveryStatus,
    candidateRecordId: input.discoveryStatus === "found" ? input.candidateRecordId ?? null : null,
    latestDiscoveryId: input.latestDiscoveryId,
    latestShadowTestId: null,
    lastDiscoveryMessage: input.message,
    lastResolvedAt: new Date(),
    evidenceStatus: "unverified",
    sourceSnapshotHash: null,
    rulesSnapshotHash: null,
    xeroPreflightHash: null,
    updatedAt: new Date(),
  }).where(eq(financialCandidateRoster.id, input.id));
}

export async function markFinancialCandidateRosterNeedsData(input: { id: number; message: string }): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialCandidateRoster).set({
    discoveryStatus: "needs_data",
    candidateRecordId: null,
    latestShadowTestId: null,
    lastDiscoveryMessage: input.message.trim(),
    evidenceStatus: "needs_data",
    sourceSnapshotHash: null,
    rulesSnapshotHash: null,
    xeroPreflightHash: null,
    updatedAt: new Date(),
  }).where(eq(financialCandidateRoster.id, input.id));
}

export async function linkFinancialCandidateRosterShadowTest(input: {
  id: number;
  shadowTestId: number;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string;
  selectedPeriodStart?: Date | null;
  selectedPeriodEnd?: Date | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialCandidateRoster).set({
    latestShadowTestId: input.shadowTestId,
    evidenceStatus: "fresh",
    sourceSnapshotHash: input.sourceSnapshotHash,
    rulesSnapshotHash: input.rulesSnapshotHash,
    xeroPreflightHash: input.xeroPreflightHash,
    selectedPeriodStart: input.selectedPeriodStart ?? null,
    selectedPeriodEnd: input.selectedPeriodEnd ?? null,
    updatedAt: new Date(),
  }).where(eq(financialCandidateRoster.id, input.id));
}

export async function createFinancialIntegrationAudit(input: {
  integration: "xero" | "vtiger";
  action: string;
  outcome: "passed" | "blocked" | "failed";
  tenantName?: string | null;
  tenantId?: string | null;
  details?: unknown;
  actorId?: number | null;
  checkedAt?: Date;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(financialIntegrationAudits).values({
    integration: input.integration,
    action: input.action.slice(0, 80),
    outcome: input.outcome,
    tenantName: input.tenantName ?? null,
    tenantId: input.tenantId ?? null,
    details: (input.details ?? {}) as any,
    actorId: input.actorId ?? null,
    checkedAt: input.checkedAt ?? new Date(),
  });
  return Number((result[0] as any).insertId);
}

export async function getFinancialIntegrationAudits(limit = 100): Promise<FinancialIntegrationAudit[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialIntegrationAudits)
    .orderBy(desc(financialIntegrationAudits.checkedAt), desc(financialIntegrationAudits.id))
    .limit(limit);
}

/**
 * Recurring storage may only inspect AP ledger rows created after a verified
 * activation/finalisation execution. Historical/shadow rows are excluded, so
 * this helper cannot infer an active billing obligation.
 */
export async function getVerifiedActiveStorageBillingEvents(limit = 10) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(storageBillingEvents).where(and(
    eq(storageBillingEvents.provenance, "verified_execution"),
    eq(storageBillingEvents.finalisationStatus, "open"),
  )).orderBy(storageBillingEvents.nextBillingDate, desc(storageBillingEvents.updatedAt)).limit(Math.min(Math.max(limit, 1), 10));
}

/**
 * The only storage-event writer. It is intentionally called only after the
 * guarded Xero Draft transport has succeeded and exact Draft readback passed.
 * Shadow evaluations and selector previews must never call this function.
 */
export async function recordVerifiedStorageBillingExecution(input: {
  workflowType: string;
  executionId: number;
  sourceRecordId: string;
  sourceData: Record<string, unknown>;
}): Promise<void> {
  if (!["storage_activation", "storage_finalisation"].includes(input.workflowType)) return;
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const asText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const asDate = (value: unknown) => {
    if (!value) return null;
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const existing = (await db.select().from(storageBillingEvents)
    .where(eq(storageBillingEvents.dealId, input.sourceRecordId))
    .orderBy(desc(storageBillingEvents.updatedAt)).limit(1))[0];
  if (input.workflowType === "storage_finalisation") {
    if (!existing || existing.provenance !== "verified_execution") return;
    await db.update(storageBillingEvents).set({
      finalisationStatus: "finalised",
      finalisationExecutionId: input.executionId,
      dateOut: asDate(input.sourceData.dateOut) ?? existing.dateOut,
      sourceSnapshot: input.sourceData as any,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(storageBillingEvents.id, existing.id));
    return;
  }
  const values = {
    containerControlId: asText(input.sourceData.containerControlId),
    containerNumber: asText(input.sourceData.containerNumber),
    containerType: asText(input.sourceData.containerType),
    storageStage: asText(input.sourceData.storageStage),
    origin: asText(input.sourceData.origin),
    destination: asText(input.sourceData.destination),
    dateIn: asDate(input.sourceData.dateIn),
    dateOut: asDate(input.sourceData.dateOut),
    nextBillingDate: asDate(input.sourceData.nextBillingDate),
    billedThroughDate: asDate(input.sourceData.billedThroughDate),
    provenance: "verified_execution" as const,
    activationExecutionId: input.executionId,
    finalisationStatus: "open" as const,
    sourceSnapshot: input.sourceData as any,
    verifiedAt: new Date(),
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(storageBillingEvents).set(values).where(eq(storageBillingEvents.id, existing.id));
  } else {
    await db.insert(storageBillingEvents).values({ dealId: input.sourceRecordId, ...values });
  }
}

export async function getFinancialOperationsDashboard() {
  const db = await getDb();
  if (!db) return {
    runsToday: 0,
    proposedDocuments: 0,
    confirmedDraftDocuments: 0,
    failedOrHeld: 0,
    openExceptions: 0,
    shadowEvidence: 0,
    candidateLookups: 0,
    releaseManifests: 0,
    integrationChecks: 0,
    nextRecurringHire: null,
    nextStorage: null,
  };
  const midnightUtc = new Date();
  midnightUtc.setUTCHours(0, 0, 0, 0);
  const [runsToday, proposedDocuments, failedOrHeld, openExceptions, shadowEvidence, candidateLookups, releaseManifests, integrationChecks, schedules] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(financialWorkflowRuns).where(gte(financialWorkflowRuns.createdAt, midnightUtc)),
    db.select({ count: sql<number>`count(*)` }).from(financialDocumentIntents),
    db.select({ count: sql<number>`count(*)` }).from(financialWorkflowRuns).where(sql`${financialWorkflowRuns.status} IN ('failed', 'held')`),
    db.select({ count: sql<number>`count(*)` }).from(financialWorkflowExceptions).where(eq(financialWorkflowExceptions.status, "open")),
    db.select({ count: sql<number>`count(*)` }).from(financialShadowTests),
    db.select({ count: sql<number>`count(*)` }).from(financialCandidateDiscoveries),
    db.select({ count: sql<number>`count(*)` }).from(financialReleaseManifests),
    db.select({ count: sql<number>`count(*)` }).from(financialIntegrationAudits),
    db.select().from(workflowSchedules),
  ]);
  const scheduleFor = (type: string) => schedules.find((item) => item.workflowType === type)?.nextRunAt ?? null;
  return {
    runsToday: Number(runsToday[0]?.count ?? 0),
    proposedDocuments: Number(proposedDocuments[0]?.count ?? 0),
    confirmedDraftDocuments: 0, // phase one never writes or confirms Xero drafts
    failedOrHeld: Number(failedOrHeld[0]?.count ?? 0),
    openExceptions: Number(openExceptions[0]?.count ?? 0),
    // Evidence is deliberately independent from trigger evaluations: candidate
    // lookups, validation tests, manifest preparation and integration checks do
    // not create a trigger run or an intended Xero document.
    shadowEvidence: Number(shadowEvidence[0]?.count ?? 0),
    candidateLookups: Number(candidateLookups[0]?.count ?? 0),
    releaseManifests: Number(releaseManifests[0]?.count ?? 0),
    integrationChecks: Number(integrationChecks[0]?.count ?? 0),
    nextRecurringHire: scheduleFor("recurring_for_hire"),
    nextStorage: scheduleFor("recurring_storage"),
  };
}

export async function getFinancialDocuments(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialDocuments).orderBy(desc(financialDocuments.refreshedAt)).limit(limit);
}


export type FinancialCutoverControlView = FinancialCutoverControl & {
  persisted: boolean;
  globalWriteLock: true;
};

const DISABLED_AP_WRITER_IDENTIFIER = "financial-production-writer:disabled (no registered live endpoint)";
const DEFAULT_ROLLBACK_PLAN = "Keep the AP production writer disabled. Do not change an Operations writer, VTiger workflow URL or schedule. For a future approved live cutover, pause the AP family first, retain the ledger and Xero evidence, and reconcile before any manual restoration decision.";

function newCutoverControl(workflowType: string): FinancialCutoverControlView {
  const now = new Date();
  return {
    id: 0,
    workflowType,
    mode: "shadow",
    implementationVersion: FINANCIAL_WRITER_IMPLEMENTATION_VERSION,
    ruleVersion: "financial-automation.rules",
    currentWriterOwner: "unknown",
    previousWriterOwner: "unknown",
    legacyWriterIdentifier: null,
    replacementIdentifier: DISABLED_AP_WRITER_IDENTIFIER,
    liveEnabled: false,
    lastShadowRunId: null,
    lastLiveRunId: null,
    failureCount: 0,
    reconciliationState: "not_started",
    approvalReference: null,
    rollbackPlan: DEFAULT_ROLLBACK_PLAN,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    persisted: false,
    globalWriteLock: true,
  };
}

/**
 * Returns a complete per-family control matrix without creating rows merely by
 * viewing it. Missing rows are deliberately represented as non-persisted
 * shadow controls, keeping database writes administrator-initiated.
 */
export async function getFinancialCutoverControls(): Promise<FinancialCutoverControlView[]> {
  const db = await getDb();
  if (!db) return FINANCIAL_WORKFLOW_TYPES.map((workflowType) => newCutoverControl(workflowType));
  const persisted = await db.select().from(financialCutoverControls).orderBy(financialCutoverControls.workflowType);
  const byWorkflow = new Map(persisted.map((item) => [item.workflowType, item]));
  return FINANCIAL_WORKFLOW_TYPES.map((workflowType) => {
    const control = byWorkflow.get(workflowType);
    return control
      ? { ...control, persisted: true, globalWriteLock: true as const }
      : newCutoverControl(workflowType);
  });
}

/** Reads one per-family execution control without creating or changing it. */
export async function getFinancialCutoverControlForWorkflow(
  workflowType: string,
): Promise<FinancialCutoverControl | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialCutoverControls)
    .where(eq(financialCutoverControls.workflowType, workflowType)).limit(1))[0];
}

export async function getFinancialCutoverPacks(limit = 100): Promise<FinancialCutoverPack[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialCutoverPacks)
    .orderBy(desc(financialCutoverPacks.updatedAt), desc(financialCutoverPacks.id))
    .limit(limit);
}

export async function getFinancialCutoverPack(id: number): Promise<FinancialCutoverPack | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialCutoverPacks).where(eq(financialCutoverPacks.id, id)).limit(1))[0];
}

export async function ensureDisabledFinancialCutoverControl(input: {
  workflowType: string;
  lastShadowRunId?: number | null;
  updatedBy: number;
}): Promise<FinancialCutoverControl> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const existing = (await db.select().from(financialCutoverControls)
    .where(eq(financialCutoverControls.workflowType, input.workflowType)).limit(1))[0];
  const values = {
    mode: "live_ready_disabled" as const,
    implementationVersion: FINANCIAL_WRITER_IMPLEMENTATION_VERSION,
    ruleVersion: "financial-automation.rules",
    currentWriterOwner: "unknown" as const,
    previousWriterOwner: "unknown" as const,
    replacementIdentifier: DISABLED_AP_WRITER_IDENTIFIER,
    liveEnabled: false,
    lastShadowRunId: input.lastShadowRunId ?? null,
    reconciliationState: "awaiting_approval" as const,
    rollbackPlan: DEFAULT_ROLLBACK_PLAN,
    updatedBy: input.updatedBy,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(financialCutoverControls).set(values).where(eq(financialCutoverControls.id, existing.id));
    return { ...existing, ...values };
  }
  const result = await db.insert(financialCutoverControls).values({ workflowType: input.workflowType, ...values });
  const id = Number((result[0] as any).insertId);
  return (await db.select().from(financialCutoverControls).where(eq(financialCutoverControls.id, id)).limit(1))[0]!;
}

/**
 * Stores an exact, reviewable migration pack. It does not constitute approval,
 * cannot set a family live and never calls a Xero transport.
 */
export async function createDisabledFinancialCutoverPack(input: {
  workflowType: string;
  shadowTestId: number;
  candidateRosterEntryId?: number | null;
  sourceRecordNumber?: string | null;
  proposedDocumentIntentIds: number[];
  documentSummary: unknown;
  xeroPreflight?: unknown;
  idempotencyKey?: string | null;
  legacyWriterIdentifier?: string | null;
  preparedBy: number;
}): Promise<{ packId: number; controlId: number }> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const control = await ensureDisabledFinancialCutoverControl({
    workflowType: input.workflowType,
    lastShadowRunId: null,
    updatedBy: input.preparedBy,
  });
  const requiredApprovalText = `Explicit approval required before any live action: identify one named ${input.workflowType} source, the exact Draft Xero document number(s), counterparty, amount and approval reference. This prepared pack does not enable AP Management or disable any existing writer.`;
  const result = await db.insert(financialCutoverPacks).values({
    workflowType: input.workflowType,
    shadowTestId: input.shadowTestId,
    candidateRosterEntryId: input.candidateRosterEntryId ?? null,
    sourceRecordNumber: input.sourceRecordNumber ?? null,
    proposedDocumentIntentIds: input.proposedDocumentIntentIds as any,
    documentSummary: input.documentSummary as any,
    xeroPreflight: input.xeroPreflight as any,
    idempotencyKey: input.idempotencyKey ?? null,
    legacyWriterIdentifier: input.legacyWriterIdentifier ?? null,
    replacementIdentifier: DISABLED_AP_WRITER_IDENTIFIER,
    rollbackPlan: DEFAULT_ROLLBACK_PLAN,
    requiredApprovalText,
    state: "awaiting_approval",
    preparedBy: input.preparedBy,
  });
  const packId = Number((result[0] as any).insertId);
  await db.insert(financialCutoverAudits).values({
    workflowType: input.workflowType,
    cutoverControlId: control.id,
    cutoverPackId: packId,
    action: "disabled_cutover_pack_prepared",
    outcome: "prepared",
    details: {
      shadowOnly: true,
      liveEnabled: false,
      replacementIdentifier: DISABLED_AP_WRITER_IDENTIFIER,
      proposedDocumentIntentIds: input.proposedDocumentIntentIds,
    } as any,
    actorId: input.preparedBy,
  });
  return { packId, controlId: control.id };
}

export async function getFinancialCutoverAudits(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialCutoverAudits)
    .orderBy(desc(financialCutoverAudits.createdAt), desc(financialCutoverAudits.id))
    .limit(limit);
}


export type FinancialReleaseManifestDetail = {
  manifest: FinancialReleaseManifest;
  families: FinancialReleaseFamily[];
  audits: FinancialReleaseAudit[];
};

const RELEASE_DRAFT_ONLY_RESTRICTION = "AP Management may only propose Xero Draft documents. Any non-Draft collision or amendment path must stop, create a local exception and remain outside the release.";

function safeIntegrationReadiness(value: {
  outcome: string;
  checkedAt: Date;
  message: string;
  organisationName?: string | null;
  expectedTenantLabel?: string;
  tokenState?: string;
  configured?: boolean;
  missing?: string[];
}) {
  return {
    outcome: value.outcome,
    checkedAt: value.checkedAt,
    message: value.message,
    organisationName: value.organisationName ?? null,
    expectedTenantLabel: value.expectedTenantLabel ?? null,
    tokenState: value.tokenState ?? null,
    configured: value.configured ?? null,
    missing: value.missing ?? [],
    readOnly: true,
  };
}

export async function getFinancialReleaseManifest(manifestId: number): Promise<FinancialReleaseManifestDetail | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const manifest = (await db.select().from(financialReleaseManifests)
    .where(eq(financialReleaseManifests.id, manifestId)).limit(1))[0];
  if (!manifest) return undefined;
  const [families, audits] = await Promise.all([
    db.select().from(financialReleaseFamilies)
      .where(eq(financialReleaseFamilies.manifestId, manifest.id))
      .orderBy(financialReleaseFamilies.workflowType, financialReleaseFamilies.id),
    db.select().from(financialReleaseAudits)
      .where(eq(financialReleaseAudits.manifestId, manifest.id))
      .orderBy(desc(financialReleaseAudits.createdAt), desc(financialReleaseAudits.id)),
  ]);
  return { manifest, families, audits };
}

export async function getFinancialReleaseManifests(limit = 25): Promise<FinancialReleaseManifestDetail[]> {
  const db = await getDb();
  if (!db) return [];
  const manifests = await db.select().from(financialReleaseManifests)
    .orderBy(desc(financialReleaseManifests.preparedAt), desc(financialReleaseManifests.id))
    .limit(limit);
  return (await Promise.all(manifests.map((manifest) => getFinancialReleaseManifest(manifest.id)))).filter(Boolean) as FinancialReleaseManifestDetail[];
}

/**
 * Freezes an all-family release manifest using current AP-owned evidence only.
 * It invokes GET-only integration health checks and writes AP database audit rows
 * only. It cannot call a financial writer, update a source record, or schedule a
 * recurring task.
 */
export async function prepareAllFinancialReleaseManifest(input: {
  preparedBy: number;
  maintenanceWindow?: string | null;
  releaseOwner?: string | null;
}): Promise<FinancialReleaseManifestDetail> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [config, xero, vtiger, allTests, roster, discoveries, executions] = await Promise.all([
    getFinancialWorkflowConfig(),
    testFinancialXeroConnection(),
    testVtigerFinancialConnection(),
    db.select().from(financialShadowTests).orderBy(desc(financialShadowTests.testedAt), desc(financialShadowTests.id)),
    db.select().from(financialCandidateRoster),
    db.select().from(financialCandidateDiscoveries).orderBy(desc(financialCandidateDiscoveries.createdAt), desc(financialCandidateDiscoveries.id)),
    db.select().from(financialWriterExecutions),
  ]);
  const rules = resolveFinancialAutomationRules(
    config.find((entry) => entry.configKey === FINANCIAL_AUTOMATION_RULE_CONFIG_KEY)?.configValue,
  );
  const postSuccessMappingReadiness = await validateDisabledPostSuccessMapping(
    config.find((entry) => entry.configKey === FINANCIAL_POST_SUCCESS_MAPPING_CONFIG_KEY)?.configValue,
  );

  await Promise.all([
    createFinancialIntegrationAudit({
      integration: "xero",
      action: "all_family_release_get_only_readiness",
      outcome: xero.outcome,
      tenantName: xero.organisationName,
      tenantId: xero.tenantId,
      details: { expectedTenantLabel: xero.expectedTenantLabel, readOnly: true, releasePreparation: true },
      actorId: input.preparedBy,
      checkedAt: xero.checkedAt,
    }),
    createFinancialIntegrationAudit({
      integration: "vtiger",
      action: "all_family_release_read_only_readiness",
      outcome: vtiger.outcome,
      details: { message: vtiger.message, readOnly: true, releasePreparation: true },
      actorId: input.preparedBy,
      checkedAt: vtiger.checkedAt,
    }),
    createFinancialIntegrationAudit({
      integration: "vtiger",
      action: "all_family_disabled_post_success_metadata",
      outcome: postSuccessMappingReadiness.outcome === "passed" ? "passed" : postSuccessMappingReadiness.outcome === "blocked" ? "blocked" : "failed",
      details: { readOnly: true, modules: postSuccessMappingReadiness.modules.map((module) => ({ module: module.module, missingFields: module.missingFields })), assignedUserConfigured: postSuccessMappingReadiness.assignedUser.configured },
      actorId: input.preparedBy,
    }),
  ]);

  const confirmedTests = new Map<string, FinancialShadowTest>();
  for (const family of FINANCIAL_RELEASE_FAMILIES) {
    const exact = allTests.find((test) =>
      test.workflowType === family.workflowType
      && test.branch === family.branch
      && test.status === "passed"
      && test.reviewStatus === "confirmed",
    );
    if (exact) confirmedTests.set(family.familyKey, exact);
  }

  const confirmedIntentRows: Array<[string, Array<Record<string, unknown>>]> = await Promise.all(Array.from(confirmedTests.entries()).map(async ([familyKey, test]) => {
    if (!test.workflowRunId) return [familyKey, []];
    const intents = await db.select().from(financialDocumentIntents)
      .where(eq(financialDocumentIntents.workflowRunId, test.workflowRunId));
    return [familyKey, intents.map((intent) => ({
      id: intent.id,
      documentFamily: intent.documentFamily,
      documentType: intent.documentType,
      proposedAction: intent.proposedAction,
      proposedDocumentNumber: intent.proposedDocumentNumber,
      reference: intent.reference,
      partyName: intent.partyName,
      accountCode: intent.accountCode,
      gstTreatment: intent.gstTreatment,
      subtotal: intent.subtotal,
      taxAmount: intent.taxAmount,
      total: intent.total,
      issueDate: intent.issueDate,
      dueDate: intent.dueDate,
      lineItems: intent.lineItems,
      validationStatus: intent.validationStatus,
    }))];
  }));
  const intentManifest = new Map<string, Array<Record<string, unknown>>>(confirmedIntentRows);

  const latestDiscoveryByFamily = new Map<string, typeof discoveries[number]>();
  for (const discovery of discoveries) {
    if (discovery.familyKey && !latestDiscoveryByFamily.has(discovery.familyKey)) latestDiscoveryByFamily.set(discovery.familyKey, discovery);
  }

  const familyDrafts = await Promise.all(FINANCIAL_RELEASE_FAMILIES.map(async (definition) => {
    const test = confirmedTests.get(definition.familyKey) ?? null;
    const rosterEntry = test
      ? roster.find((entry) => entry.latestShadowTestId === test.id) ?? null
      : null;
    const discovery = latestDiscoveryByFamily.get(definition.familyKey) ?? null;
    const rawDocuments = intentManifest.get(definition.familyKey) ?? [];
    let currentSourceHash: string | null = null;
    let currentXeroPreflight: FinancialXeroPreflight[] = [];
    let currentPreflightError: string | null = null;
    if (test && rosterEntry?.candidateRecordId && xero.outcome === "passed" && vtiger.outcome === "passed") {
      try {
        const rawSource = await retrieveCurrentVtigerFinancialRecord(rosterEntry.candidateRecordId);
        currentSourceHash = sourceSnapshotHash(rawSource);
        // The rows came from the confirmed test's workflow run; this re-reads
        // only exact proposed references, contacts and items, never Xero history.
        currentXeroPreflight = await preflightFinancialXeroIntents(rawDocuments as any);
      } catch (error) {
        currentPreflightError = error instanceof Error ? error.message : "Current source/Xero GET-only preflight was not completed.";
      }
    } else if (test) {
      currentPreflightError = "Current source/Xero GET-only revalidation is unavailable until the exact roster selection and integration checks pass.";
    }
    const currentDocuments = rawDocuments.map((document) => ({
      ...document,
      xeroReadOnlyPreflight: currentXeroPreflight[rawDocuments.indexOf(document)] ?? { duplicateState: "blocked", error: currentPreflightError ?? "No current exact Xero preflight." },
      apExecutionCollision: executions.some((execution) => execution.documentIntentId === document.id)
        ? executions.filter((execution) => execution.documentIntentId === document.id).map((execution) => ({ id: execution.id, status: execution.status, xeroDocumentId: execution.xeroDocumentId, xeroDocumentStatus: execution.xeroDocumentStatus }))
        : [],
    }));
    const candidateOutcome = discovery?.outcome === "no_current_candidate"
      ? "no_current_candidate" as const
      : discovery?.outcome === "found"
        ? "found" as const
        : discovery?.outcome === "blocked"
          ? "blocked" as const
          : "not_run" as const;
    const inventory = FINANCIAL_LEGACY_WRITER_INVENTORY.find((entry) => entry.familyKey === definition.familyKey) ?? null;
    const evidenceFresh = Boolean(rosterEntry && rosterEntry.evidenceStatus === "fresh"
      && rosterEntry.sourceSnapshotHash === currentSourceHash
      && rosterEntry.rulesSnapshotHash === rulesSnapshotHash(rules)
      && rosterEntry.xeroPreflightHash === (currentXeroPreflight.length > 0 ? financialSha256(currentXeroPreflight) : null));
    if (rosterEntry?.evidenceStatus === "fresh" && !evidenceFresh) {
      await db.update(financialCandidateRoster).set({
        evidenceStatus: "stale",
        lastDiscoveryMessage: "Current source, active rules or exact Xero GET-only preflight no longer matches the confirmed evidence. Re-run the selected candidate test.",
        updatedAt: new Date(),
      }).where(eq(financialCandidateRoster.id, rosterEntry.id));
      rosterEntry.evidenceStatus = "stale";
    }
    const currentPreflightUsable = currentXeroPreflight.length === rawDocuments.length
      && currentXeroPreflight.every((preflight) => !["blocked", "error", "ambiguous"].includes(preflight.duplicateState)
        && !(preflight.duplicateState === "found" && String(preflight.status ?? "").toUpperCase() !== "DRAFT"));
    const eligibility = releaseFamilyStatus({
      candidateOutcome,
      confirmedShadowTestId: test?.id ?? null,
      xeroOutcome: xero.outcome,
      vtigerOutcome: vtiger.outcome,
      hasLegacyWriterInventory: Boolean(inventory),
      hasCurrentDocumentManifest: currentDocuments.length > 0 && currentPreflightUsable,
      evidenceFresh,
      hasDisabledPostSuccessMapping: postSuccessMappingReadiness.outcome === "passed",
    });
    return { definition, test, rosterEntry, discovery, inventory, currentDocuments, currentXeroPreflight, currentPreflightError, evidenceFresh, eligibility };
  }));

  const includedFamilyCount = familyDrafts.filter((entry) => entry.eligibility.status === "included").length;
  const heldFamilyCount = familyDrafts.filter((entry) => entry.eligibility.status === "held").length;
  const noCurrentCandidateFamilyCount = familyDrafts.filter((entry) => entry.eligibility.status === "no_current_candidate").length;
  const excludedFamilyCount = 0;
  const releaseId = `AFO-REL-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const currentDocumentManifest = familyDrafts.flatMap((entry) => entry.currentDocuments.map((document) => ({
    familyKey: entry.definition.familyKey,
    workflowType: entry.definition.workflowType,
    branch: entry.definition.branch,
    sourceRecordNumber: entry.test?.sourceRecordNumber ?? null,
    document,
  })));
  const manifestStatus = includedFamilyCount === FINANCIAL_RELEASE_FAMILIES.length
    ? "awaiting_approval"
    : "preparation" as const;

  const manifestInsert = await db.insert(financialReleaseManifests).values({
    releaseId,
    status: manifestStatus,
    implementationVersion: FINANCIAL_WRITER_IMPLEMENTATION_VERSION,
    frozenRuleVersion: frozenRuleVersion(rules),
    frozenRules: rules as any,
    xeroReadiness: safeIntegrationReadiness(xero) as any,
    vtigerReadiness: safeIntegrationReadiness(vtiger) as any,
    maintenanceWindow: input.maintenanceWindow?.trim() || null,
    releaseOwner: input.releaseOwner?.trim() || null,
    currentDocumentManifest: currentDocumentManifest as any,
    includedFamilyCount,
    heldFamilyCount,
    noCurrentCandidateFamilyCount,
    excludedFamilyCount,
    preparedBy: input.preparedBy,
    preparedAt: new Date(),
  });
  const manifestId = Number((manifestInsert[0] as any).insertId);

  for (const entry of familyDrafts) {
    const result = await db.insert(financialReleaseFamilies).values({
      manifestId,
      familyKey: entry.definition.familyKey,
      workflowType: entry.definition.workflowType,
      displayName: entry.definition.displayName,
      branch: entry.definition.branch,
      releaseStatus: entry.eligibility.status,
      statusReason: entry.eligibility.reason,
      expectedReferencePattern: entry.definition.expectedReferencePattern,
      partyAndAccountRules: entry.definition.partyAndAccountRules(rules) as any,
      calculationRules: entry.definition.calculationRules(rules) as any,
      draftOnlyRestriction: RELEASE_DRAFT_ONLY_RESTRICTION,
      firstExpectedTrigger: entry.definition.firstExpectedTrigger,
      apEndpointIdentifier: releaseEndpointIdentifier(entry.definition.familyKey),
      apAuthentication: releaseAuthenticationDescription(),
      apScheduleDefinition: entry.definition.apScheduleDefinition ?? null,
      shadowTestId: entry.test?.id ?? null,
      candidateRosterEntryId: entry.rosterEntry?.id ?? null,
      sourceRecordNumber: entry.test?.sourceRecordNumber ?? null,
      sourcePreflightAt: entry.test?.sourceRefreshedAt ?? null,
      sourceSnapshotHash: entry.rosterEntry?.sourceSnapshotHash ?? entry.discovery?.sourceSnapshotHash ?? null,
      rulesSnapshotHash: entry.rosterEntry?.rulesSnapshotHash ?? entry.discovery?.rulesSnapshotHash ?? null,
      xeroPreflightHash: entry.rosterEntry?.xeroPreflightHash ?? entry.discovery?.xeroPreflightHash ?? null,
      evidenceStale: !entry.evidenceFresh && Boolean(entry.test),
      postSuccessMappingReadiness: {
        outcome: postSuccessMappingReadiness.outcome,
        readOnly: true,
        modules: postSuccessMappingReadiness.modules,
        assignedUser: postSuccessMappingReadiness.assignedUser,
      } as any,
      xeroPreflight: entry.test?.xeroPreflight ?? null,
      currentDocumentSummary: entry.currentDocuments as any,
      legacyWriterIdentifier: entry.inventory?.legacyWriterIdentifier ?? null,
      legacyWriterOwner: entry.inventory?.legacyWriterOwner ?? null,
      legacyDisableAction: entry.inventory?.legacyDisableAction ?? null,
      conditionPayloadContract: entry.definition.conditionPayloadContract,
      rollbackPlan: releaseRollbackPlan(),
    });
    const familyId = Number((result[0] as any).insertId);
    await db.insert(financialReleaseAudits).values({
      manifestId,
      familyId,
      action: "release_family_prepared",
      outcome: entry.eligibility.status === "included" ? "prepared" : "blocked",
      details: {
        releaseStatus: entry.eligibility.status,
        statusReason: entry.eligibility.reason,
        xeroOutcome: xero.outcome,
        vtigerOutcome: vtiger.outcome,
        confirmedShadowTestId: entry.test?.id ?? null,
        currentDocumentCount: entry.currentDocuments.length,
        liveWriterEnabled: false,
      } as any,
      actorId: input.preparedBy,
    });
  }
  await db.insert(financialReleaseAudits).values({
    manifestId,
    familyId: null,
    action: "all_family_release_manifest_prepared",
    outcome: includedFamilyCount === FINANCIAL_RELEASE_FAMILIES.length ? "prepared" : "blocked",
    details: {
      implementationVersion: FINANCIAL_WRITER_IMPLEMENTATION_VERSION,
      frozenRuleVersion: frozenRuleVersion(rules),
      familyCounts: { included: includedFamilyCount, held: heldFamilyCount, noCurrentCandidate: noCurrentCandidateFamilyCount, excluded: excludedFamilyCount },
      xeroOutcome: xero.outcome,
      vtigerOutcome: vtiger.outcome,
      liveWriterEnabled: false,
      schedulesChanged: false,
    } as any,
    actorId: input.preparedBy,
  });
  return (await getFinancialReleaseManifest(manifestId))!;
}

/** Records non-secret legacy writer inventory only. It cannot alter external systems or family eligibility. */
export async function recordFinancialReleaseLegacyInventory(input: {
  manifestId: number;
  familyId: number;
  legacyWriterIdentifier: string;
  legacyWriterOwner: string;
  legacyDisableAction: string;
  actorId: number;
}): Promise<FinancialReleaseFamily> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const family = (await db.select().from(financialReleaseFamilies).where(and(
    eq(financialReleaseFamilies.id, input.familyId),
    eq(financialReleaseFamilies.manifestId, input.manifestId),
  )).limit(1))[0];
  if (!family) throw new Error("Release family was not found in this manifest");
  const values = {
    legacyWriterIdentifier: input.legacyWriterIdentifier.trim(),
    legacyWriterOwner: input.legacyWriterOwner.trim(),
    legacyDisableAction: input.legacyDisableAction.trim(),
    updatedAt: new Date(),
  };
  await db.update(financialReleaseFamilies).set(values).where(eq(financialReleaseFamilies.id, family.id));
  await db.insert(financialReleaseAudits).values({
    manifestId: input.manifestId,
    familyId: family.id,
    action: "legacy_writer_inventory_recorded",
    outcome: "updated",
    details: { liveWriterEnabled: false, fieldsRecorded: ["legacyWriterIdentifier", "legacyWriterOwner", "legacyDisableAction"] } as any,
    actorId: input.actorId,
  });
  return { ...family, ...values };
}


// ─── Guarded Financial Writer Execution Ledger ───────────────────────────────

export type FinancialWriterExecutionInput = {
  workflowRunId?: number | null;
  documentIntentId?: number | null;
  releaseManifestId?: number | null;
  releaseFamilyId?: number | null;
  cutoverPackId?: number | null;
  workflowType: string;
  proposedAction: "create_draft" | "update_draft";
  payload: FinancialDraftPayload;
  approvalReference: string | null;
  preparedBy: number;
};

function writerPayloadFingerprint(payload: FinancialDraftPayload): string {
  return `${payload.idempotencyKey.slice(0, 24)}:${payload.method}:${payload.endpoint}`;
}

function safeWriterPayloadSummary(payload: FinancialDraftPayload): Record<string, unknown> {
  const documents = Array.isArray((payload.body as any).PurchaseOrders)
    ? (payload.body as any).PurchaseOrders
    : Array.isArray((payload.body as any).Invoices)
      ? (payload.body as any).Invoices
      : [];
  const document = documents[0] ?? {};
  return {
    documentFamily: payload.documentFamily,
    documentNumber: payload.documentNumber,
    method: payload.method,
    endpoint: payload.endpoint,
    targetXeroDocumentId: payload.expectedXeroDocumentId,
    lineCount: Array.isArray(document.LineItems) ? document.LineItems.length : 0,
    lineAmountTypes: document.LineAmountTypes ?? null,
    reference: document.Reference ?? null,
  };
}

/**
 * Records a writer attempt before any possible Xero transport. A duplicate
 * idempotency key returns its prior record instead of allowing a second write.
 */
export async function prepareFinancialWriterExecution(input: FinancialWriterExecutionInput): Promise<{
  execution: FinancialWriterExecution;
  duplicate: boolean;
}> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const existing = (await db.select().from(financialWriterExecutions)
    .where(eq(financialWriterExecutions.idempotencyKey, input.payload.idempotencyKey)).limit(1))[0];
  if (existing) return { execution: existing, duplicate: true };

  const executionKey = `FWX-${randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase()}`;
  await db.insert(financialWriterExecutions).values({
    executionKey,
    workflowRunId: input.workflowRunId ?? null,
    documentIntentId: input.documentIntentId ?? null,
    releaseManifestId: input.releaseManifestId ?? null,
    releaseFamilyId: input.releaseFamilyId ?? null,
    cutoverPackId: input.cutoverPackId ?? null,
    workflowType: input.workflowType,
    documentFamily: input.payload.documentFamily,
    proposedAction: input.proposedAction,
    proposedDocumentNumber: input.payload.documentNumber,
    targetXeroDocumentId: input.payload.expectedXeroDocumentId,
    endpoint: input.payload.endpoint,
    method: input.payload.method,
    idempotencyKey: input.payload.idempotencyKey,
    payloadFingerprint: writerPayloadFingerprint(input.payload),
    status: "prepared",
    approvalReference: input.approvalReference?.trim() || null,
    safePayloadSummary: safeWriterPayloadSummary(input.payload) as any,
    preparedBy: input.preparedBy,
  });
  const execution = (await db.select().from(financialWriterExecutions)
    .where(eq(financialWriterExecutions.executionKey, executionKey)).limit(1))[0];
  if (!execution) throw new Error("Failed to record guarded financial writer execution");
  return { execution, duplicate: false };
}

export async function markFinancialWriterExecutionSubmitted(executionId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialWriterExecutions).set({
    status: "submitted",
    submittedAt: new Date(),
  }).where(eq(financialWriterExecutions.id, executionId));
}

export async function markFinancialWriterExecutionSucceeded(
  executionId: number,
  result: FinancialDraftWriteResult,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialWriterExecutions).set({
    status: "succeeded",
    xeroDocumentId: result.xeroDocumentId,
    xeroDocumentStatus: result.status,
    xeroResponseSummary: {
      documentNumber: result.documentNumber,
      endpoint: result.endpoint,
      idempotencyKey: result.idempotencyKey,
    } as any,
    completedAt: new Date(),
  }).where(eq(financialWriterExecutions.id, executionId));
}

/** A timeout or uncertain result deliberately asks for reconciliation, never a blind retry. */
export async function markFinancialWriterExecutionFailed(
  executionId: number,
  error: unknown,
  uncertainOutcome = false,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const message = error instanceof Error ? error.message : String(error);
  await db.update(financialWriterExecutions).set({
    status: uncertainOutcome ? "reconciliation_required" : "failed",
    errorMessage: message.slice(0, 6000),
    completedAt: new Date(),
  }).where(eq(financialWriterExecutions.id, executionId));
}

export async function getFinancialWriterExecutions(limit = 50): Promise<FinancialWriterExecution[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialWriterExecutions)
    .orderBy(desc(financialWriterExecutions.createdAt), desc(financialWriterExecutions.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}


// ─── Immutable proposal approvals and post-success work ──────────────────────

export async function getFinancialDocumentIntentDetail(intentId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const row = (await db.select({ intent: financialDocumentIntents, run: financialWorkflowRuns })
    .from(financialDocumentIntents)
    .innerJoin(financialWorkflowRuns, eq(financialWorkflowRuns.id, financialDocumentIntents.workflowRunId))
    .where(eq(financialDocumentIntents.id, intentId))
    .limit(1))[0];
  return row ?? undefined;
}

/** Binds exact GET-only preflight evidence to the immutable local intent. */
export async function setFinancialIntentPreflightHash(input: {
  intentId: number;
  xeroPreflightHash: string;
  preflightSummary: unknown;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialDocumentIntents).set({
    xeroPreflightHash: input.xeroPreflightHash,
    validationSummary: { proposedOnly: true, xeroWritePermitted: false, latestPreflight: input.preflightSummary } as any,
    updatedAt: new Date(),
  }).where(eq(financialDocumentIntents.id, input.intentId));
}

export type CreateFinancialExecutionApprovalInput = {
  workflowRunId: number;
  documentIntentId: number;
  releaseManifestId?: number | null;
  releaseFamilyId?: number | null;
  cutoverPackId?: number | null;
  workflowType: string;
  documentFamily: "purchase_order" | "customer_invoice";
  proposedAction: "create_draft" | "update_draft";
  proposalHash: string;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string;
  sourceRecordId?: string | null;
  sourceRecordNumber?: string | null;
  proposedDocumentNumber: string;
  counterpartyName?: string | null;
  approvalReference: string;
  acknowledgement: string;
  approvalSummary: unknown;
  approvedBy: number;
  expiresAt?: Date | null;
};

/** Creates one single-use approval record for an exact immutable proposal hash. */
export async function createFinancialExecutionApproval(input: CreateFinancialExecutionApprovalInput): Promise<FinancialExecutionApproval> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const approvalKey = `faa-${Date.now()}-${randomUUID().slice(0, 12)}`;
  const insert = await db.insert(financialExecutionApprovals).values({
    approvalKey,
    workflowRunId: input.workflowRunId,
    documentIntentId: input.documentIntentId,
    releaseManifestId: input.releaseManifestId ?? null,
    releaseFamilyId: input.releaseFamilyId ?? null,
    cutoverPackId: input.cutoverPackId ?? null,
    workflowType: input.workflowType,
    documentFamily: input.documentFamily,
    proposedAction: input.proposedAction,
    proposalHash: input.proposalHash,
    sourceSnapshotHash: input.sourceSnapshotHash,
    rulesSnapshotHash: input.rulesSnapshotHash,
    xeroPreflightHash: input.xeroPreflightHash,
    sourceRecordId: input.sourceRecordId ?? null,
    sourceRecordNumber: input.sourceRecordNumber ?? null,
    proposedDocumentNumber: input.proposedDocumentNumber,
    counterpartyName: input.counterpartyName ?? null,
    approvalReference: input.approvalReference,
    acknowledgement: input.acknowledgement,
    approvalSummary: input.approvalSummary as any,
    approvedBy: input.approvedBy,
    expiresAt: input.expiresAt ?? null,
  });
  const row = (await db.select().from(financialExecutionApprovals)
    .where(eq(financialExecutionApprovals.id, Number((insert[0] as any).insertId))).limit(1))[0];
  if (!row) throw new Error("Financial execution approval was not persisted");
  return row;
}

export async function getFinancialExecutionApproval(approvalId: number): Promise<FinancialExecutionApproval | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialExecutionApprovals).where(eq(financialExecutionApprovals.id, approvalId)).limit(1))[0];
}

export async function getFinancialExecutionApprovals(limit = 200): Promise<FinancialExecutionApproval[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialExecutionApprovals).orderBy(desc(financialExecutionApprovals.createdAt)).limit(limit);
}

export async function invalidateFinancialExecutionApproval(approvalId: number, reason: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialExecutionApprovals).set({
    status: "invalidated",
    invalidationReason: reason,
    updatedAt: new Date(),
  }).where(and(eq(financialExecutionApprovals.id, approvalId), eq(financialExecutionApprovals.status, "approved")));
}

/** Atomically consumes one exact approval only after a local writer execution exists. */
export async function consumeFinancialExecutionApproval(approvalId: number, executionId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result: any = await db.update(financialExecutionApprovals).set({
    status: "consumed",
    consumedByExecutionId: executionId,
    consumedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(financialExecutionApprovals.id, approvalId), eq(financialExecutionApprovals.status, "approved")));
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}

export async function createFinancialPostSuccessAction(input: {
  executionId: number;
  workflowType: string;
  actionType: "vtiger_note" | "vtiger_task" | "vtiger_hire_end_update";
  sourceRecordId: string;
  payloadHash: string;
  safePayloadSummary: unknown;
}): Promise<FinancialPostSuccessAction> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const actionKey = `post-${input.executionId}-${input.actionType}-${input.payloadHash.slice(0, 16)}`;
  await db.insert(financialPostSuccessActions).values({
    executionId: input.executionId,
    workflowType: input.workflowType,
    actionType: input.actionType,
    actionKey,
    sourceRecordId: input.sourceRecordId,
    payloadHash: input.payloadHash,
    safePayloadSummary: input.safePayloadSummary as any,
  }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  const row = (await db.select().from(financialPostSuccessActions)
    .where(eq(financialPostSuccessActions.actionKey, actionKey)).limit(1))[0];
  if (!row) throw new Error("Post-success action was not persisted");
  return row;
}

export async function getFinancialPostSuccessActions(limit = 200): Promise<FinancialPostSuccessAction[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialPostSuccessActions).orderBy(desc(financialPostSuccessActions.createdAt)).limit(limit);
}

export async function getFinancialPostSuccessActionById(actionId: number): Promise<FinancialPostSuccessAction | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialPostSuccessActions)
    .where(eq(financialPostSuccessActions.id, actionId)).limit(1))[0];
}

export async function getFinancialPostSuccessActionsForExecution(executionId: number): Promise<FinancialPostSuccessAction[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialPostSuccessActions)
    .where(eq(financialPostSuccessActions.executionId, executionId))
    .orderBy(financialPostSuccessActions.id);
}

/**
 * Atomically claims one post-success action. Claiming applies only to AP-local
 * follow-up work; it is never used to replay a Xero financial write.
 */
export async function claimFinancialPostSuccessAction(actionId: number): Promise<FinancialPostSuccessAction | undefined> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result: any = await db.update(financialPostSuccessActions).set({
    status: "running",
    attemptCount: sql`${financialPostSuccessActions.attemptCount} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(financialPostSuccessActions.id, actionId),
    inArray(financialPostSuccessActions.status, ["pending", "failed"]),
  ));
  const affected = Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0);
  if (affected !== 1) return undefined;
  return (await db.select().from(financialPostSuccessActions)
    .where(eq(financialPostSuccessActions.id, actionId)).limit(1))[0];
}

export async function markFinancialPostSuccessActionSucceeded(input: {
  actionId: number;
  vtigerRecordId?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.update(financialPostSuccessActions).set({
    status: "succeeded",
    vtigerRecordId: input.vtigerRecordId ?? null,
    errorMessage: null,
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(financialPostSuccessActions.id, input.actionId));
}

export async function markFinancialPostSuccessActionFailed(input: {
  actionId: number;
  error: unknown;
  reconciliationRequired?: boolean;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await db.update(financialPostSuccessActions).set({
    status: input.reconciliationRequired ? "reconciliation_required" : "failed",
    errorMessage: message.slice(0, 6000),
    completedAt: input.reconciliationRequired ? new Date() : null,
    updatedAt: new Date(),
  }).where(eq(financialPostSuccessActions.id, input.actionId));
}

export async function getRetryableFinancialPostSuccessActions(limit = 20): Promise<FinancialPostSuccessAction[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialPostSuccessActions)
    .where(and(
      inArray(financialPostSuccessActions.status, ["pending", "failed"]),
      sql`${financialPostSuccessActions.attemptCount} < 3`,
    ))
    .orderBy(financialPostSuccessActions.createdAt)
    .limit(Math.max(1, Math.min(limit, 50)));
}
