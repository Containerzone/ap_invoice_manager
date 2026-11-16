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
  assertForHireRecurringScopeForControl,
} from "./financialForHireDb";
import { previewInitialForHirePo, previewRecurringForHirePo, type ForHirePreviewResult } from "./financialForHireService";
import { assertForHireRelease, assertForHireRecurringControlAllowed, getForHireReleasePolicy } from "./financialForHireRelease";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";
import { getManualForHireHandover, isManualForHireHandoverEnabled, dueManualForHireHandovers, claimManualForHireHandover, holdManualForHireHandover } from "./financialForHireManualHandoverDb";
import type { MixedManualForHireHandoverPlan } from "./financialForHireMixedAnchor";
import { financialSha256 } from "./financialProposalIntegrity";
import { withForHireInitialServerContext, type ForHireInitialServerContext } from "./financialForHireFutureEligibilityDb";

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
  expectedManualHandoverId?: number;
}) {
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, input.kind === "initial" ? "initial" : "recurring");
  let recurringScope = input.kind === "recurring" ? await assertForHireRecurringScopeForControl(policy, input.recordId, input.expectedManualHandoverId === undefined ? input.expectedPriorEventId : undefined) : undefined;
  if (input.expectedManualHandoverId !== undefined && (input.kind !== "recurring" || !isManualForHireHandoverEnabled())) throw new Error("Manual opening-point execution is not enabled for this flow.");
  if (input.expectedManualHandoverId !== undefined) {
    const { readForHireContainerControl } = await import("./financialForHireService");
    const current = await readForHireContainerControl(input.recordId);
    if (current.status.trim().toUpperCase() === "DEHIRED") {
      await holdManualForHireHandover({ id: input.expectedManualHandoverId, containerControlId: input.recordId, reason: "Container is DEHIRED; no future hire PO.", dehired: true });
      return { ok: true, status: "dehired" as const, recordId: input.recordId, xeroWritesAttempted: 0 };
    }
  }
  const preview = input.kind === "initial"
    ? await previewInitialForHirePo(input.recordId)
    : await previewRecurringForHirePo(input.recordId, input.now, input.expectedManualHandoverId);

  if (preview.state === "dehired") {
    if (input.expectedPriorEventId) await clearForHireNextBillingDate(input.expectedPriorEventId);
    return { ok: true, status: "dehired" as const, recordId: input.recordId, xeroWritesAttempted: 0 };
  }
  if (preview.state !== "previewed" || !preview.preview.document || !preview.preview.periodStart || !preview.preview.periodEnd ||
    !preview.preview.proposedPoNumber || preview.preview.proposedPoNumber !== preview.preview.document.proposedDocumentNumber) {
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
  const expectedPreview = {
    containerControlId: input.recordId, eventKind: input.kind, billingPeriodStart: preview.preview.periodStart,
    billingPeriodEnd: preview.preview.periodEnd, proposedPoNumber: preview.preview.proposedPoNumber,
    sourceSnapshotHash: preview.sourceSnapshotHash, rulesSnapshotHash: preview.rulesSnapshotHash, xeroPreflightHash: preview.xeroPreflightHash,
    proposalHash: financialSha256(preview.preview.document),
  };
  if (input.expectedManualHandoverId !== undefined && preview.manualOpeningPoint?.id !== input.expectedManualHandoverId) {
    return { ok: false, status: "held" as const, recordId: input.recordId, eventId: event.id, warning: "The preview has no exact verified manual opening identity.", xeroWritesAttempted: 0 };
  }
  if (input.kind === "recurring") recurringScope = await assertForHireRecurringScopeForControl(await getForHireReleasePolicy(), input.recordId, input.expectedManualHandoverId === undefined ? input.expectedPriorEventId : undefined,
    { currentEvent: event, expectedProofHash: recurringScope?.branch === "future" ? recurringScope.proofHash : undefined });
  const futureProofHash = recurringScope?.branch === "future" ? recurringScope.proofHash : undefined;
  if (!(await claimForHirePreview(event.id, token, { expectedPreview, priorEventId: input.expectedPriorEventId, manualHandoverId: input.expectedManualHandoverId, manualHandoverPlanHash: preview.manualOpeningPoint?.planHash, ...(futureProofHash ? { futureProofHash } : {}) }))) {
    return { ok: false, status: "held" as const, recordId: input.recordId, eventId: event.id, warning: "For Hire period is already being processed or was not freshly preflighted.", xeroWritesAttempted: 0 };
  }

  let manualOpening: { id: number; planHash: string } | undefined;
  let priorEventId = input.expectedPriorEventId ?? null;
  let manualClaimed = false;
  let writerInvoked = false;
  try {
    if (input.expectedManualHandoverId !== undefined) {
      const row = await getManualForHireHandover(input.recordId);
      if (!row || row.id !== input.expectedManualHandoverId || row.planHash !== preview.manualOpeningPoint?.planHash || !(await claimManualForHireHandover({ id: row.id, planHash: row.planHash, token, eventId: event.id }))) throw new Error("Manual opening point is already claimed, changed or awaiting reconciliation.");
      manualOpening = { id: row.id, planHash: row.planHash };
      priorEventId = (row.plan as MixedManualForHireHandoverPlan).priorApAnchor?.id ?? null;
      manualClaimed = true;
    }
    const payload = prepareFinancialDraftPayload(preview.preview.document, `${input.recordId}:${input.kind}:${preview.preview.periodStart}`);
    const first = (payload.body.PurchaseOrders as Record<string, unknown>[] | undefined)?.[0];
    if (!first) throw new Error("For Hire transport payload is missing its Purchase Order.");
    first.CurrencyCode = "AUD";
    await bindForHirePayload(event.id, policy.releaseKey, payload, { token, expectedPreview, preparedDocument: preview.preview.document, ...(futureProofHash ? { futureProofHash } : {}) }, manualOpening, priorEventId);

    writerInvoked = true;
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
      if (manualOpening) await holdManualForHireHandover({ id: manualOpening.id, containerControlId: input.recordId, token, reason: "First AP Draft writer result is uncertain; no manual opening replay is allowed." });
      return { ok: false, status: "reconciliation_required" as const, recordId: input.recordId, eventId: event.id, warning: "Xero result is ambiguous; no blind retry will occur.", xeroWritesAttempted: 1 };
    }
    if (outcome.outcome === "duplicate") {
      await holdForHireExecution(event.id, "An existing AP execution reservation requires reconciliation before a further For Hire write.", true);
      if (manualOpening) await holdManualForHireHandover({ id: manualOpening.id, containerControlId: input.recordId, token, reason: "Existing first AP execution reservation requires reconciliation." });
      return { ok: false, status: "reconciliation_required" as const, recordId: input.recordId, eventId: event.id, warning: "Existing For Hire execution is awaiting reconciliation.", xeroWritesAttempted: 0 };
    }

    await completeForHireDraft({
      eventId: event.id,
      executionId: outcome.executionId,
      xeroPurchaseOrderId: outcome.result.xeroDocumentId,
      nextBillingDate: nextDay(preview.preview.periodEnd),
      priorEventId,
      token,
      ...(manualOpening ? { manualOpeningPoint: { ...manualOpening, token } } : {}),
    });
    return { ok: true, status: "drafts_created" as const, recordId: input.recordId, eventId: event.id, poNumber: outcome.result.documentNumber, xeroPurchaseOrderId: outcome.result.xeroDocumentId, xeroWritesAttempted: 1 };
  } catch (error) {
    // Once the guarded writer has been invoked, even a thrown local/readback
    // error must not turn a potentially submitted POST into a retryable preview.
    await holdForHireExecution(event.id, holdReason(error), writerInvoked);
    if (manualClaimed && manualOpening) await holdManualForHireHandover({ id: manualOpening.id, containerControlId: input.recordId, token, reason: holdReason(error) });
    const reported = error instanceof Error ? error : new Error(holdReason(error));
    Object.assign(reported, { forHireFinancialWriteAttempted: writerInvoked });
    throw reported;
  }
}

