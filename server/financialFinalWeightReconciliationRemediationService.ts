import { randomUUID } from "node:crypto";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { getFinalWeightEvent } from "./financialFinalWeightAdjustmentDb";
import { previewFinalWeightReconciliation, type FinalWeightReconciliationPreview } from "./financialFinalWeightReconciliationService";
import { finalWeightReconciliationOrigin } from "./financialFinalWeightReconciliationOrigin";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import {
  bindFinalWeightReconciliationRemediationPayload,
  completeFinalWeightReconciliationRemediation,
  getFinalWeightReconciliationRemediationEvent,
  holdFinalWeightReconciliationRemediation,
  isEligibleFinalWeightReconciliationVerifierDefectReceipt,
  reserveFinalWeightReconciliationRemediation,
} from "./financialFinalWeightReconciliationRemediationDb";
import { getFinalWeightReconciliationEvent } from "./financialFinalWeightReconciliationDb";

export type FinalWeightReconciliationRemediationPreview = FinalWeightReconciliationPreview & {
  priorReconciliationReceiptId: number;
  priorReceiptStatus: "reconciliation_required";
  noWrites: true;
};

/**
 * GET-only assessment for the one historical local verifier defect. It neither
 * alters the original adjustment nor reopens the held reconciliation receipt.
 */
export async function previewFinalWeightReconciliationVerifierDefectRemediation(
  priorReconciliationReceiptId: number,
): Promise<FinalWeightReconciliationRemediationPreview> {
  const prior = await getFinalWeightReconciliationEvent(priorReconciliationReceiptId);
  if (!isEligibleFinalWeightReconciliationVerifierDefectReceipt(prior)) {
    throw new Error("Only the exact unsubmitted Final Weight reconciliation verifier-defect receipt may be remediated.");
  }
  const original = await getFinalWeightEvent(prior.originalEventId);
  if (!original || finalWeightReconciliationOrigin(original) !== "xero_drift" ||
    original.id !== prior.originalEventId || original.invoiceNumber !== prior.invoiceNumber ||
    original.xeroInvoiceId !== prior.xeroInvoiceId || original.direction !== prior.direction ||
    original.dealId !== prior.dealId) {
    throw new Error("Final Weight remediation requires the matching immutable no-execution Xero-drift original event and invoice.");
  }
  // This invokes the established GET-only current source/Xero preview. It makes
  // the invoice ID/number equality check before an attempt can be reserved.
  const fresh = await previewFinalWeightReconciliation(original.id);
  if (fresh.invoiceNumber !== prior.invoiceNumber || fresh.xeroInvoiceId !== prior.xeroInvoiceId ||
    fresh.direction !== prior.direction || fresh.dealId !== prior.dealId) {
    throw new Error("Final Weight remediation current preview no longer targets the exact immutable invoice.");
  }
  return { ...fresh, priorReconciliationReceiptId: prior.id, priorReceiptStatus: "reconciliation_required", noWrites: true };
}

/**
 * Reserved for a future explicit trusted caller only. There is intentionally no
 * router, webhook, browser action, schedule, polling loop or automatic retry
 * that invokes this function. Caller approval must match the live policy key;
 * the service then creates one new remediation receipt and permits one exact
 * resource POST/readback through the guarded writer.
 */
export async function applyCallerApprovedFinalWeightReconciliationVerifierDefectRemediation(
  priorReconciliationReceiptId: number,
  callerApprovalReference: string,
) {
  if (process.env.FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED !== "true") {
    throw new Error("Final Weight reconciliation remediation release is disabled.");
  }
  const policy = await getFinalWeightReleasePolicy();
  if (callerApprovalReference !== policy.releaseKey) {
    throw new Error("Final Weight remediation requires an explicit caller approval matching the current release policy.");
  }
  const first = await previewFinalWeightReconciliationVerifierDefectRemediation(priorReconciliationReceiptId);
  assertFinalWeightRelease(policy, first.direction);
  const prior = await getFinalWeightReconciliationEvent(priorReconciliationReceiptId);
  // Repeat the strict local condition after the fresh preview, before writing an
  // audit row, so a concurrent submit/execution cannot become a remediation.
  if (!isEligibleFinalWeightReconciliationVerifierDefectReceipt(prior)) {
    throw new Error("Final Weight remediation receipt changed or was submitted; no new attempt is allowed.");
  }
  const token = randomUUID();
  const reserved = await reserveFinalWeightReconciliationRemediation({ priorReceipt: prior, evidence: first.evidence, token });
  if (reserved.state !== "reserved") return { ok: false as const, status: reserved.state, eventId: reserved.event.id };
  await bindFinalWeightReconciliationRemediationPayload(reserved.event.id, token, policy.releaseKey, first.payload);
  try {
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "final_weight_reconciliation_remediation",
      proposedAction: "update_draft",
      payload: first.payload,
      preparedBy: policy.approvedBy!,
      expectedFinalWeightDraft: first.expectedDraft,
      authorisation: {
        workflowType: "final_weight_reconciliation_remediation",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        finalWeightReconciliationRemediationEventId: reserved.event.id,
        finalWeightReconciliationRemediationToken: token,
        finalWeightReconciliationRemediationReleaseKey: policy.releaseKey,
        finalWeightReconciliationRemediationApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome !== "succeeded") {
      await holdFinalWeightReconciliationRemediation(
        reserved.event.id,
        token,
        "Final Weight verifier-defect remediation requires reconciliation; its new remediation receipt remains consumed.",
      );
      return { ok: false as const, status: "reconciliation_required" as const, eventId: reserved.event.id, outcome };
    }
    await completeFinalWeightReconciliationRemediation({
      eventId: reserved.event.id,
      token,
      executionId: outcome.executionId,
      readbackEvidence: {
        documentNumber: outcome.result.documentNumber,
        xeroDocumentId: outcome.result.xeroDocumentId,
        status: outcome.result.status,
      },
    });
    return {
      ok: true as const,
      status: "draft_updated" as const,
      eventId: reserved.event.id,
      executionId: outcome.executionId,
      documentNumber: outcome.result.documentNumber,
    };
  } catch (error) {
    await holdFinalWeightReconciliationRemediation(
      reserved.event.id,
      token,
      error instanceof Error ? error.message : "Final Weight verifier-defect remediation held.",
    );
    throw error;
  }
}

/** Read-only access to the distinct remediation history; no generic reopening API exists. */
export { getFinalWeightReconciliationRemediationEvent };
