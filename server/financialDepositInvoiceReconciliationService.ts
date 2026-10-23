import { randomUUID } from "node:crypto";
import { financialSha256 } from "./financialProposalIntegrity";
import {
  bindDepositInvoiceReconciliationPayload,
  classifyDepositInvoiceReconciliationOrigin,
  completeDepositInvoiceReconciliation,
  depositInvoiceReconciliationOriginalHash,
  getDepositInvoiceReconciliationOriginal,
  holdDepositInvoiceReconciliation,
  prepareDepositInvoiceReconciliationPayload,
  reserveDepositInvoiceReconciliation,
  type DepositInvoiceReconciliationEvidence,
} from "./financialDepositInvoiceReconciliationDb";
import { previewDepositInvoice } from "./financialDepositInvoiceService";
import { assertDepositInvoiceRelease, getDepositInvoiceReleasePolicy } from "./financialDepositInvoiceRelease";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";

export type DepositInvoiceReconciliationPreview = {
  originalEventId: number;
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  proposal: NonNullable<Awaited<ReturnType<typeof previewDepositInvoice>>["preview"]["document"]>;
  payload: ReturnType<typeof prepareDepositInvoiceReconciliationPayload>;
  evidence: DepositInvoiceReconciliationEvidence;
  noWrites: true;
};

/**
 * GET-only recovery preview for a precisely classified immutable Deposit
 * origin. It does not call generic claim APIs and never alters the original
 * event or its unique Deal/-D-number claim. The named 429 origins use exact
 * current reconciliation rather than a blind retry, whether held in preflight
 * or after a definitive no-receipt writer attempt.
 */
export async function previewDepositInvoiceReconciliation(
  originalEventId: number,
): Promise<DepositInvoiceReconciliationPreview> {
  const original = await getDepositInvoiceReconciliationOriginal(originalEventId);
  if (!original) {
    throw new Error("Only the immutable scoped Deposit recovery receipt, the exact D702944 writer 429 receipt, or the exact D702950 preflight-429 receipt may be considered for recovery.");
  }
  const origin = await classifyDepositInvoiceReconciliationOrigin(original, originalEventId);
  const current = await previewDepositInvoice(
    original.dealId,
    origin.dealNumber,
  );
  if (
    current.state !== "previewed" ||
    !current.preview.eligible ||
    !current.preview.document ||
    !current.preflight ||
    !current.xeroPreflightHash ||
    current.facts.dealNumber.toUpperCase() !== origin.dealNumber.toUpperCase() ||
    !current.preview.proposedInvoiceNumber ||
    current.preview.proposedInvoiceNumber.toUpperCase() !== origin.invoiceNumber.toUpperCase() ||
    current.preview.document.proposedDocumentNumber?.toUpperCase() !== origin.invoiceNumber.toUpperCase()
  ) {
    throw new Error("Current scoped Deposit source/Xero Draft is not eligible for exact recovery.");
  }
  const proposal = current.preview.document;
  const payload = prepareDepositInvoiceReconciliationPayload(
    proposal as unknown as Record<string, any>,
    original.id,
    current.sourceSnapshotHash,
  );
  const evidence: DepositInvoiceReconciliationEvidence = {
    originalEventId: original.id,
    dealId: original.dealId,
    dealNumber: current.facts.dealNumber,
    invoiceNumber: proposal.proposedDocumentNumber!,
    originalEventHash: depositInvoiceReconciliationOriginalHash(original),
    sourceSnapshotHash: current.sourceSnapshotHash,
    xeroPreflightHash: current.xeroPreflightHash,
    sourceSnapshot: current.facts,
    proposal,
    xeroPreflight: current.preflight,
  };
  return {
    originalEventId: original.id,
    dealId: original.dealId,
    dealNumber: current.facts.dealNumber,
    invoiceNumber: proposal.proposedDocumentNumber!,
    proposal,
    payload,
    evidence,
    noWrites: true,
  };
}

/**
 * One separately approved Deposit Draft recovery. Deliberately not imported by
 * routes, tRPC, webhook receivers, schedules or browser actions; deployment
 * code must invoke this protected server-only operation explicitly.
 */
export async function applyApprovedDepositInvoiceReconciliation(
  originalEventId: number,
) {
  if (process.env.FINANCIAL_DEPOSIT_INVOICE_RECONCILIATION_ENABLED !== "true") {
    throw new Error("Deposit Invoice reconciliation release is disabled.");
  }
  const policy = await getDepositInvoiceReleasePolicy();
  assertDepositInvoiceRelease(policy);
  const first = await previewDepositInvoiceReconciliation(originalEventId);
  const token = randomUUID();
  const reserved = await reserveDepositInvoiceReconciliation({
    ...first.evidence,
    token,
  });
  if (reserved.state !== "reserved") {
    return { ok: false as const, status: reserved.state, eventId: reserved.event.id };
  }
  await bindDepositInvoiceReconciliationPayload(
    reserved.event.id,
    token,
    policy.releaseKey,
    first.payload,
  );
  try {
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "deposit_invoice_reconciliation",
      proposedAction: "create_draft",
      payload: first.payload,
      expectedDraftDocument: first.proposal,
      preparedBy: policy.approvedBy!,
      // No sourceRecordId/post-success plan: especially no Deposit-to-main deduction.
      authorisation: {
        workflowType: "deposit_invoice_reconciliation",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        depositInvoiceReconciliationEventId: reserved.event.id,
        depositInvoiceReconciliationToken: token,
        depositInvoiceReconciliationReleaseKey: policy.releaseKey,
        depositInvoiceReconciliationApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome !== "succeeded") {
      await holdDepositInvoiceReconciliation(
        reserved.event.id,
        token,
        "Deposit recovery requires reconciliation; its new recovery receipt remains consumed.",
      );
      return {
        ok: false as const,
        status: "reconciliation_required" as const,
        eventId: reserved.event.id,
        outcome,
      };
    }
    await completeDepositInvoiceReconciliation({
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
      status: "drafts_created" as const,
      eventId: reserved.event.id,
      executionId: outcome.executionId,
      documentNumber: outcome.result.documentNumber,
    };
  } catch (error) {
    await holdDepositInvoiceReconciliation(
      reserved.event.id,
      token,
      error instanceof Error ? error.message : "Deposit recovery held.",
    );
    throw error;
  }
}
