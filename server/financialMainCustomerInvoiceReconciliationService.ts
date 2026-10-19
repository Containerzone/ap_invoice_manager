import { randomUUID } from "node:crypto";
import { financialSha256 } from "./financialProposalIntegrity";
import {
  classifyMainCustomerInvoiceReconciliationOrigin,
  completeMainCustomerInvoiceReconciliation,
  getMainCustomerInvoiceReconciliationOriginal,
  getMainCustomerInvoiceReconciliationWriterEvidence,
  holdMainCustomerInvoiceReconciliation,
  mainCustomerInvoiceReconciliationOriginalHash,
  mainCustomerInvoiceReconciliationWriterEvidenceHash,
  prepareMainCustomerInvoiceReconciliationPayload,
  reserveMainCustomerInvoiceReconciliation,
  bindMainCustomerInvoiceReconciliationPayload,
  type MainCustomerInvoiceReconciliationEvidence,
} from "./financialMainCustomerInvoiceReconciliationDb";
import { previewMainCustomerInvoice } from "./financialMainCustomerInvoiceService";
import {
  assertMainCustomerInvoiceReconciliationRelease,
  getMainCustomerInvoiceReleasePolicy,
} from "./financialMainCustomerInvoiceRelease";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";

export type MainCustomerInvoiceReconciliationPreview = {
  originalEventId: number;
  failedWriterExecutionId: number;
  dealId: string;
  dealNumber: string;
  invoiceNumber: string;
  proposal: NonNullable<
    Awaited<
      ReturnType<typeof previewMainCustomerInvoice>
    >["preview"]["document"]
  >;
  payload: ReturnType<typeof prepareMainCustomerInvoiceReconciliationPayload>;
  evidence: MainCustomerInvoiceReconciliationEvidence;
  noWrites: true;
};

function sameMoney(left: unknown, right: number): boolean {
  return (
    typeof left === "number" &&
    Number.isFinite(left) &&
    Math.abs(left - right) < 0.001
  );
}

/** Every non-itemless source line needs a fresh matching sale item/account check. */
function currentMainInvoiceItemsAreExact(
  document: Record<string, any>,
  preflight: Record<string, any>
): boolean {
  const lines = document.lineItems;
  const checks = new Map(
    (Array.isArray(preflight.itemChecks) ? preflight.itemChecks : []).map(
      (item: any) => [
        String(item?.itemCode ?? "")
          .trim()
          .toUpperCase(),
        item,
      ]
    )
  );
  return (
    Array.isArray(lines) &&
    lines.length > 0 &&
    lines.every((line: any) => {
      const itemCode = String(line?.itemCode ?? "").trim();
      if (!itemCode) return line?.accountCode === "200";
      const item = checks.get(itemCode.toUpperCase());
      return (
        item?.found === true &&
        item?.isSold === true &&
        item?.salesTaxType === "OUTPUT" &&
        String(item?.salesAccountCode ?? "") === String(line?.accountCode ?? "")
      );
    })
  );
}

/**
 * Re-reads current VTiger and Xero GET-only evidence for the one classified
 * no-POST validation failure. It neither reserves a recovery receipt nor calls
 * a writer, and it never updates the immutable failed original event.
 */
