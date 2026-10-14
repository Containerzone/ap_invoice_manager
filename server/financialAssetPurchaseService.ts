import { randomUUID } from "node:crypto";
import {
  ASSET_PURCHASE_RULES_HASH,
  ASSET_PURCHASE_RULES_VERSION,
  buildAssetPurchasePo,
  type AssetPurchaseContainerControlFacts,
  type AssetPurchasePoPreview,
} from "./financialAssetPurchaseDrafts";
import {
  bindAssetPurchasePayload,
  claimAssetPurchasePreview,
  completeAssetPurchaseDraft,
  getAssetPurchaseEvent,
  getAssetPurchasePoEvents,
  holdAssetPurchaseExecution,
  recordAssetPurchasePreview,
} from "./financialAssetPurchaseDb";
import { assertAssetPurchaseRelease, getAssetPurchaseReleasePolicy } from "./financialAssetPurchaseRelease";
import { preflightFinancialXeroIntents, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";

export const ASSET_PURCHASE_VTIGER_MODULE = "vtcmcontainercontrols" as const;
export const ASSET_PURCHASE_WEBHOOK_PATH = "/api/webhooks/vtiger/container-control-asset" as const;

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
export async function readAssetPurchaseContainerControl(recordIdValue: string): Promise<AssetPurchaseContainerControlFacts> {
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

function preflightReason(document: AssetPurchasePoPreview["document"], preflight: FinancialXeroPreflight | null): string | null {
  if (!document || !preflight) return "No valid Asset PO proposal is available for Xero preflight.";
  if (preflight.duplicateState !== "not_found") return `Exact Xero PO ${document.proposedDocumentNumber} is ${preflight.duplicateState}${preflight.status ? ` (${preflight.status})` : ""}; AP will not bypass or adopt it.`;
  if (!preflight.contactCheck.found || !preflight.contactCheck.contactId) return "Xero supplier contact is missing, ambiguous or not an exact match.";
  const expectedItem = document.lineItems[0]?.itemCode;
  if (!expectedItem || !preflight.itemChecks.some((item) => item.itemCode === expectedItem && item.found)) return `Xero ${expectedItem ?? "selected Sale"} purchase item is unavailable.`;
  return null;
}

function applyContact(document: NonNullable<AssetPurchasePoPreview["document"]>, preflight: FinancialXeroPreflight): void {
  if (preflight.contactCheck.found && preflight.contactCheck.contactId) document.partySourceId = preflight.contactCheck.contactId;
}

async function recordPreview(input: {
  facts: AssetPurchaseContainerControlFacts;
  preview: AssetPurchasePoPreview;
  sourceHash: string;
  preflight: FinancialXeroPreflight | null;
  state: "previewed" | "held";
  reason: string | null;
}) {
  return recordAssetPurchasePreview({
    containerControlId: input.facts.recordId,
    containerControlNumber: input.facts.controlNumber || input.facts.recordId,
    proposedPoNumber: input.preview.proposedPoNumber ?? `UNRESOLVED-ASSET-${input.facts.recordId}`,
    containerNumber: input.facts.containerNumber,
    containerType: input.facts.containerType,
    supplierVtigerId: input.facts.supplierVtigerId || null,
    supplierName: input.facts.supplierName || null,
    purchaseDate: input.facts.purchaseDate || null,
    sourceRefreshedAt: input.facts.sourceRefreshedAt ? new Date(input.facts.sourceRefreshedAt) : null,
    sourceSnapshotHash: input.sourceHash,
    rulesSnapshotHash: ASSET_PURCHASE_RULES_HASH,
    xeroPreflightHash: input.preflight ? financialSha256(input.preflight) : null,
    proposal: input.preview.document,
    xeroPreflight: input.preflight,
    status: input.state,
    holdReason: input.reason,
  });
}

export type AssetPurchasePreviewResult = {
  facts: AssetPurchaseContainerControlFacts;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  preview: AssetPurchasePoPreview;
  preflight: FinancialXeroPreflight | null;
  state: "previewed" | "held";
  holdReason: string | null;
  noWrites: true;
};

/** Administrator-invoked, exact-current-source and GET-only Asset PO preview. */
export async function previewAssetPurchasePo(recordIdValue: string): Promise<AssetPurchasePreviewResult> {
  const facts = await readAssetPurchaseContainerControl(recordIdValue);
  const sourceHash = sourceSnapshotHash({ ...facts, rulesVersion: ASSET_PURCHASE_RULES_VERSION });
  const preview = buildAssetPurchasePo(facts);
  if (!preview.eligible || !preview.document) {
    const reason = preview.holdReason ?? "Asset PO source eligibility is incomplete.";
    await recordPreview({ facts, preview, sourceHash, preflight: null, state: "held", reason });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: ASSET_PURCHASE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, noWrites: true };
  }
  try {
    const [preflight] = await preflightFinancialXeroIntents([preview.document]);
    const reason = preflightReason(preview.document, preflight ?? null);
    if (reason || !preflight) {
      await recordPreview({ facts, preview, sourceHash, preflight: preflight ?? null, state: "held", reason: reason ?? "Xero GET-only preflight was not completed." });
      return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: ASSET_PURCHASE_RULES_HASH, xeroPreflightHash: preflight ? financialSha256(preflight) : null, preview, preflight: preflight ?? null, state: "held", holdReason: reason ?? "Xero GET-only preflight was not completed.", noWrites: true };
    }
    applyContact(preview.document, preflight);
    await recordPreview({ facts, preview, sourceHash, preflight, state: "previewed", reason: null });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: ASSET_PURCHASE_RULES_HASH, xeroPreflightHash: financialSha256(preflight), preview, preflight, state: "previewed", holdReason: null, noWrites: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Xero GET-only preflight could not be completed.";
    await recordPreview({ facts, preview, sourceHash, preflight: null, state: "held", reason });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: ASSET_PURCHASE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, noWrites: true };
  }
}

