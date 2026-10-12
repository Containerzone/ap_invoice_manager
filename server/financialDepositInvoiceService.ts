import { randomUUID } from "node:crypto";
import {
  buildDepositInvoice,
  DEPOSIT_INVOICE_RULES_HASH,
  DEPOSIT_INVOICE_RULES_VERSION,
  DEPOSIT_MAIN_DEDUCTION_HOLD,
  type DepositInvoiceFacts,
  type DepositInvoicePreview,
} from "./financialDepositInvoiceDrafts";
import {
  DEPOSIT_INVOICE_VTIGER_MODULE,
  readDepositInvoiceFacts,
} from "./financialDepositInvoiceSource";
import {
  bindDepositInvoicePayload,
  claimDepositInvoicePreview,
  completeDepositInvoiceDraft,
  depositPreflightHold,
  getDepositInvoiceClaim,
  holdDepositInvoiceExecution,
  recordDepositInvoicePreview,
} from "./financialDepositInvoiceDb";
import {
  assertDepositInvoiceRelease,
  getDepositInvoiceReleasePolicy,
} from "./financialDepositInvoiceRelease";
import {
  preflightFinancialXeroIntents,
  readDepositInvoiceXeroItemConfiguration,
  type FinancialXeroPreflight,
} from "./financialReadOnlyXeroService";
import {
  financialSha256,
  sourceSnapshotHash,
} from "./financialProposalIntegrity";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { readCurrentCustomerContactSource } from "./financialCustomerContactSource";
import { resolveOrCreateAutomaticCustomerContact } from "./financialCustomerContactService";
import { processAutomaticDepositMainDeduction } from "./financialDepositMainDeductionService";

export const DEPOSIT_INVOICE_WEBHOOK_PATH =
  "/api/webhooks/vtiger/deposit-invoice" as const;
export type DepositInvoicePreviewResult = {
  facts: DepositInvoiceFacts;
  preview: DepositInvoicePreview;
  preflight: FinancialXeroPreflight | null;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  state: "previewed" | "held";
  holdReason: string | null;
  noWrites: true;
};

/** Administrator read-only preview: no local inserts and no Xero/VTiger record mutations. */
export async function previewDepositInvoice(
  dealId: string,
  expectedDealNumber?: string
): Promise<DepositInvoicePreviewResult> {
  const facts = await readDepositInvoiceFacts(dealId);
  if (
    expectedDealNumber &&
    facts.dealNumber.toUpperCase() !== expectedDealNumber.toUpperCase()
  )
    throw new Error(
      "Current Deposit Deal number no longer matches the exact lookup."
    );
  const sourceHash = sourceSnapshotHash({
    ...facts,
    rulesVersion: DEPOSIT_INVOICE_RULES_VERSION,
  });
  const preview = buildDepositInvoice(facts);
  const result = (
    preflight: FinancialXeroPreflight | null,
    reason: string | null
  ): DepositInvoicePreviewResult => ({
    facts,
    preview,
    preflight,
    sourceSnapshotHash: sourceHash,
    rulesSnapshotHash: DEPOSIT_INVOICE_RULES_HASH,
    xeroPreflightHash: preflight ? financialSha256(preflight) : null,
    state: reason ? "held" : "previewed",
    holdReason: reason,
    noWrites: true,
  });
  if (!preview.eligible || !preview.document)
    return result(
      null,
      preview.holdReason ?? "Deposit source eligibility is incomplete."
    );
  let preflight: FinancialXeroPreflight | null = null;
  try {
    [preflight = null] = await preflightFinancialXeroIntents([
      preview.document,
    ]);
    const reason = depositPreflightHold(
      preview.document.proposedDocumentNumber!,
      facts.customerName,
      preflight
    );
    if (reason || !preflight)
      return result(
        preflight,
        reason ?? "Deposit GET-only preflight incomplete."
      );
    const item = await readDepositInvoiceXeroItemConfiguration();
    preview.document.partySourceId = preflight.contactCheck.contactId;
    preview.document.accountCode = item.accountCode;
    preview.document.lineItems[0]!.accountCode = item.accountCode;
    return result(preflight, null);
  } catch (error) {
    return result(
      preflight,
      error instanceof Error
        ? error.message
        : "Deposit GET-only preflight failed."
    );
  }
}