export async function previewMainCustomerInvoiceReconciliation(
  originalEventId: number
): Promise<MainCustomerInvoiceReconciliationPreview> {
  const original =
    await getMainCustomerInvoiceReconciliationOriginal(originalEventId);
  const failedExecution =
    await getMainCustomerInvoiceReconciliationWriterEvidence(1110001);
  const origin = classifyMainCustomerInvoiceReconciliationOrigin({
    original,
    failedExecution,
    originalEventId,
  });
  const current = await previewMainCustomerInvoice(origin.dealId);
  const document = current.preview.document;
  const preflight = current.preflight;
  const exactTotals =
    document &&
    sameMoney(document.total, origin.total) &&
    typeof document.subtotal === "number" &&
    typeof document.taxAmount === "number" &&
    sameMoney(document.subtotal + document.taxAmount, document.total);
  if (
    !document ||
    !preflight ||
    current.state !== "previewed" ||
    !current.preview.eligible ||
    !current.xeroPreflightHash ||
    current.facts.dealId !== origin.dealId ||
    current.facts.dealNumber !== origin.dealNumber ||
    current.preview.proposedInvoiceNumber !== origin.invoiceNumber ||
    document.proposedDocumentNumber !== origin.invoiceNumber ||
    document.documentType !== "main_customer_invoice" ||
    document.sourceWorkflow !== "main_customer_invoice" ||
    document.sourceRecordId !== origin.dealId ||
    document.partySourceId !== preflight.contactCheck.contactId ||
    !document.partyName ||
    document.partyName !== preflight.contactCheck.partyName ||
    !preflight.contactCheck.found ||
    !preflight.contactCheck.contactId ||
    preflight.duplicateState !== "not_found" ||
    !exactTotals ||
    !currentMainInvoiceItemsAreExact(
      document as unknown as Record<string, any>,
      preflight as unknown as Record<string, any>
    )
  ) {
    throw new Error(
      "Current Main Customer Invoice source/Xero Draft is not eligible for exact D702946 recovery."
    );
  }
  const payload = prepareMainCustomerInvoiceReconciliationPayload(
    document as unknown as Record<string, any>,
    original!.id,
    current.sourceSnapshotHash
  );
  const evidence: MainCustomerInvoiceReconciliationEvidence = {
    originalEventId: original!.id,
    failedWriterExecutionId: failedExecution!.id,
    dealId: origin.dealId,
    dealNumber: origin.dealNumber,
    invoiceNumber: origin.invoiceNumber,
    originalEventHash: mainCustomerInvoiceReconciliationOriginalHash(original!),
    failedWriterEvidenceHash:
      mainCustomerInvoiceReconciliationWriterEvidenceHash(failedExecution!),
    sourceSnapshotHash: current.sourceSnapshotHash,
    xeroPreflightHash: current.xeroPreflightHash,
    sourceSnapshot: current.facts as unknown as Record<string, unknown>,
    proposal: document as unknown as Record<string, unknown>,
    xeroPreflight: preflight as unknown as Record<string, unknown>,
  };
  return {
    originalEventId: original!.id,
    failedWriterExecutionId: failedExecution!.id,
    dealId: origin.dealId,
    dealNumber: origin.dealNumber,
    invoiceNumber: origin.invoiceNumber,
    proposal: document,
    payload,
    evidence,
    noWrites: true,
  };
}

/**
 * Explicit server-only execution for the separately approved recovery receipt.
 * This function is deliberately not imported by webhooks, routes, tRPC, jobs,
 * or browser actions. It is inactive unless the dedicated gate is manually set.
 */
export async function applyApprovedMainCustomerInvoiceReconciliation(
  originalEventId: number
) {
  if (
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED !==
    "true"
  ) {
    throw new Error(
      "Main Customer Invoice reconciliation release is disabled."
    );
  }
  const policy = await getMainCustomerInvoiceReleasePolicy();
  assertMainCustomerInvoiceReconciliationRelease(policy);
  const first = await previewMainCustomerInvoiceReconciliation(originalEventId);
  const token = randomUUID();
  const reserved = await reserveMainCustomerInvoiceReconciliation({
    ...first.evidence,
    token,
  });
  if (reserved.state !== "reserved") {
    return {
      ok: false as const,
      status: reserved.state,
      eventId: reserved.event.id,
    };
  }
  await bindMainCustomerInvoiceReconciliationPayload(
    reserved.event.id,
    token,
    policy.releaseKey,
    first.payload
  );
  try {
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "main_invoice_reconciliation",
      proposedAction: "create_draft",
      payload: first.payload,
      expectedDraftDocument: first.proposal,
      preparedBy: policy.approvedBy!,
      authorisation: {
        workflowType: "main_invoice_reconciliation",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        mainInvoiceReconciliationEventId: reserved.event.id,
        mainInvoiceReconciliationToken: token,
        mainInvoiceReconciliationReleaseKey: policy.releaseKey,
        mainInvoiceReconciliationApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome !== "succeeded") {
      await holdMainCustomerInvoiceReconciliation(
        reserved.event.id,
        token,
        "Main Customer Invoice recovery requires reconciliation; its independent recovery receipt remains consumed."
      );
      return {
        ok: false as const,
        status: "reconciliation_required" as const,
        eventId: reserved.event.id,
        outcome,
      };
    }
    await completeMainCustomerInvoiceReconciliation({
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
    await holdMainCustomerInvoiceReconciliation(
      reserved.event.id,
      token,
      error instanceof Error
        ? error.message
        : "Main Customer Invoice recovery held."
    );
    throw error;
  }
}

// Ensure service-level evidence remains explicit when inspected independently.
export const MAIN_CUSTOMER_INVOICE_RECONCILIATION_EVIDENCE_VERSION =
  financialSha256({
    workflow: "main_invoice_reconciliation",
    noWritesOnPreview: true,
  });
