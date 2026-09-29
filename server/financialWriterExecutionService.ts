import {
  assertFinancialDraftWriteAuthorised,
  executeFinancialDraftWrite,
  type FinancialDraftPayload,
  type FinancialDraftWriteResult,
  type FinancialWriteAuthorisation,
} from "./financialProductionWriter";
import {
  markFinancialWriterExecutionFailed,
  markFinancialWriterExecutionSubmitted,
  markFinancialWriterExecutionSucceeded,
  prepareFinancialWriterExecution,
} from "./financialWorkflowDb";

export type GuardedFinancialWriterCommand = {
  workflowRunId?: number | null;
  documentIntentId?: number | null;
  releaseManifestId?: number | null;
  releaseFamilyId?: number | null;
  cutoverPackId?: number | null;
  workflowType: string;
  proposedAction: "create_draft" | "update_draft";
  payload: FinancialDraftPayload;
  authorisation: FinancialWriteAuthorisation;
  preparedBy: number;
};

export type GuardedFinancialWriterOutcome =
  | { outcome: "succeeded"; executionId: number; result: FinancialDraftWriteResult }
  | { outcome: "duplicate"; executionId: number; status: string; xeroDocumentId: string | null }
  | { outcome: "reconciliation_required"; executionId: number; error: string };

/** A final 5xx timeout can be ambiguous even after one deterministic retry. */
export function financialWriteOutcomeIsUncertain(error: unknown): boolean {
  const status = (error as any)?.response?.status;
  return [502, 503, 504].includes(status) || /\b(502|503|504)\b/.test(error instanceof Error ? error.message : String(error));
}

/**
 * Coordinates one strictly Draft-only request. It is deliberately not exposed by
 * a router, webhook or Heartbeat handler in this phase. A future approved route
 * must call this method after constructing the exact authorisation context.
 */
export async function executeGuardedFinancialWriterCommand(
  command: GuardedFinancialWriterCommand,
): Promise<GuardedFinancialWriterOutcome> {
  // Reject before writing any local execution state or making any Xero call.
  assertFinancialDraftWriteAuthorised(command.authorisation);

  const prepared = await prepareFinancialWriterExecution({
    workflowRunId: command.workflowRunId,
    documentIntentId: command.documentIntentId,
    releaseManifestId: command.releaseManifestId,
    releaseFamilyId: command.releaseFamilyId,
    cutoverPackId: command.cutoverPackId,
    workflowType: command.workflowType,
    proposedAction: command.proposedAction,
    payload: command.payload,
    approvalReference: command.authorisation.approvalReference,
    preparedBy: command.preparedBy,
  });
  if (prepared.duplicate) {
    return {
      outcome: "duplicate",
      executionId: prepared.execution.id,
      status: prepared.execution.status,
      xeroDocumentId: prepared.execution.xeroDocumentId,
    };
  }

  await markFinancialWriterExecutionSubmitted(prepared.execution.id);
  try {
    const result = await executeFinancialDraftWrite(command.payload, command.authorisation);
    await markFinancialWriterExecutionSucceeded(prepared.execution.id, result);
    return { outcome: "succeeded", executionId: prepared.execution.id, result };
  } catch (error) {
    const uncertain = financialWriteOutcomeIsUncertain(error);
    await markFinancialWriterExecutionFailed(prepared.execution.id, error, uncertain);
    if (uncertain) {
      return {
        outcome: "reconciliation_required",
        executionId: prepared.execution.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}
