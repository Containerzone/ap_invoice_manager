import { randomUUID } from "node:crypto";
import {
  CUSTOMER_SALE_PURCHASE_RULES_HASH,
  CUSTOMER_SALE_PURCHASE_RULES_VERSION,
  buildCustomerSalePurchasePo,
  type CustomerSalePurchaseContainerControlFacts,
  type CustomerSalePurchasePoPreview,
} from "./financialCustomerSalePurchaseDrafts";
import {
  bindCustomerSalePurchasePayload,
  claimCustomerSalePurchasePreview,
  completeCustomerSalePurchaseDraft,
  getCustomerSalePurchaseEvent,
  getCustomerSalePurchasePoEvents,
  holdCustomerSalePurchaseExecution,
  recordCustomerSalePurchasePreview,
} from "./financialCustomerSalePurchaseDb";
import { assertCustomerSalePurchaseRelease, getCustomerSalePurchaseReleasePolicy } from "./financialCustomerSalePurchaseRelease";
import { preflightFinancialXeroIntents, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";

export const CUSTOMER_SALE_PURCHASE_VTIGER_MODULE = "vtcmcontainercontrols" as const;
export const CUSTOMER_SALE_PURCHASE_WEBHOOK_PATH = "/api/webhooks/vtiger/container-control-customer-sale" as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function recordId(value: unknown): string {
  const raw = text(value);
  return /^\d+x\d+$/i.test(raw) ? raw : "";
}

function toNumber(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

function sourceRefresh(raw: Record<string, unknown>): Date | null {
  const value = text(raw.modifiedtime ?? raw.modifiedTime ?? raw.createdtime);
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

async function resolveVendor(reference: string): Promise<{ id: string; name: string }> {
  const vendor = await retrieveCurrentVtigerFinancialRecord(reference);
  if (recordId(vendor.id) !== reference) throw new Error("VTiger supplier reference did not return the exact assigned Vendor.");
  const name = text(vendor.vendorname ?? vendor.vendor_name ?? vendor.name);
  if (!name) throw new Error("Assigned VTiger Vendor has no usable name.");
  return { id: reference, name };
}

/** Re-reads the exact current Container Control and assigned Supplier Name reference. */
export async function readCustomerSalePurchaseContainerControl(recordIdValue: string): Promise<CustomerSalePurchaseContainerControlFacts> {
  const raw = await retrieveCurrentVtigerFinancialRecord(recordIdValue);
  if (recordId(raw.id) !== recordIdValue) throw new Error("VTiger Container Control retrieve did not return the exact requested record.");
  const supplierId = recordId(raw.cf_vtcmcontainercontrols_suppliername ?? raw.suppliername);
  const supplierName = supplierId ? (await resolveVendor(supplierId)).name : "";
  return {
    recordId: recordIdValue,
    controlNumber: text(raw.vtcmcontainercontrolsnumber),
    acquisition: text(raw.cf_vtcmcontainercontrols_acquisition),
    status: text(raw.cf_vtcmcontainercontrols_status),
    containerNumber: text(raw.fld_vtcmcontainercontrolsname),
    containerType: text(raw.cf_vtcmcontainercontrols_containertype),
    grade: text(raw.cf_vtcmcontainercontrols_grade),
    collectionDepot: text(raw.cf_vtcmcontainercontrols_collectiondepot),
    supplierVtigerId: supplierId,
    supplierName,
    purchasePriceInclusive: toNumber(raw.cf_vtcmcontainercontrols_purchaseprice),
    purchaseDate: text(raw.cf_vtcmcontainercontrols_purchasedate),
    sourceRefreshedAt: sourceRefresh(raw)?.toISOString() ?? null,
  };
}

function preflightReason(document: CustomerSalePurchasePoPreview["document"], preflight: FinancialXeroPreflight | null): string | null {
  if (!document || !preflight) return "No valid Customer Sale PO proposal is available for Xero preflight.";
  if (preflight.duplicateState !== "not_found") return `Exact Xero PO ${document.proposedDocumentNumber} is ${preflight.duplicateState}${preflight.status ? ` (${preflight.status})` : ""}; AP will not bypass or adopt it.`;
  if (!preflight.contactCheck.found || !preflight.contactCheck.contactId) return "Xero supplier contact is missing, ambiguous or not an exact match.";
  if (!preflight.itemChecks.some((item) => item.itemCode === "Container Asset" && item.found)) return "Xero Container Asset purchase item is unavailable.";
  return null;
}

function applyContact(document: NonNullable<CustomerSalePurchasePoPreview["document"]>, preflight: FinancialXeroPreflight): void {
  if (preflight.contactCheck.found && preflight.contactCheck.contactId) document.partySourceId = preflight.contactCheck.contactId;
}

async function recordPreview(input: {
  facts: CustomerSalePurchaseContainerControlFacts;
  preview: CustomerSalePurchasePoPreview;
  sourceHash: string;
  preflight: FinancialXeroPreflight | null;
  state: "previewed" | "held";
  reason: string | null;
}) {
  return recordCustomerSalePurchasePreview({
    containerControlId: input.facts.recordId,
    containerControlNumber: input.facts.controlNumber || input.facts.recordId,
    proposedPoNumber: input.preview.proposedPoNumber ?? `UNRESOLVED-CUSTOMER-SALE-${input.facts.recordId}`,
    containerNumber: input.facts.containerNumber,
    containerType: input.facts.containerType,
    supplierVtigerId: input.facts.supplierVtigerId || null,
    supplierName: input.facts.supplierName || null,
    purchaseDate: input.facts.purchaseDate || null,
    sourceRefreshedAt: input.facts.sourceRefreshedAt ? new Date(input.facts.sourceRefreshedAt) : null,
    sourceSnapshotHash: input.sourceHash,
    rulesSnapshotHash: CUSTOMER_SALE_PURCHASE_RULES_HASH,
    xeroPreflightHash: input.preflight ? financialSha256(input.preflight) : null,
    proposal: input.preview.document,
    xeroPreflight: input.preflight,
    status: input.state,
    holdReason: input.reason,
  });
}

export type CustomerSalePurchasePreviewResult = {
  facts: CustomerSalePurchaseContainerControlFacts;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  preview: CustomerSalePurchasePoPreview;
  preflight: FinancialXeroPreflight | null;
  state: "previewed" | "held";
  holdReason: string | null;
  noWrites: true;
};

/** Administrator-invoked, exact-current-source and GET-only Customer Sale PO preview. */
export async function previewCustomerSalePurchasePo(recordIdValue: string): Promise<CustomerSalePurchasePreviewResult> {
  const facts = await readCustomerSalePurchaseContainerControl(recordIdValue);
  const sourceHash = sourceSnapshotHash({ ...facts, rulesVersion: CUSTOMER_SALE_PURCHASE_RULES_VERSION });
  const preview = buildCustomerSalePurchasePo(facts);
  if (!preview.eligible || !preview.document) {
    const reason = preview.holdReason ?? "Customer Sale PO source eligibility is incomplete.";
    await recordPreview({ facts, preview, sourceHash, preflight: null, state: "held", reason });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: CUSTOMER_SALE_PURCHASE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, noWrites: true };
  }
  try {
    const [preflight] = await preflightFinancialXeroIntents([preview.document]);
    const reason = preflightReason(preview.document, preflight ?? null);
    if (reason || !preflight) {
      await recordPreview({ facts, preview, sourceHash, preflight: preflight ?? null, state: "held", reason: reason ?? "Xero GET-only preflight was not completed." });
      return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: CUSTOMER_SALE_PURCHASE_RULES_HASH, xeroPreflightHash: preflight ? financialSha256(preflight) : null, preview, preflight: preflight ?? null, state: "held", holdReason: reason ?? "Xero GET-only preflight was not completed.", noWrites: true };
    }
    applyContact(preview.document, preflight);
    await recordPreview({ facts, preview, sourceHash, preflight, state: "previewed", reason: null });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: CUSTOMER_SALE_PURCHASE_RULES_HASH, xeroPreflightHash: financialSha256(preflight), preview, preflight, state: "previewed", holdReason: null, noWrites: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Xero GET-only preflight could not be completed.";
    await recordPreview({ facts, preview, sourceHash, preflight: null, state: "held", reason });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: CUSTOMER_SALE_PURCHASE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, noWrites: true };
  }
}

