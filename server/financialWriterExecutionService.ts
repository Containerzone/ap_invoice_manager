import {
  assertFinancialDraftWriteAuthorised,
  executeFinancialDraftWrite,
  prepareFinancialDraftPayload,
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
  recordVerifiedStorageBillingExecution,
} from "./financialWorkflowDb";
import { readBackFinancialDraft } from "./financialReadOnlyXeroService";
import { financialSha256 } from "./financialProposalIntegrity";
import { verifyInitialStoragePilotWriteAccess } from "./financialInitialStorageDb";
import { verifyStorageAutomaticWriteAccess } from "./financialStorageLifecycleDb";
import { verifyForHireAutomaticWriteAccess } from "./financialForHireDb";
import { verifyAssetPurchaseAutomaticWriteAccess } from "./financialAssetPurchaseDb";
import { verifyCustomerSalePurchaseAutomaticWriteAccess } from "./financialCustomerSalePurchaseDb";
import { verifyMainCustomerInvoiceAutomaticWriteAccess } from "./financialMainCustomerInvoiceDb";
import { verifyMainCustomerInvoiceReconciliationWriteAccess } from "./financialMainCustomerInvoiceReconciliationDb";
import { verifyDepositInvoiceAutomaticWriteAccess } from "./financialDepositInvoiceDb";
import { verifyDepositInvoiceReconciliationWriteAccess } from "./financialDepositInvoiceReconciliationDb";
import { verifyDepositMainDeductionWriteAccess } from "./financialDepositMainDeductionDb";
import { verifyD702946DepositMainDeductionRecoveryWriteAccess } from "./financialD702946DepositMainDeductionRecoveryDb";
import { verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess } from "./financialD702946AuthorisedDepositMainDeductionRecoveryDb";
import { verifyD702959AuthorisedDepositMainDeductionRecoveryWriteAccess } from "./financialD702959AuthorisedDepositMainDeductionRecoveryDb";
import { verifyFinalWeightAutomaticWriteAccess } from "./financialFinalWeightAdjustmentDb";
import { verifyFinalWeightReconciliationWriteAccess } from "./financialFinalWeightReconciliationDb";
import { verifyFinalWeightReconciliationRemediationWriteAccess } from "./financialFinalWeightReconciliationRemediationDb";
import type { PlannedFinancialPostSuccessAction } from "./financialPostSuccessPlan";
import { verifyExtraHireAutomaticWriteAccess } from "./financialExtraHireInvoiceDb";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";

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
  /** Current source snapshot captured by approved revalidation; never supplied by a browser. */
  verifiedSourceData?: Record<string, unknown>;
  postSuccessPlan?: PlannedFinancialPostSuccessAction[];
  expectedDraftDocument?: ProposedFinancialDocument;
  expectedFinalWeightDraft?: Record<string, any>;
  expectedExactDraft?: Record<string, any>;
};

export type GuardedFinancialWriterOutcome =
  | { outcome: "succeeded"; executionId: number; result: FinancialDraftWriteResult; recoveryReadbackEvidence?: unknown }
  | { outcome: "duplicate"; executionId: number; status: string; xeroDocumentId: string | null }
  | { outcome: "reconciliation_required"; executionId: number; error: string };

/** A final 5xx timeout can be ambiguous even after one deterministic retry. */
export function financialWriteOutcomeIsUncertain(error: unknown): boolean {
  const status = (error as any)?.response?.status;
  return [502, 503, 504].includes(status) || /\b(502|503|504)\b/.test(error instanceof Error ? error.message : String(error));
}

/**
 * Coordinates one strictly Draft-only request. It is reached only by the
 * canonical authenticated event handler after document-specific revalidation;
 * it is deliberately never exported through tRPC or a browser action.
 */
