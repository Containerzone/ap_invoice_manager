import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  extraHireRuns,
  financialDocumentIntents,
  financialDocuments,
  financialCandidateDiscoveries,
  financialIntegrationAudits,
  financialShadowTests,
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
  type FinancialCandidateDiscovery,
  type FinancialIntegrationAudit,
  type FinancialShadowTest,
  type FinancialWorkflowException,
  type FinancialWorkflowRun,
} from "../drizzle/schema";
import { getDb } from "./db";
import type { FinancialWorkflowEvaluation, FinancialWorkflowInput } from "./financialWorkflowEngine";

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

  if (["storage_activation", "recurring_storage", "storage_finalisation"].includes(input.workflowType)) {
    await db.insert(storageBillingEvents).values({
      dealId: input.sourceRecordId ?? null,
      containerControlId: typeof input.sourceData.containerControlId === "string" ? input.sourceData.containerControlId : null,
      containerNumber: typeof input.sourceData.containerNumber === "string" ? input.sourceData.containerNumber : null,
      containerType: typeof input.sourceData.containerType === "string" ? input.sourceData.containerType : null,
      storageStage: typeof input.sourceData.storageStage === "string" ? input.sourceData.storageStage : null,
      origin: typeof input.sourceData.origin === "string" ? input.sourceData.origin : null,
      destination: typeof input.sourceData.destination === "string" ? input.sourceData.destination : null,
      dateIn: input.sourceData.dateIn ? new Date(String(input.sourceData.dateIn)) : null,
      dateOut: input.sourceData.dateOut ? new Date(String(input.sourceData.dateOut)) : null,
      finalisationStatus: input.workflowType === "storage_finalisation" ? (status === "evaluated" ? "pending" : "held") : "open",
      sourceSnapshot: input.sourceData as any,
    });
  }

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
  sourceCategory: "deal" | "container_control";
  businessNumber: string;
  workflowType: string;
  outcome: "found" | "not_found" | "ambiguous" | "blocked";
  candidateRecordIds: string[];
  sourceRefreshedAt?: Date | null;
  message: string;
  initiatedBy: number;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(financialCandidateDiscoveries).values({
    ...input,
    candidateRecordIds: input.candidateRecordIds as any,
    sourceRefreshedAt: input.sourceRefreshedAt ?? null,
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

export async function getFinancialOperationsDashboard() {
  const db = await getDb();
  if (!db) return { runsToday: 0, proposedDocuments: 0, confirmedDraftDocuments: 0, failedOrHeld: 0, openExceptions: 0, nextRecurringHire: null, nextStorage: null };
  const midnightUtc = new Date();
  midnightUtc.setUTCHours(0, 0, 0, 0);
  const [runsToday, proposedDocuments, failedOrHeld, openExceptions, schedules] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(financialWorkflowRuns).where(gte(financialWorkflowRuns.createdAt, midnightUtc)),
    db.select({ count: sql<number>`count(*)` }).from(financialDocumentIntents),
    db.select({ count: sql<number>`count(*)` }).from(financialWorkflowRuns).where(sql`${financialWorkflowRuns.status} IN ('failed', 'held')`),
    db.select({ count: sql<number>`count(*)` }).from(financialWorkflowExceptions).where(eq(financialWorkflowExceptions.status, "open")),
    db.select().from(workflowSchedules),
  ]);
  const scheduleFor = (type: string) => schedules.find((item) => item.workflowType === type)?.nextRunAt ?? null;
  return {
    runsToday: Number(runsToday[0]?.count ?? 0),
    proposedDocuments: Number(proposedDocuments[0]?.count ?? 0),
    confirmedDraftDocuments: 0, // phase one never writes or confirms Xero drafts
    failedOrHeld: Number(failedOrHeld[0]?.count ?? 0),
    openExceptions: Number(openExceptions[0]?.count ?? 0),
    nextRecurringHire: scheduleFor("recurring_for_hire"),
    nextStorage: scheduleFor("recurring_storage"),
  };
}

export async function getFinancialDocuments(limit = 200) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialDocuments).orderBy(desc(financialDocuments.refreshedAt)).limit(limit);
}
