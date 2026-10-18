import { randomUUID } from "node:crypto";
import { financialSha256 } from "./financialProposalIntegrity";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { previewFinalWeightAdjustment } from "./financialFinalWeightAdjustmentService";
import {
  bindFinalWeightReconciliationPayload,
  completeFinalWeightReconciliation,
  holdFinalWeightReconciliation,
  reserveFinalWeightReconciliation,
  type FinalWeightReconciliationEvidence,
} from "./financialFinalWeightReconciliationDb";
import { getFinalWeightEvent } from "./financialFinalWeightAdjustmentDb";
import { FINAL_WEIGHT_RULES_VERSION, prepareFinalWeightPayload, type FinalWeightDirection } from "./financialFinalWeightAdjustmentRules";
import { finalWeightReconciliationOrigin, finalWeightReconciliationOriginalHash } from "./financialFinalWeightReconciliationOrigin";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";

export type FinalWeightReconciliationPreview = {
  originalEventId: number;
  direction: FinalWeightDirection;
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  xeroInvoiceId: string;
  expectedDraft: Record<string, unknown>;
  payload: ReturnType<typeof prepareFinalWeightPayload>;
  evidence: FinalWeightReconciliationEvidence;
  noWrites: true;
};

/**
 * GET-only reconciliation preview for either the immutable legacy 404 that
 * reached Xero using the superseded method, or a no-transport exact Xero-drift
 * hold. It never changes the immutable original claim or Draft.
 */
export async function previewFinalWeightReconciliation(originalEventId: number): Promise<FinalWeightReconciliationPreview> {
  const original = await getFinalWeightEvent(originalEventId);
  if (!original || !finalWeightReconciliationOrigin(original)) {
    throw new Error("Only an immutable Final Weight 404 or exact Xero-drift reconciliation record may be considered for recovery.");
  }
  const result = await previewFinalWeightAdjustment(original.dealId, original.direction);
  if (result.state !== "previewed" || !result.preview.eligible || !result.preview.invoiceId || !result.preview.invoiceNumber || !result.preview.originalDraft || !result.preview.expectedDraft || !result.xero || !result.xeroPreflightHash ||
    result.preview.invoiceId !== original.xeroInvoiceId || result.preview.invoiceNumber !== original.invoiceNumber) {
    throw new Error("Current Final Weight source/Xero Draft is not eligible for exact recovery.");
  }
  const payload = prepareFinalWeightPayload(result.preview, result.sourceSnapshotHash);
  const evidence: FinalWeightReconciliationEvidence = {
    originalEventId: original.id,
    direction: original.direction,
    dealId: original.dealId,
    dealNumber: result.facts.dealNumber,
    invoiceNumber: result.preview.invoiceNumber,
    xeroInvoiceId: result.preview.invoiceId,
    originalEventHash: finalWeightReconciliationOriginalHash(original),
    sourceSnapshotHash: result.sourceSnapshotHash,
    xeroPreflightHash: result.xeroPreflightHash,
    sourceSnapshot: { ...result.facts, direction: original.direction, rulesVersion: FINAL_WEIGHT_RULES_VERSION },
    xeroPreflight: result.xero,
    originalDraft: result.preview.originalDraft,
    expectedDraft: result.preview.expectedDraft,
    originalDraftHash: financialSha256(result.preview.originalDraft),
    expectedDraftHash: financialSha256(result.preview.expectedDraft),
  };
  return { originalEventId: original.id, direction: original.direction, dealId: original.dealId, dealNumber: result.facts.dealNumber,
    invoiceNumber: result.preview.invoiceNumber, xeroInvoiceId: result.preview.invoiceId, expectedDraft: result.preview.expectedDraft, payload, evidence, noWrites: true };
}

/** One separately approved Draft-only recovery, never callable from a webhook or browser. */
export async function applyApprovedFinalWeightReconciliation(originalEventId: number) {
  if (process.env.FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED !== "true") throw new Error("Final Weight reconciliation release is disabled.");
  const policy = await getFinalWeightReleasePolicy();
  const first = await previewFinalWeightReconciliation(originalEventId);
  assertFinalWeightRelease(policy, first.direction);
  const token = randomUUID();
  const reserved = await reserveFinalWeightReconciliation({ ...first.evidence, token });
  if (reserved.state !== "reserved") return { ok: false as const, status: reserved.state, eventId: reserved.event.id };
  await bindFinalWeightReconciliationPayload(reserved.event.id, token, policy.releaseKey, first.payload);
  try {
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "final_weight_reconciliation",
      proposedAction: "update_draft",
      payload: first.payload,
      preparedBy: policy.approvedBy!,
      expectedFinalWeightDraft: first.expectedDraft,
      authorisation: {
        workflowType: "final_weight_reconciliation", approvalReference: policy.releaseKey, globalShadowMode: false,
        familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true, finalWeightReconciliationEventId: reserved.event.id, finalWeightReconciliationToken: token,
        finalWeightReconciliationReleaseKey: policy.releaseKey, finalWeightReconciliationApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome !== "succeeded") {
      await holdFinalWeightReconciliation(reserved.event.id, token, "Final Weight 404 recovery requires reconciliation; its new recovery receipt remains consumed.");
      return { ok: false as const, status: "reconciliation_required" as const, eventId: reserved.event.id, outcome };
    }
    await completeFinalWeightReconciliation({ eventId: reserved.event.id, token, executionId: outcome.executionId, readbackEvidence: { documentNumber: outcome.result.documentNumber, xeroDocumentId: outcome.result.xeroDocumentId, status: outcome.result.status } });
    return { ok: true as const, status: "draft_updated" as const, eventId: reserved.event.id, executionId: outcome.executionId, documentNumber: outcome.result.documentNumber };
  } catch (error) {
    await holdFinalWeightReconciliation(reserved.event.id, token, error instanceof Error ? error.message : "Final Weight 404 recovery held.");
    throw error;
  }
}