/** Only the dedicated protected receiver can reach this isolated family path. */
export async function processAutomaticDepositInvoice(dealId: string) {
  const policy = await getDepositInvoiceReleasePolicy();
  assertDepositInvoiceRelease(policy);
  let evidence = await previewDepositInvoice(dealId);
  let reason = evidence.holdReason;
  if (
    !reason &&
    (!evidence.facts.sourceRefreshedAt ||
      Date.parse(evidence.facts.sourceRefreshedAt) <
        Date.parse(policy.effectiveFrom!))
  )
    reason =
      "Current Deposit Deal predates the approved new-events-only cutover or lacks a source timestamp; no historical backfill.";
  const previous = evidence.preview.proposedInvoiceNumber
    ? await getDepositInvoiceClaim(
        dealId,
        evidence.preview.proposedInvoiceNumber
      )
    : null;
  if (previous) {
    const deduction = previous.status === "drafts_created"
      ? await processAutomaticDepositMainDeduction(dealId)
      : null;
    return {
      ok: false,
      status: "held" as const,
      recordId: dealId,
      eventId: previous.id,
      warning: `Exact Deposit Deal/number already reserved (${previous.status}); reconcile by immutable ID.`,
      xeroWritesAttempted: 0,
      mainDeduction: deduction,
      postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
    };
  }
  const contactOnlyHold = reason === "Exact current Deal Xero customer is missing or ambiguous.";
  if (reason && !contactOnlyHold) {
    const event = await recordDepositInvoicePreview({
      facts: evidence.facts, sourceHash: evidence.sourceSnapshotHash, proposal: evidence.preview.document,
      preflight: evidence.preflight, proposedInvoiceNumber: evidence.preview.proposedInvoiceNumber, status: "held", holdReason: reason,
    });
    return { ok: false, status: "held" as const, recordId: dealId, eventId: event.id, warning: reason, xeroWritesAttempted: 0, postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD };
  }
  // Validate the Deposit item's Xero configuration before creating a customer
  // contact. If it is absent, a contact-only write would not lead to an invoice.
  if (contactOnlyHold) await readDepositInvoiceXeroItemConfiguration();
  const source = await readCurrentCustomerContactSource({
    customerVtigerId: evidence.facts.customerVtigerId,
    customerKind: evidence.facts.customerKind,
    expectedCustomerName: evidence.facts.customerName,
  });
  const contact = await resolveOrCreateAutomaticCustomerContact(source);
  if (contact.status === "held" || contact.status === "reconciliation_required") {
    const event = await recordDepositInvoicePreview({
      facts: evidence.facts, sourceHash: evidence.sourceSnapshotHash, proposal: evidence.preview.document,
      preflight: evidence.preflight, proposedInvoiceNumber: evidence.preview.proposedInvoiceNumber, status: "held", holdReason: contact.reason,
    });
    return { ok: false, status: contact.status, recordId: dealId, eventId: event.id, warning: contact.reason, xeroWritesAttempted: contact.contactWritesAttempted, postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD };
  }
  evidence = await previewDepositInvoice(dealId);
  const refreshedSource = await readCurrentCustomerContactSource({
    customerVtigerId: evidence.facts.customerVtigerId,
    customerKind: evidence.facts.customerKind,
    expectedCustomerName: evidence.facts.customerName,
  });
  if (refreshedSource.sourceSnapshotHash !== source.sourceSnapshotHash || evidence.state !== "previewed" || !evidence.preview.document || evidence.preflight?.contactCheck.contactId !== contact.contactId) {
    reason = "Current source or Xero customer contact changed after customer-contact resolution; no Deposit Draft will be created.";
  } else {
    reason = evidence.holdReason;
  }
  const event = await recordDepositInvoicePreview({
    facts: evidence.facts,
    sourceHash: evidence.sourceSnapshotHash,
    proposal: evidence.preview.document,
    preflight: evidence.preflight,
    proposedInvoiceNumber: evidence.preview.proposedInvoiceNumber,
    status: reason ? "held" : "previewed",
    holdReason: reason,
  });
  if (reason || !evidence.preview.document || !evidence.xeroPreflightHash)
    return {
      ok: false,
      status: "held" as const,
      recordId: dealId,
      eventId: event.id,
      warning: reason ?? "Deposit evidence is held.",
      xeroWritesAttempted: contact.contactWritesAttempted,
      postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
    };
  const token = randomUUID();
  if (
    !(await claimDepositInvoicePreview(
      event.id,
      token,
      evidence.sourceSnapshotHash,
      evidence.xeroPreflightHash
    ))
  )
    return {
      ok: false,
      status: "held" as const,
      recordId: dealId,
      eventId: event.id,
        warning:
          "Deposit exact evidence or number is already claimed; no duplicate creation.",
        xeroWritesAttempted: contact.contactWritesAttempted,
      postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
    };
  try {
    const payload = prepareFinancialDraftPayload(
      evidence.preview.document,
      `${dealId}:deposit_invoice:${evidence.sourceSnapshotHash}`
    );
    (payload.body.Invoices as Record<string, unknown>[])[0]!.CurrencyCode =
      "AUD";
    await bindDepositInvoicePayload(
      event.id,
      token,
      policy.releaseKey,
      payload
    );
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "deposit_invoice",
      proposedAction: "create_draft",
      payload,
      expectedDraftDocument: evidence.preview.document,
      preparedBy: policy.approvedBy!,
      sourceRecordId: dealId,
      // No postSuccessPlan: no CRM updates or draft deductions are queued.
      authorisation: {
        workflowType: "deposit_invoice",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        depositInvoiceAutomaticEventId: event.id,
        depositInvoiceReleaseKey: policy.releaseKey,
        depositInvoiceApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome !== "succeeded") {
      await holdDepositInvoiceExecution(
        event.id,
        "Deposit write outcome needs exact reconciliation; no retry/adoption is allowed."
      );
      return {
        ok: false,
        status: "reconciliation_required" as const,
        recordId: dealId,
        eventId: event.id,
        warning:
          "Reconcile the exact Deposit invoice before any further action.",
        xeroWritesAttempted:
          contact.contactWritesAttempted + (outcome.outcome === "reconciliation_required" ? 1 : 0),
        postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
      };
    }
    await completeDepositInvoiceDraft({
      eventId: event.id,
      token,
      executionId: outcome.executionId,
      xeroInvoiceId: outcome.result.xeroDocumentId,
    });
    const deduction = await processAutomaticDepositMainDeduction(dealId);
    return {
      ok: true,
      status: "drafts_created" as const,
      recordId: dealId,
      eventId: event.id,
      invoiceNumber: outcome.result.documentNumber,
      xeroInvoiceId: outcome.result.xeroDocumentId,
      xeroWritesAttempted: contact.contactWritesAttempted + 1 + deduction.xeroWritesAttempted,
      mainDeduction: deduction,
      postconditionHold: deduction.status === "deducted" ? null : DEPOSIT_MAIN_DEDUCTION_HOLD,
    };
  } catch (error) {
    await holdDepositInvoiceExecution(
      event.id,
      error instanceof Error
        ? error.message
        : "Deposit execution failed; reconcile before retry."
    );
    throw error;
  }
}
export async function getDepositInvoiceReadiness() {
  const policy = await getDepositInvoiceReleasePolicy();
  let writerEnabled = false;
  let releaseHoldReason: string | null = null;
  try {
    assertDepositInvoiceRelease(policy);
    writerEnabled = true;
  } catch (error) {
    releaseHoldReason =
      error instanceof Error ? error.message : "Deposit release is disabled.";
  }
  return {
    module: DEPOSIT_INVOICE_VTIGER_MODULE,
    webhookPath: DEPOSIT_INVOICE_WEBHOOK_PATH,
    routeRegistered: true,
    webhookAuthenticationConfigured: Boolean(
      process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim()
    ),
    writerEnabled,
    customerContactAutomationEnabled:
      process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED === "true",
    releaseHoldReason,
    policy,
    postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
    sourceMappingMode: "exact_current_metadata_labels",
    noWrites: true as const,
  };
}
