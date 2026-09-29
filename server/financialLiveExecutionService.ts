import { TRPCError } from "@trpc/server";
import {
  getFinancialCutoverControlForWorkflow,
  getFinancialCutoverPack,
  getFinancialExecutionApproval,
  getFinancialPostSuccessActionsForExecution,
  getFinancialReleaseManifest,
} from "./financialWorkflowDb";
import {
  FinancialWriteDisabledError,
  isFinancialLiveWriteEnvironmentEnabled,
  type FinancialWriteAuthorisation,
} from "./financialProductionWriter";
import { prepareVerifiedFinancialDraftPayload } from "./financialVerifiedDraftPayload";
import { revalidateApprovedFinancialExecution } from "./financialApprovalService";
import { executeGuardedFinancialWriterCommand, type GuardedFinancialWriterOutcome } from "./financialWriterExecutionService";
import { planFinancialPostSuccessActions } from "./financialPostSuccessPlan";
import { runFinancialPostSuccessAction } from "./vtigerFinancialWriteService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

/**
 * This setting is deliberately deployment-owned. It defaults to true, and no
 * tRPC procedure, webhook or scheduled handler can change it. A later
 * production release must set it to exactly "false" as one of several gates.
 */
export function isFinancialGlobalShadowModeEnabled(): boolean {
  return process.env.FINANCIAL_GLOBAL_SHADOW_MODE !== "false";
}

export type FinancialExecutionGateState = {
  environmentLiveWritesEnabled: boolean;
  globalShadowMode: boolean;
  familyLiveEnabled: boolean;
  releaseManifestApproved: boolean;
  releaseFamilyIncluded: boolean;
  cutoverPackApproved: boolean;
  legacyWriterHandoffComplete: boolean;
  currentDocumentPreflightPassed: boolean;
};

export type ExecuteApprovedFinancialDraftResult = {
  mode: "active_execution";
  approvalId: number;
  outcome: GuardedFinancialWriterOutcome;
  postSuccess: {
    attempted: boolean;
    actionIds: number[];
    outcome: "succeeded" | "failed" | "not_required" | "not_run";
    message?: string;
  };
};

function gateFailures(gates: FinancialExecutionGateState): string[] {
  const failures: string[] = [];
  if (!gates.environmentLiveWritesEnabled) failures.push("the FINANCIAL_LIVE_WRITES_ENABLED deployment lock is not enabled");
  if (gates.globalShadowMode) failures.push("global financial shadow mode remains enabled");
  if (!gates.familyLiveEnabled) failures.push("the workflow family is not marked live in its cutover control");
  if (!gates.releaseManifestApproved) failures.push("the all-family release manifest is not approved");
  if (!gates.releaseFamilyIncluded) failures.push("the release family is not included in the approved manifest");
  if (!gates.cutoverPackApproved) failures.push("the document-specific cutover pack is not approved");
  if (!gates.legacyWriterHandoffComplete) failures.push("the legacy writer handoff inventory is incomplete");
  if (!gates.currentDocumentPreflightPassed) failures.push("the current source/rules/proposal/Xero preflight does not match the approval");
  return failures;
}

function requireApprovedRecord<T extends { status: string }>(record: T | undefined, label: string): T {
  if (!record) throw new FinancialWriteDisabledError(`${label} is required before a financial Draft can be executed.`);
  if (record.status !== "approved") throw new FinancialWriteDisabledError(`${label} is not approved.`);
  return record;
}

/**
 * Builds the final execution context immediately before a Draft request. This
 * function performs no write. It intentionally reuses the exact source-refresh
 * and Xero GET-only preflight that underpins the immutable approval workbench.
 */
export async function getFinancialExecutionGateState(approvalId: number): Promise<{
  gates: FinancialExecutionGateState;
  approval: Awaited<ReturnType<typeof getFinancialExecutionApproval>>;
}> {
  const approval = await getFinancialExecutionApproval(approvalId);
  if (!approval) throw new TRPCError({ code: "NOT_FOUND", message: "Financial execution approval was not found." });

  const control = await getFinancialCutoverControlForWorkflow(approval.workflowType);
  const manifest = approval.releaseManifestId ? await getFinancialReleaseManifest(approval.releaseManifestId) : undefined;
  const releaseFamily = manifest?.families.find((family) => family.id === approval.releaseFamilyId) ?? null;
  const pack = approval.cutoverPackId ? await getFinancialCutoverPack(approval.cutoverPackId) : undefined;

  const gates: FinancialExecutionGateState = {
    environmentLiveWritesEnabled: isFinancialLiveWriteEnvironmentEnabled(),
    globalShadowMode: isFinancialGlobalShadowModeEnabled(),
    familyLiveEnabled: Boolean(control?.liveEnabled && control.mode === "live_enabled"),
    releaseManifestApproved: manifest?.manifest.status === "approved",
    releaseFamilyIncluded: releaseFamily?.releaseStatus === "included",
    cutoverPackApproved: pack?.state === "approved" && pack.workflowType === approval.workflowType,
    legacyWriterHandoffComplete: Boolean(
      releaseFamily?.legacyWriterIdentifier?.trim()
      && releaseFamily?.legacyWriterOwner?.trim()
      && releaseFamily?.legacyDisableAction?.trim(),
    ),
    // The exact current state is checked again in executeApprovedFinancialDraft.
    currentDocumentPreflightPassed: false,
  };
  return { gates, approval };
}

/**
 * The only coordinator permitted to reach the guarded Xero Draft writer. It
 * consumes a named, short-lived approval and revalidates source/rules/proposal/
 * Xero preflight immediately before it prepares the deterministic payload.
 */