export async function executeGuardedFinancialWriterCommand(
  command: GuardedFinancialWriterCommand,
): Promise<GuardedFinancialWriterOutcome> {
  // Reject before writing any local execution state or making any Xero call.
  assertFinancialDraftWriteAuthorised(command.authorisation, { requireExecutionId: false });
  if (command.workflowType === "extra_hire" || command.authorisation.extraHireAutomaticEventId !== undefined) {
    if (command.workflowType !== "extra_hire" || command.proposedAction !== "create_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.extraHireApprovedBy || !command.expectedDraftDocument || command.expectedDraftDocument.sourceWorkflow !== "extra_hire" ||
      command.expectedDraftDocument.documentType !== "extra_hire" || command.expectedFinalWeightDraft) throw new Error("Extra Hire execution permits only its isolated Draft with exact readback; CRM post-success queue/write remains separately held, regardless of global/storage flags.");
    const expectedPayload = prepareFinancialDraftPayload(command.expectedDraftDocument, "extra-hire-readback-binding");
    (expectedPayload.body.Invoices as any[])[0].CurrencyCode = "AUD";
    if (financialSha256(expectedPayload.body) !== financialSha256(command.payload.body)) throw new Error("Extra Hire exact readback proposal must match the immutable authorized POST body.");
    await verifyExtraHireAutomaticWriteAccess({ eventId: command.authorisation.extraHireAutomaticEventId!, releaseKey: command.authorisation.extraHireReleaseKey!, payload: command.payload, preparedBy: command.preparedBy });
  }
  if (/^INV-\d+-EH/i.test(command.payload.documentNumber) && command.authorisation.extraHireAutomaticEventId === undefined) throw new Error("Extra Hire EH series cannot be executed by a generic or other-family command.");
  if (command.authorisation.finalWeightAutomaticEventId !== undefined) {
    if (command.workflowType !== "final_weight_adjustment" || command.proposedAction !== "update_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.finalWeightApprovedBy || !command.expectedFinalWeightDraft || command.expectedDraftDocument ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedFinalWeightDraft])) throw new Error("Final-weight execution permits only its exact existing Draft amendment, retained readback evidence and no CRM action.");
    await verifyFinalWeightAutomaticWriteAccess({ eventId: command.authorisation.finalWeightAutomaticEventId, direction: command.authorisation.finalWeightDirection!,
      releaseKey: command.authorisation.finalWeightReleaseKey!, payload: command.payload, preparedBy: command.preparedBy });
  } else if (command.authorisation.finalWeightReconciliationRemediationEventId !== undefined) {
    if (command.workflowType !== "final_weight_reconciliation_remediation" || command.proposedAction !== "update_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.finalWeightReconciliationRemediationApprovedBy || !command.expectedFinalWeightDraft || command.expectedDraftDocument ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedFinalWeightDraft])) {
      throw new Error("Final-weight verifier-defect remediation permits only its exact existing Draft POST recovery and no CRM action.");
    }
    await verifyFinalWeightReconciliationRemediationWriteAccess({ eventId: command.authorisation.finalWeightReconciliationRemediationEventId,
      token: command.authorisation.finalWeightReconciliationRemediationToken!, releaseKey: command.authorisation.finalWeightReconciliationRemediationReleaseKey!,
      payload: command.payload, preparedBy: command.preparedBy });
  } else if (command.authorisation.finalWeightReconciliationEventId !== undefined) {
    if (command.workflowType !== "final_weight_reconciliation" || command.proposedAction !== "update_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.finalWeightReconciliationApprovedBy || !command.expectedFinalWeightDraft || command.expectedDraftDocument ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedFinalWeightDraft])) {
      throw new Error("Final-weight reconciliation permits only its exact existing Draft POST recovery and no CRM action.");
    }
    await verifyFinalWeightReconciliationWriteAccess({ eventId: command.authorisation.finalWeightReconciliationEventId,
      token: command.authorisation.finalWeightReconciliationToken!, releaseKey: command.authorisation.finalWeightReconciliationReleaseKey!,
      payload: command.payload, preparedBy: command.preparedBy });
  } else if (command.expectedFinalWeightDraft) throw new Error("Final-weight readback evidence requires its independent amendment release.");
  if (command.authorisation.depositInvoiceReconciliationEventId !== undefined) {
    if (command.workflowType !== "deposit_invoice_reconciliation" || command.proposedAction !== "create_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.depositInvoiceReconciliationApprovedBy || !command.expectedDraftDocument ||
      command.expectedDraftDocument.sourceWorkflow !== "deposit_invoice" || command.expectedFinalWeightDraft || command.expectedExactDraft) {
      throw new Error("Deposit reconciliation permits only its exact current Draft POST recovery and no CRM or Deposit-to-main action.");
    }
    const expectedPayload = prepareFinancialDraftPayload(command.expectedDraftDocument, "deposit-reconciliation-readback-binding");
    (expectedPayload.body.Invoices as any[])[0].CurrencyCode = "AUD";
    if (financialSha256(expectedPayload.body) !== financialSha256(command.payload.body)) {
      throw new Error("Deposit reconciliation exact readback proposal must match the immutable authorized POST body.");
    }
    await verifyDepositInvoiceReconciliationWriteAccess({
      eventId: command.authorisation.depositInvoiceReconciliationEventId,
      token: command.authorisation.depositInvoiceReconciliationToken!,
      releaseKey: command.authorisation.depositInvoiceReconciliationReleaseKey!,
      payload: command.payload,
      preparedBy: command.preparedBy,
    });
  }
  if (command.authorisation.mainInvoiceReconciliationEventId !== undefined) {
    if (command.workflowType !== "main_invoice_reconciliation" || command.proposedAction !== "create_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.mainInvoiceReconciliationApprovedBy || !command.expectedDraftDocument ||
      command.expectedDraftDocument.sourceWorkflow !== "main_customer_invoice" || command.expectedDraftDocument.documentType !== "main_customer_invoice" ||
      command.expectedFinalWeightDraft || command.expectedExactDraft) {
      throw new Error("Main Customer Invoice reconciliation permits only its exact current Draft POST recovery and no CRM/post-success action.");
    }
    const expectedPayload = prepareFinancialDraftPayload(command.expectedDraftDocument, "main-invoice-reconciliation-readback-binding");
    (expectedPayload.body.Invoices as any[])[0].CurrencyCode = "AUD";
    if (financialSha256(expectedPayload.body) !== financialSha256(command.payload.body)) {
      throw new Error("Main Customer Invoice reconciliation exact readback proposal must match the immutable authorised POST body.");
    }
    await verifyMainCustomerInvoiceReconciliationWriteAccess({
      eventId: command.authorisation.mainInvoiceReconciliationEventId,
      token: command.authorisation.mainInvoiceReconciliationToken!,
      releaseKey: command.authorisation.mainInvoiceReconciliationReleaseKey!,
      payload: command.payload,
      preparedBy: command.preparedBy,
    });
  }
  if (command.authorisation.depositDraftCorrectionKind !== undefined) {
    if (command.workflowType !== "deposit_draft_correction" || command.proposedAction !== "update_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.depositDraftCorrectionApprovedBy || !command.expectedExactDraft || command.expectedDraftDocument || command.expectedFinalWeightDraft ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedExactDraft])) {
      throw new Error("Deposit correction permits only its exact immutable Draft amendment and no CRM post-success action.");
    }
  } else if (command.expectedExactDraft && command.authorisation.depositMainDeductionAutomaticEventId === undefined && command.authorisation.d702946DepositMainDeductionRecoveryEventId === undefined && command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryEventId === undefined && command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryEventId === undefined) throw new Error("Exact Draft correction evidence requires its independent Deposit correction approval.");
  if (command.authorisation.depositMainDeductionAutomaticEventId !== undefined) {
    if (command.workflowType !== "deposit_main_deduction" || command.proposedAction !== "update_draft" || command.postSuccessPlan?.length || command.sourceRecordId ||
      command.preparedBy !== command.authorisation.depositMainDeductionApprovedBy || !command.expectedExactDraft || command.expectedDraftDocument || command.expectedFinalWeightDraft ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedExactDraft])) {
      throw new Error("Deposit-to-main execution permits only its exact immutable current Draft amendment and no CRM post-success action.");
    }
    await verifyDepositMainDeductionWriteAccess({ eventId: command.authorisation.depositMainDeductionAutomaticEventId, token: command.authorisation.depositMainDeductionToken!, releaseKey: command.authorisation.depositMainDeductionReleaseKey!, payload: command.payload, preparedBy: command.preparedBy });
  }
  if (command.authorisation.d702946DepositMainDeductionRecoveryEventId !== undefined) {
    if (command.workflowType !== "d702946_deposit_main_deduction_recovery" || command.proposedAction !== "update_draft" ||
      command.postSuccessPlan?.length || command.sourceRecordId || command.verifiedSourceData || command.approvalId ||
      command.workflowRunId || command.documentIntentId || command.releaseManifestId || command.releaseFamilyId || command.cutoverPackId ||
      command.preparedBy !== command.authorisation.d702946DepositMainDeductionRecoveryApprovedBy || !command.expectedExactDraft ||
      command.expectedDraftDocument || command.expectedFinalWeightDraft ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedExactDraft]))
      throw new Error("D702946 recovery permits only its isolated exact existing Draft amendment/readback; no generic approval, CRM or post-success actions.");
    await verifyD702946DepositMainDeductionRecoveryWriteAccess({ eventId: command.authorisation.d702946DepositMainDeductionRecoveryEventId,
      token: command.authorisation.d702946DepositMainDeductionRecoveryToken!, releaseKey: command.authorisation.d702946DepositMainDeductionRecoveryReleaseKey!,
      preparedBy: command.preparedBy, payload: command.payload });
  }
  if (command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryEventId !== undefined) {
    if (command.workflowType !== "d702946_authorised_deposit_main_deduction_recovery" || command.proposedAction !== "update_draft" ||
      command.postSuccessPlan?.length || command.sourceRecordId || command.verifiedSourceData || command.approvalId ||
      command.workflowRunId || command.documentIntentId || command.releaseManifestId || command.releaseFamilyId || command.cutoverPackId ||
      command.preparedBy !== command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryApprovedBy || !command.expectedExactDraft ||
      command.expectedDraftDocument || command.expectedFinalWeightDraft ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedExactDraft]))
      throw new Error("D702946 Authorised-Deposit recovery permits only its isolated exact Main Draft amendment/readback; the Deposit remains evidence only with no CRM or post-success actions.");
    await verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess({ eventId: command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryEventId,
      token: command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryToken!, releaseKey: command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryReleaseKey!,
      preparedBy: command.preparedBy, payload: command.payload });
  }
  if (command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryEventId !== undefined) {
    if (command.workflowType !== "d702959_authorised_deposit_main_deduction_recovery" || command.proposedAction !== "update_draft" ||
      command.postSuccessPlan?.length || command.sourceRecordId || command.verifiedSourceData || command.approvalId ||
      command.workflowRunId || command.documentIntentId || command.releaseManifestId || command.releaseFamilyId || command.cutoverPackId ||
      command.preparedBy !== command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryApprovedBy || !command.expectedExactDraft ||
      command.expectedDraftDocument || command.expectedFinalWeightDraft ||
      financialSha256(command.payload.body.Invoices) !== financialSha256([command.expectedExactDraft])) {
      throw new Error("D702959 Authorised-Deposit recovery permits only its isolated exact Main Draft append/readback; the Authorised Deposit remains evidence only with no CRM or post-success actions.");
    }
    await verifyD702959AuthorisedDepositMainDeductionRecoveryWriteAccess({ eventId: command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryEventId,
      token: command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryToken!, releaseKey: command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryReleaseKey!,
      preparedBy: command.preparedBy, payload: command.payload });
  }
  if ((command.workflowType === "deposit_invoice" || /^INV-\d+-D$/i.test(command.payload.documentNumber)) && command.authorisation.depositInvoiceAutomaticEventId === undefined && command.authorisation.depositInvoiceReconciliationEventId === undefined && command.authorisation.depositDraftCorrectionKind === undefined) {
    throw new Error("Deposit commands and exact -D documents require the independent Deposit event, not a generic or other-family approval.");
  }
  if (command.authorisation.depositInvoiceAutomaticEventId !== undefined) {
    if (command.workflowType !== "deposit_invoice" || command.proposedAction !== "create_draft" || command.postSuccessPlan?.length ||
      command.preparedBy !== command.authorisation.depositInvoiceApprovedBy || !command.expectedDraftDocument || command.expectedDraftDocument.sourceWorkflow !== "deposit_invoice") {
      throw new Error("Deposit execution cannot amend a main invoice, execute another family, or queue CRM post-success changes.");
    }
    await verifyDepositInvoiceAutomaticWriteAccess({ eventId: command.authorisation.depositInvoiceAutomaticEventId,
      releaseKey: command.authorisation.depositInvoiceReleaseKey!, payload: command.payload, preparedBy: command.preparedBy });
  }
  if (command.authorisation.mainCustomerInvoiceAutomaticEventId !== undefined) {
    await verifyMainCustomerInvoiceAutomaticWriteAccess({
      eventId: command.authorisation.mainCustomerInvoiceAutomaticEventId,
      releaseKey: command.authorisation.mainCustomerInvoiceReleaseKey!,
      token: command.authorisation.mainCustomerInvoiceToken!,
      payload: command.payload,
      preparedBy: command.preparedBy,
    });
  }
  if (command.authorisation.assetPurchaseAutomaticEventId !== undefined) {
    await verifyAssetPurchaseAutomaticWriteAccess({
      eventId: command.authorisation.assetPurchaseAutomaticEventId,
      releaseKey: command.authorisation.assetPurchaseReleaseKey!,
      payload: command.payload,
      preparedBy: command.preparedBy,
    });
  }
  if (command.authorisation.customerSalePurchaseAutomaticEventId !== undefined) {
    await verifyCustomerSalePurchaseAutomaticWriteAccess({
      eventId: command.authorisation.customerSalePurchaseAutomaticEventId,
      releaseKey: command.authorisation.customerSalePurchaseReleaseKey!,
      payload: command.payload,
      preparedBy: command.preparedBy,
    });
  }
  if (command.authorisation.storageAutomaticEventId !== undefined) {
    await verifyStorageAutomaticWriteAccess({ eventId: command.authorisation.storageAutomaticEventId,
      releaseKey: command.authorisation.storageReleaseKey!, payload: command.payload, workflowType: command.workflowType, preparedBy: command.preparedBy });
  }
  if (command.authorisation.forHireAutomaticEventId !== undefined) {
    await verifyForHireAutomaticWriteAccess({
      eventId: command.authorisation.forHireAutomaticEventId,
      releaseKey: command.authorisation.forHireReleaseKey!,
      payload: command.payload,
      workflowType: command.workflowType as "initial_for_hire" | "recurring_for_hire",
      preparedBy: command.preparedBy,
    });
  }
  if (command.authorisation.storagePilotEventId !== undefined) {
    if (command.workflowType !== "storage_activation" || command.proposedAction !== "create_draft") {
      throw new Error("Storage pilot cannot execute an unrelated family or update action.");
    }
    await verifyInitialStoragePilotWriteAccess({
      eventId: command.authorisation.storagePilotEventId,
      approvalReference: command.authorisation.approvalReference!,
      documentNumber: command.payload.documentNumber,
      preparedBy: command.preparedBy,
    });
  }

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
    const result = await executeFinancialDraftWrite(command.payload, {
      ...command.authorisation,
      executionId: prepared.execution.id,
    });
    transportSucceeded = true;
    // The transport response alone never proves final success. Re-read the exact
    // Xero ID/number/status before marking the execution successful locally.
    const recoveryReadbackEvidence = command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryEventId !== undefined
      ? await (await import("./financialD702959AuthorisedDepositMainDeductionRecoveryService")).readD702959AuthorisedDepositMainDeductionRecoveryReadback(
        command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryEventId, prepared.execution.id)
      : command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryEventId !== undefined
      ? await (await import("./financialD702946AuthorisedDepositMainDeductionRecoveryService")).readD702946AuthorisedDepositMainDeductionRecoveryReadback(
        command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryEventId, prepared.execution.id)
      : command.authorisation.d702946DepositMainDeductionRecoveryEventId !== undefined
        ? await (await import("./financialD702946DepositMainDeductionRecoveryService")).readD702946DepositMainDeductionRecoveryReadback(
          command.authorisation.d702946DepositMainDeductionRecoveryEventId, prepared.execution.id)
        : undefined;
    const readBack = recoveryReadbackEvidence ? undefined : await readBackFinancialDraft({
      documentFamily: command.payload.documentFamily,
      documentNumber: command.payload.documentNumber,
      expectedXeroDocumentId: result.xeroDocumentId,
      expectedDocument: command.expectedDraftDocument,
      expectedFinalWeightDraft: command.expectedFinalWeightDraft,
      expectedExactDraft: command.expectedExactDraft,
    });
    await markFinancialWriterExecutionSucceeded(prepared.execution.id, result);
    if (command.sourceRecordId && command.verifiedSourceData) {
      // The storage ledger is updated only after exact Xero Draft read-back has
      // succeeded. Shadow evaluation and selector previews never reach here.
      try {
        await recordVerifiedStorageBillingExecution({
          workflowType: command.workflowType,
          executionId: prepared.execution.id,
          sourceRecordId: command.sourceRecordId,
          sourceData: command.verifiedSourceData,
        });
      } catch {
        // Exact Xero Draft success is already durable. A local ledger failure
        // must not misclassify it as a failed transport or trigger a re-write.
      }
    }
    if (command.sourceRecordId && readBack) {
      for (const action of command.postSuccessPlan ?? []) {
        if ((command.workflowType === "extra_hire" || action.actionType === "vtiger_hire_end_update") && process.env.FINANCIAL_EXTRA_HIRE_POST_SUCCESS_ENABLED !== "true") continue;
        await createFinancialPostSuccessAction({
          executionId: prepared.execution.id,
          workflowType: command.workflowType,
          actionType: action.actionType,
          sourceRecordId: command.sourceRecordId,
          payloadHash: financialSha256({
            executionId: prepared.execution.id,
            actionType: action.actionType,
            readBack,
            action: action.safePayloadSummary,
          }),
          safePayloadSummary: {
            ...action.safePayloadSummary,
            xeroDocumentId: readBack.xeroDocumentId,
            documentNumber: readBack.documentNumber,
            status: readBack.status,
          },
        });
      }
    }
    return { outcome: "succeeded", executionId: prepared.execution.id, result, ...(recoveryReadbackEvidence ? { recoveryReadbackEvidence } : {}) };
  } catch (error) {
    const uncertain = command.authorisation.d702946DepositMainDeductionRecoveryEventId !== undefined || command.authorisation.d702946AuthorisedDepositMainDeductionRecoveryEventId !== undefined || command.authorisation.d702959AuthorisedDepositMainDeductionRecoveryEventId !== undefined || transportSucceeded || financialWriteOutcomeIsUncertain(error);
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