/** Called only by the protected, independent FOR HIRE VTiger Request branch. */
export async function processAutomaticInitialForHire(recordId: string, trustedServerContext?: ForHireInitialServerContext) {
  return withForHireInitialServerContext(trustedServerContext, () => executeCurrentPreview({ kind: "initial", recordId, now: sydneyToday() }));
}

/** Processes exactly one AP-created due predecessor. It never imports Operations history. */
export async function processAutomaticRecurringForHire(recordId: string, priorEventId: number, now = sydneyToday()) {
  return executeCurrentPreview({ kind: "recurring", recordId, now, expectedPriorEventId: priorEventId });
}

/** First AP Draft after one separately approved manual coverage opening point. */
export async function processAutomaticManualForHireOpening(recordId: string, handoverId: number, now = sydneyToday()) {
  return executeCurrentPreview({ kind: "recurring", recordId, now, expectedManualHandoverId: handoverId });
}

/** Daily check, not daily billing: only AP-owned predecessors due on/before the Sydney business date are selected. */
export async function runAutomaticRecurringForHire(now = sydneyToday(), afterEventId = 0, afterManualHandoverId = 0) {
  const policy = await getForHireReleasePolicy();
  assertForHireRelease(policy, "recurring");
  const approvedControlIds = policy.recurringControlIds ?? [];
  const policyScope = policy.recurringFutureInitialsEnabled ? policy : approvedControlIds;
  const roots = await dueForHireRecurringRoots(now, 10, afterEventId, policyScope);
  const results: Array<Record<string, unknown>> = [];
  for (const root of roots) {
    try {
      await assertForHireRecurringScopeForControl(policy, root.containerControlId, root.id);
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
      const potentiallyWritten = (error as any)?.forHireFinancialWriteAttempted === true;
      results.push({ control: root.containerControlNumber, ok: false, status: potentiallyWritten ? "reconciliation_required" : "held", xeroWritesAttempted: potentiallyWritten ? 1 : 0, warning: "For Hire extension held; inspect the AP lifecycle ledger." });
    }
  }
  const manualEnabled = isManualForHireHandoverEnabled();
  const manualRoots = manualEnabled && roots.length < 10 ? await dueManualForHireHandovers(now, 10 - roots.length, afterManualHandoverId, approvedControlIds) : [];
  for (const opening of manualRoots) {
    try {
      assertForHireRecurringControlAllowed(policy, opening.containerControlId);
      results.push({ control: opening.containerControlNumber, origin: "manual_opening_point", ...await processAutomaticManualForHireOpening(opening.containerControlId, opening.id, now) });
    } catch (error) {
      await holdManualForHireHandover({ id: opening.id, containerControlId: opening.containerControlId, reason: holdReason(error) });
      reportWorkflowFailureSafely({ workflowType: "recurring_for_hire", recordKey: `manual-hire:${opening.id}`, title: "Manual hire opening point held", errorMessage: holdReason(error), details: { containerControlId: opening.containerControlId }, severity: "error" });
      const potentiallyWritten = (error as any)?.forHireFinancialWriteAttempted === true;
      results.push({ control: opening.containerControlNumber, origin: "manual_opening_point", ok: false, status: potentiallyWritten ? "reconciliation_required" : "held", xeroWritesAttempted: potentiallyWritten ? 1 : 0 });
    }
  }
  // Held receipts keep their billing markers and immutable claims. Traverse
  // beyond them using task-owned AP metadata, so they cannot starve other due
  // containers or be repeatedly attempted in one daily traversal.
  const lastVisitedEventId = roots.reduce((last, root) => Math.max(last, root.id), afterEventId);
  const lastVisitedManualHandoverId = manualRoots.reduce((last, row) => Math.max(last, row.id), afterManualHandoverId);
  const considered = roots.length + manualRoots.length;
  const retryRemainingBatch = considered === 10 && ((await dueForHireRecurringRoots(now, 1, lastVisitedEventId, policyScope)).length > 0 || (manualEnabled && (await dueManualForHireHandovers(now, 1, lastVisitedManualHandoverId, approvedControlIds)).length > 0));
  return { ok: true, considered, results, lastVisitedEventId, lastVisitedManualHandoverId, retryRemainingBatch, xeroWritesAttempted: results.filter((row) => row.xeroWritesAttempted === 1).length };
}
