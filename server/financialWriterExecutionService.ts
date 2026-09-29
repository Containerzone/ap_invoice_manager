import {
  assertFinancialDraftWriteAuthorised,
  executeFinancialDraftWrite,
  type FinancialDraftPayload,
  type FinancialDraftWriteResult,
  type FinancialWriteAuthorisation,
} from "./financialProductionWriter";
import {
  consumeFinancialExecutionApproval,
  createFinancialPostSuccessAction,
  markFinancialWriterExecutionFailed,
  markFinancialWriterExecutionSubmitted,
  markFinancialWriterExecutionSucceeded,
  prepareFinancialWriterExecution,
} from "./financialWorkflowDb";
import { readBackFinancialDraft } from "./financialReadOnlyXeroService";
import { financialSha256 } from "./financialProposalIntegrity";

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
  /** Optional immutable approval consumed immediately before the Xero transport. */
  approvalId?: number | null;
  sourceRecordId?: string | null;
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

  if (command.approvalId) {
    const consumed = await consumeFinancialExecutionApproval(command.approvalId, prepared.execution.id);
    if (!consumed) {
      throw new Error("The document-specific financial approval is no longer available. Refresh the proposal and obtain a new approval.");
    }
  }

  await markFinancialWriterExecutionSubmitted(prepared.execution.id);
  let transportSucceeded = false;
  try {
    const result = await executeFinancialDraftWrite(command.payload, command.authorisation);
    transportSucceeded = true;
    // The transport response alone never proves final success. Re-read the exact
    // Xero ID/number/status before marking the execution successful locally.
    const readBack = await readBackFinancialDraft({
      documentFamily: command.payload.documentFamily,
      documentNumber: command.payload.documentNumber,
      expectedXeroDocumentId: result.xeroDocumentId,
    });
    await markFinancialWriterExecutionSucceeded(prepared.execution.id, result);
    if (command.sourceRecordId) {
      await createFinancialPostSuccessAction({
        executionId: prepared.execution.id,
        workflowType: command.workflowType,
        actionType: "vtiger_note",
        sourceRecordId: command.sourceRecordId,
        payloadHash: financialSha256({ executionId: prepared.execution.id, readBack }),
        safePayloadSummary: {
          purpose: "Post-success reconciliation note pending a separately configured VTiger writer",
          xeroDocumentId: readBack.xeroDocumentId,
          documentNumber: readBack.documentNumber,
          status: readBack.status,
        },
      });
    }
    return { outcome: "succeeded", executionId: prepared.execution.id, result };
  } catch (error) {
    const uncertain = transportSucceeded || financialWriteOutcomeIsUncertain(error);
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