export async function executeApprovedFinancialDraft(input: {
  approvalId: number;
  requestedBy?: number | null;
  expectedWorkflowType?: string;
  expectedSourceRecordId?: string;
}): Promise<ExecuteApprovedFinancialDraftResult> {
  const initial = await getFinancialExecutionGateState(input.approvalId);
  const approval = requireApprovedRecord(initial.approval, "The document-specific financial approval");
  if (input.expectedWorkflowType && approval.workflowType !== input.expectedWorkflowType) {
    throw new FinancialWriteDisabledError("The named approval belongs to a different financial workflow family.");
  }
  if (input.expectedSourceRecordId && approval.sourceRecordId !== input.expectedSourceRecordId) {
    throw new FinancialWriteDisabledError("The named approval belongs to a different VTiger source record.");
  }
  if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
    throw new FinancialWriteDisabledError("The document-specific financial approval has expired. Refresh the proposal and obtain a new approval.");
  }

  // A fresh source refresh plus GET-only preflight must agree with the exact
  // hashes stored in the single-use approval. This does not trust an event body.
  const refreshed = await revalidateApprovedFinancialExecution(approval.id);
  const gates: FinancialExecutionGateState = {
    ...initial.gates,
    currentDocumentPreflightPassed: refreshed.matchesApproval,
  };
  const failures = gateFailures(gates);
  if (failures.length) {
    throw new FinancialWriteDisabledError(`Financial Draft execution is blocked because ${failures.join("; ")}.`);
  }

  const payload = prepareVerifiedFinancialDraftPayload({
    document: refreshed.document,
    workflowIdempotencyKey: refreshed.workflowIdempotencyKey,
    preflight: refreshed.preview.preflight,
  });
  const authorisation: FinancialWriteAuthorisation = {
    workflowType: approval.workflowType,
    approvalReference: approval.approvalReference,
    globalShadowMode: gates.globalShadowMode,
    familyLiveEnabled: gates.familyLiveEnabled,
    releaseManifestApproved: gates.releaseManifestApproved,
    cutoverPackApproved: gates.cutoverPackApproved,
    currentDocumentPreflightPassed: gates.currentDocumentPreflightPassed,
    legacyWriterHandoffComplete: gates.legacyWriterHandoffComplete,
  };

  let outcome: GuardedFinancialWriterOutcome;
  try {
    outcome = await executeGuardedFinancialWriterCommand({
      workflowRunId: approval.workflowRunId,
      documentIntentId: approval.documentIntentId,
      releaseManifestId: approval.releaseManifestId,
      releaseFamilyId: approval.releaseFamilyId,
      cutoverPackId: approval.cutoverPackId,
      workflowType: approval.workflowType,
      proposedAction: approval.proposedAction,
      payload,
      authorisation,
      preparedBy: input.requestedBy ?? approval.approvedBy,
      approvalId: approval.id,
      sourceRecordId: refreshed.sourceRecordId,
      verifiedSourceData: refreshed.sourceData,
      postSuccessPlan: planFinancialPostSuccessActions({
        workflowType: approval.workflowType,
        document: refreshed.document,
        sourceData: refreshed.sourceData,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportWorkflowFailureSafely({
      workflowType: "financial-draft-execution",
      recordKey: `financial-approval:${approval.id}`,
      title: "Financial Xero Draft execution failed",
      errorMessage: message,
      details: { approvalId: approval.id, workflowType: approval.workflowType, documentNumber: approval.proposedDocumentNumber },
      severity: "error",
    });
    throw error;
  }

  if (outcome.outcome !== "succeeded") {
    if (outcome.outcome === "reconciliation_required") {
      reportWorkflowFailureSafely({
        workflowType: "financial-draft-execution",
        recordKey: `financial-writer:${outcome.executionId}`,
        title: "Financial Xero Draft execution requires reconciliation",
        errorMessage: outcome.error,
        details: { approvalId: approval.id, workflowType: approval.workflowType, documentNumber: approval.proposedDocumentNumber },
        severity: "error",
      });
    }
    return {
      mode: "active_execution",
      approvalId: approval.id,
      outcome,
      postSuccess: { attempted: false, actionIds: [], outcome: "not_run" },
    };
  }

  const postSuccessActions = await getFinancialPostSuccessActionsForExecution(outcome.executionId);
  if (postSuccessActions.length === 0) {
    return {
      mode: "active_execution",
      approvalId: approval.id,
      outcome,
      postSuccess: { attempted: false, actionIds: [], outcome: "not_required" },
    };
  }

  const actionIds = postSuccessActions.map((action) => action.id);
  try {
    const results = await Promise.all(postSuccessActions.map((action) => runFinancialPostSuccessAction(action.id)));
    const failed = results.find((result) => result.outcome === "failed");
    return {
      mode: "active_execution",
      approvalId: approval.id,
      outcome,
      postSuccess: {
        attempted: true,
        actionIds,
        outcome: failed ? "failed" : "succeeded",
        message: failed?.message,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportWorkflowFailureSafely({
      workflowType: "financial-post-success-vtiger",
      recordKey: `financial-post-success:${actionIds.join(",")}`,
      title: "Financial post-success VTiger action failed",
      errorMessage: message,
      details: { approvalId: approval.id, executionId: outcome.executionId, workflowType: approval.workflowType, actionIds },
      severity: "error",
    });
    return {
      mode: "active_execution",
      approvalId: approval.id,
      outcome,
      postSuccess: { attempted: true, actionIds, outcome: "failed", message },
    };
  }
}
