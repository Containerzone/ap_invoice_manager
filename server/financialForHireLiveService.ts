import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  bindForHirePayload,
  claimForHirePreview,
  clearForHireNextBillingDate,
  completeForHireDraft,
  dueForHireRecurringRoots,
  getForHireEventForPeriod,
  holdForHireExecution,
  latestVerifiedForHireEvent,
} from "./financialForHireDb";
import { previewInitialForHirePo, previewRecurringForHirePo, type ForHirePreviewResult } from "./financialForHireService";
import { assertForHireRelease, getForHireReleasePolicy } from "./financialForHireRelease";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

function sydneyToday(): string {
  return Temporal.Now.zonedDateTimeISO("Australia/Sydney").toPlainDate().toString();
}

function nextDay(value: string): string {
  return Temporal.PlainDate.from(value).add({ days: 1 }).toString();
}

function holdReason(error: unknown): string {
  return error instanceof Error ? error.message : "For Hire Draft execution could not be reconciled.";
}

async function executeCurrentPreview(input: {
  kind: "initial" | "recurring";
  recordId: string;
  now: string;
  expectedPriorEventId?: number | null;
}) {
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, input.kind === "initial" ? "initial" : "recurring");
  const preview = input.kind === "initial"
    ? await previewInitialForHirePo(input.recordId)
    : await previewRecurringForHirePo(input.recordId, input.now);

  if (preview.state === "dehired") {
    if (input.expectedPriorEventId) await clearForHireNextBillingDate(input.expectedPriorEventId);
    return { ok: true, status: "dehired" as const, recordId: input.recordId, xeroWritesAttempted: 0 };
  }
  if (preview.state !== "previewed" || !preview.preview.document || !preview.preview.periodStart || !preview.preview.periodEnd) {
    return { ok: false, status: "held" as const, recordId: input.recordId, warning: preview.holdReason ?? "For Hire source or Xero preflight is not ready.", xeroWritesAttempted: 0 };
  }

  if (input.kind === "recurring" && input.expectedPriorEventId) {
    const currentPrior = await latestVerifiedForHireEvent(input.recordId);
    if (!currentPrior || currentPrior.id !== input.expectedPriorEventId) {
      return { ok: false, status: "held" as const, recordId: input.recordId, warning: "For Hire predecessor changed since schedule selection; no stale extension was created.", xeroWritesAttempted: 0 };
    }
  }

  const event = await getForHireEventForPeriod({
    containerControlId: input.recordId,
    eventKind: input.kind,
    billingPeriodStart: preview.preview.periodStart,
  });
  if (!event) throw new Error("For Hire current preflight was not recorded in the AP ledger.");
  if (event.status === "drafts_created") {
    return { ok: true, status: "duplicate_replay" as const, recordId: input.recordId, eventId: event.id, poNumber: event.proposedPoNumber, xeroWritesAttempted: 0 };
  }
  if (event.status === "reconciliation_required") {
    return { ok: false, status: "reconciliation_required" as const, recordId: input.recordId, eventId: event.id, warning: event.holdReason ?? "Existing For Hire write is awaiting reconciliation.", xeroWritesAttempted: 0 };
  }

  const token = randomUUID();
  if (!(await claimForHirePreview(event.id, token))) {
    return { ok: false, status: "held" as const, recordId: input.recordId, eventId: event.id, warning: "For Hire period is already being processed or was not freshly preflighted.", xeroWritesAttempted: 0 };
  }

  try {
    const payload = prepareFinancialDraftPayload(preview.preview.document, `${input.recordId}:${input.kind}:${preview.preview.periodStart}`);
    const first = (payload.body.PurchaseOrders as Record<string, unknown>[] | undefined)?.[0];
    if (!first) throw new Error("For Hire transport payload is missing its Purchase Order.");
    first.CurrencyCode = "AUD";
    await bindForHirePayload(event.id, policy.releaseKey, payload);

    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: input.kind === "initial" ? "initial_for_hire" : "recurring_for_hire",
      proposedAction: "create_draft",
      payload,
      expectedDraftDocument: preview.preview.document,
      preparedBy: policy.approvedBy!,
      sourceRecordId: input.recordId,
      verifiedSourceData: { containerControlId: input.recordId, sourceSnapshotHash: preview.sourceSnapshotHash },
      authorisation: {
        workflowType: input.kind === "initial" ? "initial_for_hire" : "recurring_for_hire",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        forHireAutomaticEventId: event.id,
        forHireReleaseKey: policy.releaseKey,
        forHireApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome === "reconciliation_required") {
      await holdForHireExecution(event.id, "Xero response is ambiguous; reconcile the exact AP execution before retrying.", true);
      return { ok: false, status: "reconciliation_required" as const, recordId: input.recordId, eventId: event.id, warning: "Xero result is ambiguous; no blind retry will occur.", xeroWritesAttempted: 1 };
    }
    if (outcome.outcome === "duplicate") {
      await holdForHireExecution(event.id, "An existing AP execution reservation requires reconciliation before a further For Hire write.", true);
      return { ok: false, status: "reconciliation_required" as const, recordId: input.recordId, eventId: event.id, warning: "Existing For Hire execution is awaiting reconciliation.", xeroWritesAttempted: 0 };
    }

    await completeForHireDraft({
      eventId: event.id,
      executionId: outcome.executionId,
      xeroPurchaseOrderId: outcome.result.xeroDocumentId,
      nextBillingDate: nextDay(preview.preview.periodEnd),
      priorEventId: input.expectedPriorEventId ?? null,
    });
    return { ok: true, status: "drafts_created" as const, recordId: input.recordId, eventId: event.id, poNumber: outcome.result.documentNumber, xeroPurchaseOrderId: outcome.result.xeroDocumentId, xeroWritesAttempted: 1 };
  } catch (error) {
    await holdForHireExecution(event.id, holdReason(error));
    throw error;
  }
}

/** Called only by the protected, independent FOR HIRE VTiger Request branch. */
export async function processAutomaticInitialForHire(recordId: string) {
  return executeCurrentPreview({ kind: "initial", recordId, now: sydneyToday() });
}

/** Processes exactly one AP-created due predecessor. It never imports Operations history. */
export async function processAutomaticRecurringForHire(recordId: string, priorEventId: number, now = sydneyToday()) {
  return executeCurrentPreview({ kind: "recurring", recordId, now, expectedPriorEventId: priorEventId });
}

/** Bounded scheduled selector; only locally verified For Hire roots due at the Sydney run date are considered. */
export async function runAutomaticRecurringForHire(now = sydneyToday()) {
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, "recurring");
  const roots = await dueForHireRecurringRoots(now, 10);
  const results: Array<Record<string, unknown>> = [];
  for (const root of roots) {
    try {
      results.push({ control: root.containerControlNumber, ...await processAutomaticRecurringForHire(root.containerControlId, root.id, now) });
    } catch (error) {
      const message = holdReason(error);
      reportWorkflowFailureSafely({
        workflowType: "recurring_for_hire",
        recordKey: `for-hire:${root.containerControlId}:${root.billingPeriodStart}`,
        title: "For Hire recurring PO held",
        errorMessage: message,
        details: { containerControlId: root.containerControlId, periodStart: root.billingPeriodStart },
        severity: "error",
      });
      results.push({ control: root.containerControlNumber, ok: false, status: "held", warning: "For Hire extension held; inspect the AP lifecycle ledger." });
    }
  }
  return { ok: true, considered: roots.length, results, xeroWritesAttempted: results.filter((row) => row.xeroWritesAttempted === 1).length };
}