/** Called only by the protected Customer Sale / REQUEST VTiger branch after its release gate is armed. */
export async function processAutomaticCustomerSalePurchase(recordIdValue: string) {
  const policy = await getCustomerSalePurchaseReleasePolicy();
  assertCustomerSalePurchaseRelease(policy);
  const preview = await previewCustomerSalePurchasePo(recordIdValue);
  if (preview.state !== "previewed" || !preview.preview.document) {
    return { ok: false, status: "held" as const, recordId: recordIdValue, warning: preview.holdReason ?? "Customer Sale source or Xero preflight is not ready.", xeroWritesAttempted: 0 };
  }
  const event = await getCustomerSalePurchaseEvent(recordIdValue);
  if (!event) throw new Error("Customer Sale current preflight was not recorded in the AP ledger.");
  const effectiveFrom = Date.parse(policy.effectiveFrom!);
  const sourceRefreshedAt = preview.facts.sourceRefreshedAt ? Date.parse(preview.facts.sourceRefreshedAt) : Number.NaN;
  if (!Number.isFinite(sourceRefreshedAt) || sourceRefreshedAt < effectiveFrom) {
    const reason = "Customer Sale source predates the approved new-events-only cutover; it is held for reconciliation and will not create an AP Draft.";
    await holdCustomerSalePurchaseExecution(event.id, reason);
    return { ok: false, status: "held" as const, recordId: recordIdValue, eventId: event.id, warning: reason, xeroWritesAttempted: 0 };
  }
  if (event.status === "drafts_created") return { ok: true, status: "duplicate_replay" as const, recordId: recordIdValue, eventId: event.id, poNumber: event.proposedPoNumber, xeroWritesAttempted: 0 };
  if (event.status === "reconciliation_required") return { ok: false, status: "reconciliation_required" as const, recordId: recordIdValue, eventId: event.id, warning: event.holdReason ?? "Customer Sale write is awaiting reconciliation.", xeroWritesAttempted: 0 };

  const token = randomUUID();
  if (!(await claimCustomerSalePurchasePreview(event.id, token))) {
    return { ok: false, status: "held" as const, recordId: recordIdValue, eventId: event.id, warning: "Customer Sale PO is already being processed or was not freshly preflighted.", xeroWritesAttempted: 0 };
  }
  try {
    const payload = prepareFinancialDraftPayload(preview.preview.document, `${recordIdValue}:customer_sale_purchase:${preview.sourceSnapshotHash}`);
    const row = (payload.body.PurchaseOrders as Record<string, unknown>[] | undefined)?.[0];
    if (!row) throw new Error("Customer Sale PO transport payload is missing its Purchase Order.");
    row.CurrencyCode = "AUD";
    await bindCustomerSalePurchasePayload(event.id, policy.releaseKey, payload);
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "customer_sale_purchase",
      proposedAction: "create_draft",
      payload,
      expectedDraftDocument: preview.preview.document,
      preparedBy: policy.approvedBy!,
      sourceRecordId: recordIdValue,
      verifiedSourceData: { containerControlId: recordIdValue, sourceSnapshotHash: preview.sourceSnapshotHash },
      authorisation: {
        workflowType: "customer_sale_purchase",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        customerSalePurchaseAutomaticEventId: event.id,
        customerSalePurchaseReleaseKey: policy.releaseKey,
        customerSalePurchaseApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome === "reconciliation_required" || outcome.outcome === "duplicate") {
      await holdCustomerSalePurchaseExecution(event.id, "Customer Sale Xero execution requires exact reconciliation before any retry.", true);
      return { ok: false, status: "reconciliation_required" as const, recordId: recordIdValue, eventId: event.id, warning: "Customer Sale Xero result is awaiting reconciliation; no blind retry will occur.", xeroWritesAttempted: outcome.outcome === "reconciliation_required" ? 1 : 0 };
    }
    await completeCustomerSalePurchaseDraft({ eventId: event.id, executionId: outcome.executionId, xeroPurchaseOrderId: outcome.result.xeroDocumentId });
    return { ok: true, status: "drafts_created" as const, recordId: recordIdValue, eventId: event.id, poNumber: outcome.result.documentNumber, xeroPurchaseOrderId: outcome.result.xeroDocumentId, xeroWritesAttempted: 1 };
  } catch (error) {
    await holdCustomerSalePurchaseExecution(event.id, error instanceof Error ? error.message : "Customer Sale PO execution failed.");
    throw error;
  }
}

export async function getCustomerSalePurchaseReadiness() {
  const policy = await getCustomerSalePurchaseReleasePolicy();
  const writerEnabled = process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED === "true" && policy.enabled;
  return {
    module: CUSTOMER_SALE_PURCHASE_VTIGER_MODULE,
    webhookPath: CUSTOMER_SALE_PURCHASE_WEBHOOK_PATH,
    routeRegistered: true,
    webhookAuthenticationConfigured: Boolean(process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim()),
    writerEnabled,
    policy: {
      enabled: policy.enabled,
      effectiveFrom: policy.effectiveFrom,
      customerSaleOnlyVtigerBranch: policy.customerSaleOnlyVtigerBranch,
      operationsCustomerSaleHandoff: policy.operationsCustomerSaleHandoff,
      migrationScope: policy.migrationScope,
    },
    noWrites: true as const,
  };
}

export { getCustomerSalePurchasePoEvents };