/** Called only by the protected Asset / REQUEST VTiger branch after its release gate is armed. */
export async function processAutomaticAssetPurchase(recordIdValue: string) {
  const policy = await getAssetPurchaseReleasePolicy();
  assertAssetPurchaseRelease(policy);
  const preview = await previewAssetPurchasePo(recordIdValue);
  if (preview.state !== "previewed" || !preview.preview.document) {
    return { ok: false, status: "held" as const, recordId: recordIdValue, warning: preview.holdReason ?? "Asset source or Xero preflight is not ready.", xeroWritesAttempted: 0 };
  }
  const event = await getAssetPurchaseEvent(recordIdValue);
  if (!event) throw new Error("Asset current preflight was not recorded in the AP ledger.");
  const effectiveFrom = Date.parse(policy.effectiveFrom!);
  const sourceRefreshedAt = preview.facts.sourceRefreshedAt ? Date.parse(preview.facts.sourceRefreshedAt) : Number.NaN;
  if (!Number.isFinite(sourceRefreshedAt) || sourceRefreshedAt < effectiveFrom) {
    const reason = "Asset source predates the approved new-events-only cutover; it is held for reconciliation and will not create an AP Draft.";
    await holdAssetPurchaseExecution(event.id, reason);
    return { ok: false, status: "held" as const, recordId: recordIdValue, eventId: event.id, warning: reason, xeroWritesAttempted: 0 };
  }
  if (event.status === "drafts_created") return { ok: true, status: "duplicate_replay" as const, recordId: recordIdValue, eventId: event.id, poNumber: event.proposedPoNumber, xeroWritesAttempted: 0 };
  if (event.status === "reconciliation_required") return { ok: false, status: "reconciliation_required" as const, recordId: recordIdValue, eventId: event.id, warning: event.holdReason ?? "Asset write is awaiting reconciliation.", xeroWritesAttempted: 0 };

  const token = randomUUID();
  if (!(await claimAssetPurchasePreview(event.id, token))) {
    return { ok: false, status: "held" as const, recordId: recordIdValue, eventId: event.id, warning: "Asset PO is already being processed or was not freshly preflighted.", xeroWritesAttempted: 0 };
  }
  try {
    const payload = prepareFinancialDraftPayload(preview.preview.document, `${recordIdValue}:asset_purchase:${preview.sourceSnapshotHash}`);
    const row = (payload.body.PurchaseOrders as Record<string, unknown>[] | undefined)?.[0];
    if (!row) throw new Error("Asset PO transport payload is missing its Purchase Order.");
    row.CurrencyCode = "AUD";
    await bindAssetPurchasePayload(event.id, policy.releaseKey, payload);
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "asset_purchase",
      proposedAction: "create_draft",
      payload,
      expectedDraftDocument: preview.preview.document,
      preparedBy: policy.approvedBy!,
      sourceRecordId: recordIdValue,
      verifiedSourceData: { containerControlId: recordIdValue, sourceSnapshotHash: preview.sourceSnapshotHash },
      authorisation: {
        workflowType: "asset_purchase",
        approvalReference: policy.releaseKey,
        globalShadowMode: false,
        familyLiveEnabled: true,
        releaseManifestApproved: true,
        cutoverPackApproved: true,
        currentDocumentPreflightPassed: true,
        legacyWriterHandoffComplete: true,
        assetPurchaseAutomaticEventId: event.id,
        assetPurchaseReleaseKey: policy.releaseKey,
        assetPurchaseApprovedBy: policy.approvedBy!,
      },
    });
    if (outcome.outcome === "reconciliation_required" || outcome.outcome === "duplicate") {
      await holdAssetPurchaseExecution(event.id, "Asset Xero execution requires exact reconciliation before any retry.", true);
      return { ok: false, status: "reconciliation_required" as const, recordId: recordIdValue, eventId: event.id, warning: "Asset Xero result is awaiting reconciliation; no blind retry will occur.", xeroWritesAttempted: outcome.outcome === "reconciliation_required" ? 1 : 0 };
    }
    await completeAssetPurchaseDraft({ eventId: event.id, executionId: outcome.executionId, xeroPurchaseOrderId: outcome.result.xeroDocumentId });
    return { ok: true, status: "drafts_created" as const, recordId: recordIdValue, eventId: event.id, poNumber: outcome.result.documentNumber, xeroPurchaseOrderId: outcome.result.xeroDocumentId, xeroWritesAttempted: 1 };
  } catch (error) {
    await holdAssetPurchaseExecution(event.id, error instanceof Error ? error.message : "Asset PO execution failed.");
    throw error;
  }
}

export async function getAssetPurchaseReadiness() {
  const policy = await getAssetPurchaseReleasePolicy();
  const writerEnabled = process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED === "true" && policy.enabled;
  return {
    module: ASSET_PURCHASE_VTIGER_MODULE,
    webhookPath: ASSET_PURCHASE_WEBHOOK_PATH,
    routeRegistered: true,
    webhookAuthenticationConfigured: Boolean(process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim()),
    writerEnabled,
    policy: {
      enabled: policy.enabled,
      effectiveFrom: policy.effectiveFrom,
      assetOnlyVtigerBranch: policy.assetOnlyVtigerBranch,
      operationsAssetHandoff: policy.operationsAssetHandoff,
      migrationScope: policy.migrationScope,
    },
    noWrites: true as const,
  };
}

export { getAssetPurchasePoEvents };
