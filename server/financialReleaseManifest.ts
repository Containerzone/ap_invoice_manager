import { createHash } from "node:crypto";
import type { FinancialAutomationRules } from "./financialAutomationRules";
import type { FinancialXeroConnectionTest } from "./financialReadOnlyXeroService";
import type { VtigerFinancialConnectionTest } from "./vtigerFinancialReadService";

export type FinancialReleaseFamilyDefinition = {
  familyKey: string;
  workflowType: string;
  displayName: string;
  branch: string;
  expectedReferencePattern: string;
  firstExpectedTrigger: string;
  apScheduleDefinition?: string;
  partyAndAccountRules: (rules: FinancialAutomationRules) => Record<string, unknown>;
  calculationRules: (rules: FinancialAutomationRules) => Record<string, unknown>;
  conditionPayloadContract: string;
};

const DRAFT_ONLY = "AP Management may only propose Xero Draft documents. Any non-Draft collision or amendment path must stop, create a local exception and remain outside the release.";
const DISABLED_RELEASE_ENDPOINT = "Canonical authenticated AP event route (versioned 2026-09-29 envelope; dry_run/proposal only until all execution gates and a named approval pass)";
const SHADOW_AUTH = "X-Financial-Webhook-Secret is compared server-side and never displayed. The body uses apiVersion, dryRun/mode, deterministic eventId, sourceEntityType, sourceRecordId and sourceChangedAt; generic non-dry VTiger actions remain unconfigured.";
const DEFAULT_ROLLBACK = "Disable the AP family before any external change. Do not re-enable an Operations/VTiger/Make writer until duplicate reconciliation proves that no Draft was created. Retain AP ledger, source and Xero read evidence.";

export const FINANCIAL_RELEASE_FAMILIES: readonly FinancialReleaseFamilyDefinition[] = [
  {
    familyKey: "initial_container_control_asset",
    workflowType: "container_control_acquisition",
    displayName: "Initial Container Control — Asset",
    branch: "Initial Container Control — Asset",
    expectedReferencePattern: "A<Container Control>",
    firstExpectedTrigger: "Authenticated AP event after a Container Control reaches REQUEST with asset cost.",
    partyAndAccountRules: (rules) => ({ party: "allocated supplier", accountCode: rules.accounts.acquisition }),
    calculationRules: (rules) => ({ itemCode: rules.itemCodes.acquisitionAsset, gstTreatment: "GST_EXCLUSIVE", quantity: 1, rateSource: "assetAmountExGst" }),
    conditionPayloadContract: "Exact Container Control ID, control number, REQUEST status, supplier/contact and assetAmountExGst. AP validates unique source and exact Xero reference before preparing a Draft-only payload.",
  },
  {
    familyKey: "initial_container_control_customer_sale",
    workflowType: "container_control_acquisition",
    displayName: "Initial Container Control — Customer Sale",
    branch: "Initial Container Control — Customer Sale",
    expectedReferencePattern: "S<Container Control>",
    firstExpectedTrigger: "Authenticated AP event after a Container Control reaches REQUEST with customer-sale cost.",
    partyAndAccountRules: (rules) => ({ party: "allocated customer-sale supplier", accountCode: rules.accounts.acquisition }),
    calculationRules: (rules) => ({ itemCode: rules.itemCodes.acquisitionCustomerSale, gstTreatment: "GST_EXCLUSIVE", quantity: 1, rateSource: "customerSaleAmountExGst" }),
    conditionPayloadContract: "Exact Container Control ID, control number, REQUEST status, customer-sale supplier/contact and customerSaleAmountExGst. AP validates unique source and exact Xero reference before preparing a Draft-only payload.",
  },
  {
    familyKey: "initial_container_control_for_hire",
    workflowType: "container_control_acquisition",
    displayName: "Initial Container Control — For Hire",
    branch: "Initial Container Control — For Hire",
    expectedReferencePattern: "H<Container Control>",
    firstExpectedTrigger: "Authenticated AP event after a REQUEST Container Control is marked FOR HIRE.",
    partyAndAccountRules: (rules) => ({ party: "allocated hire supplier", accountCode: rules.accounts.initialHire }),
    calculationRules: (rules) => ({ itemCodes: [rules.itemCodes.initialHire20, rules.itemCodes.initialHire40], gstTreatment: "GST_EXCLUSIVE", quantity: 1, rateSource: "hireCostExGst or configured 20/40-foot monthly fallback" }),
    conditionPayloadContract: "Exact For Hire Container Control with control number, 20/40-foot type, Collection Date, hire supplier/contact and valid cost. AP validates source and exact Xero reference before preparing a Draft-only payload.",
  },
  {
    familyKey: "recurring_for_hire",
    workflowType: "recurring_for_hire",
    displayName: "Recurring For Hire",
    branch: "Recurring For Hire",
    expectedReferencePattern: "HC<Container Control>-<next numeric suffix>",
    firstExpectedTrigger: "Disabled monthly AP schedule definition; no task is registered until a later approved activation.",
    apScheduleDefinition: "Disabled monthly definition: 0 0 0 1 * * (no task UID registered)",
    partyAndAccountRules: (rules) => ({ party: "allocated hire supplier", accountCode: rules.accounts.recurringHire, eligibleStatuses: rules.validation.allowedRecurringHireStatuses }),
    calculationRules: (rules) => ({ itemCodes: [rules.itemCodes.recurringHire20, rules.itemCodes.recurringHire40], gstTreatment: "GST_EXCLUSIVE", quantity: rules.defaults.recurringHireDays, rateSource: "current Xero purchase-side daily rate" }),
    conditionPayloadContract: "Exact ON HIRE or IDLE FOR HIRE Container Control, container number/type, supplier/contact and current item purchase rate. The disabled schedule must preflight one due record at a time and never bulk-replay history.",
  },
  {
    familyKey: "origin_storage_activation",
    workflowType: "storage_activation",
    displayName: "Origin Storage Activation",
    branch: "Origin Storage Activation",
    expectedReferencePattern: "Storage customer invoice + JD<Deal> + GD<Deal>",
    firstExpectedTrigger: "Authenticated AP event for an exact named origin-storage activation source.",
    partyAndAccountRules: (rules) => ({ customer: "allocated Xero customer", transportSupplierAccount: rules.accounts.jdTransport, storageSupplierAccount: rules.accounts.gdStorage }),
    calculationRules: (rules) => ({ itemCodes: [rules.itemCodes.jd20, rules.itemCodes.jd40, rules.itemCodes.gd20, rules.itemCodes.gd40], customerStorageGst: "PENDING_CONFIGURATION", supplierPoGst: "GST_EXCLUSIVE", rateSources: "configured 20/40-foot storage and transport rates or mapped source values" }),
    conditionPayloadContract: "Exact Deal/Container Control, Date In, origin-storage stage, 20/40-foot type, customer, transport supplier, storage supplier and mapped rates. No Draft payload can be prepared until customer-storage GST and numbering configuration is resolved.",
  },
  {
    familyKey: "destination_storage_activation",
    workflowType: "storage_activation",
    displayName: "Destination Storage Activation",
    branch: "Destination Storage Activation",
    expectedReferencePattern: "Storage customer invoice + JD<Deal> + GD<Deal>",
    firstExpectedTrigger: "Authenticated AP event for an exact named destination-storage activation source.",
    partyAndAccountRules: (rules) => ({ customer: "allocated Xero customer", transportSupplierAccount: rules.accounts.jdTransport, storageSupplierAccount: rules.accounts.gdStorage }),
    calculationRules: (rules) => ({ itemCodes: [rules.itemCodes.jd20, rules.itemCodes.jd40, rules.itemCodes.gd20, rules.itemCodes.gd40], customerStorageGst: "PENDING_CONFIGURATION", supplierPoGst: "GST_EXCLUSIVE", rateSources: "configured 20/40-foot storage and transport rates or mapped source values" }),
    conditionPayloadContract: "Exact Deal/Container Control, Date In, destination-storage stage, 20/40-foot type, customer, transport supplier, storage supplier and mapped rates. No Draft payload can be prepared until customer-storage GST and numbering configuration is resolved.",
  },
  {
    familyKey: "recurring_storage",
    workflowType: "recurring_storage",
    displayName: "Recurring Storage",
    branch: "Recurring Storage",
    expectedReferencePattern: "Storage customer invoice + GD<Deal>; no recurring JD PO",
    firstExpectedTrigger: "Disabled monthly AP schedule definition; no task is registered until a later approved activation.",
    apScheduleDefinition: "Disabled monthly definition: 0 0 0 1 * * (no task UID registered)",
    partyAndAccountRules: (rules) => ({ customer: "allocated Xero customer", storageSupplierAccount: rules.accounts.gdStorage }),
    calculationRules: (rules) => ({ itemCodes: [rules.itemCodes.gd20, rules.itemCodes.gd40], customerStorageGst: "PENDING_CONFIGURATION", supplierPoGst: "GST_EXCLUSIVE", noRecurringJdPo: true }),
    conditionPayloadContract: "Exact active storage source with customer and storage supplier. The disabled schedule must preflight one due record at a time, exclude recurring JD POs and never bulk-replay history.",
  },
  {
    familyKey: "storage_finalisation_recovery",
    workflowType: "storage_finalisation",
    displayName: "Storage Finalisation / Recovery",
    branch: "Storage Finalisation / Recovery",
    expectedReferencePattern: "Existing Draft storage customer invoice only",
    firstExpectedTrigger: "Authenticated AP event after a named storage finalisation/recovery condition is verified.",
    partyAndAccountRules: () => ({ party: "existing customer invoice contact", accountCode: "existing Draft document only" }),
    calculationRules: () => ({ action: "update_draft only", nonDraftHandling: "hold and exception", recoveryHandling: "separate approved review" }),
    conditionPayloadContract: "Exact storage billing event ID, final period, Date Out and current statuses for all related documents. Existing non-Draft documents are never amended or recovered automatically.",
  },
  {
    familyKey: "main_customer_invoice",
    workflowType: "main_customer_invoice",
    displayName: "Main Customer Invoice",
    branch: "Main Customer Invoice",
    expectedReferencePattern: "INV-<Deal digits>",
    firstExpectedTrigger: "Authenticated AP event for a named Deal with current Quote Service lines.",
    partyAndAccountRules: () => ({ party: "organisation-first Xero customer match", accountCode: "from current Quote Service lines" }),
    calculationRules: (rules) => ({ gstTreatment: "GST_EXCLUSIVE", lineSource: "current Quote Service lines", defaultGstRatePercent: rules.defaults.gstRatePercent }),
    conditionPayloadContract: "Exact Deal, Xero customer, quote number and current Quote Service lines. AP validates the exact INV reference and Draft state before preparing a Draft-only payload.",
  },
  {
    familyKey: "deposit_invoice",
    workflowType: "deposit_invoice",
    displayName: "Deposit Invoice",
    branch: "Deposit Invoice",
    expectedReferencePattern: "INV-<Deal digits>-D",
    firstExpectedTrigger: "Authenticated AP event where Deposit Status is blank/Pending and Deposit Amount Required is positive.",
    partyAndAccountRules: () => ({ party: "allocated Xero customer", accountCode: "deposit item mapping" }),
    calculationRules: (rules) => ({ itemCode: rules.itemCodes.deposit, gstTreatment: "GST_INCLUSIVE", quantity: 1, amountSource: "depositAmountRequired" }),
    conditionPayloadContract: "Exact Deal, customer, positive deposit amount and permitted deposit status. Any non-Draft main invoice conflict remains held; no existing non-Draft invoice is amended.",
  },
  {
    familyKey: "final_weight_overweight",
    workflowType: "final_weight_adjustment",
    displayName: "Final Weight — Overweight",
    branch: "Final Weight — Overweight",
    expectedReferencePattern: "Existing Draft INV-<Deal digits> adjustment only",
    firstExpectedTrigger: "Authenticated AP event with OVERWEIGHT direction and a positive excess-weight amount.",
    partyAndAccountRules: () => ({ party: "existing main-invoice customer", accountCode: "mapped source account" }),
    calculationRules: (rules) => ({ itemCode: rules.itemCodes.overweight, gstTreatment: "GST_EXCLUSIVE", action: "update_draft only", amountSource: "excessWeightAmountExGst" }),
    conditionPayloadContract: "Exact Deal, existing main invoice reference/status, OVERWEIGHT direction and positive excess-weight amount. A non-Draft invoice always creates a local hold, never a new invoice.",
  },
  {
    familyKey: "final_weight_underweight",
    workflowType: "final_weight_adjustment",
    displayName: "Final Weight — Underweight",
    branch: "Final Weight — Underweight",
    expectedReferencePattern: "Existing Draft INV-<Deal digits> due-date adjustment only",
    firstExpectedTrigger: "Authenticated AP event with UNDERWEIGHT direction and a valid due date.",
    partyAndAccountRules: () => ({ party: "existing main-invoice customer", accountCode: "no new line/account" }),
    calculationRules: () => ({ action: "update_draft due date only", negativeLineCreation: false, newInvoiceCreation: false }),
    conditionPayloadContract: "Exact Deal, existing main invoice reference/status, UNDERWEIGHT direction and due date. A non-Draft invoice remains held and no negative line or replacement invoice is proposed.",
  },
  {
    familyKey: "extra_hire",
    workflowType: "extra_hire",
    displayName: "Extra Hire",
    branch: "Extra Hire",
    expectedReferencePattern: "INV-<Deal digits>-<next numeric suffix excluding -D>",
    firstExpectedTrigger: "Authenticated AP event after exact extra-hire eligibility and successful document handling preflight.",
    partyAndAccountRules: (rules) => ({ party: "allocated Xero customer", accountCode: rules.accounts.extraHire }),
    calculationRules: (rules) => ({ itemCodes: [rules.itemCodes.extraHire20, rules.itemCodes.extraHire40], gstTreatment: "GST_EXCLUSIVE", quantity: rules.defaults.extraHireWeeks, rateSource: "configured 20/40-foot weekly extra-hire rate", hireDateRollForward: "only after successful document handling" }),
    conditionPayloadContract: "Exact Deal, customer, 30-day hire duration, current hire end date, container number/type and reference preflight. The hire date never rolls forward based on a failed or blocked proposal.",
  },
  {
    familyKey: "warranty_customer_invoice_and_aviso_po",
    workflowType: "warranty_reconciliation",
    displayName: "Warranty Customer Invoice and Aviso PO",
    branch: "Warranty Customer Invoice and Aviso PO",
    expectedReferencePattern: "INV-<Deal digits> or Draft suffix + I<Deal> Aviso PO",
    firstExpectedTrigger: "Authenticated AP event for a named Deal with an Added Services warranty mapping.",
    partyAndAccountRules: (rules) => ({ customer: "allocated Xero customer", avisoSupplier: rules.warranty.supplierName, avisoAccountCode: rules.warranty.accountCode }),
    calculationRules: () => ({ warrantySource: "Added Services only; Warranty Confirmed is ignored", gstTreatment: "GST_EXCLUSIVE", action: "Draft main invoice update or Draft suffix only" }),
    conditionPayloadContract: "Exact Deal, customer, Added Services value and complete warranty item/description/premium mapping. A non-Draft main invoice uses a separate Draft suffix and never replaces the existing invoice.",
  },
] as const;

export type ReleaseReadiness = {
  xero: FinancialXeroConnectionTest;
  vtiger: VtigerFinancialConnectionTest;
};

export type LegacyWriterInventory = {
  familyKey: string;
  legacyWriterIdentifier: string;
  legacyWriterOwner: string;
  legacyDisableAction: string;
};

/** AP-local documentation only. This data never contacts or changes any external writer. */
export const FINANCIAL_LEGACY_WRITER_INVENTORY: readonly LegacyWriterInventory[] = [
  { familyKey: "initial_container_control_asset", legacyWriterIdentifier: "VTiger Container Control REQUEST workflow action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-cc-created", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "In VTiger, pause this shared REQUEST financial webhook action only during approved shared Container Control cutover; preserve configuration for rollback." },
  { familyKey: "initial_container_control_customer_sale", legacyWriterIdentifier: "Same shared VTiger Container Control REQUEST action", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Same; Asset, Customer Sale and For Hire must be cut over together unless VTiger source actions are split." },
  { familyKey: "initial_container_control_for_hire", legacyWriterIdentifier: "Same shared VTiger Container Control REQUEST action", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Same." },
  { familyKey: "recurring_for_hire", legacyWriterIdentifier: "Operations Heartbeat forHireMonthlyPo; task UID PtaAhkr5tHtixG7E4DTZhC; /api/scheduled/forHireMonthlyPo", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Disable/pause this Operations Heartbeat immediately before enabling the approved AP recurring-for-hire task; retain paused for rollback." },
  { familyKey: "origin_storage_activation", legacyWriterIdentifier: "Shared VTiger storage action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-storage", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause old shared storage action during approved joint Origin/Destination AP handover; retain paused for rollback." },
  { familyKey: "destination_storage_activation", legacyWriterIdentifier: "Same shared VTiger storage action", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Same." },
  { familyKey: "recurring_storage", legacyWriterIdentifier: "Operations Heartbeat storage-monthly-billing; task UID 4rB9Yofib8MRLRbijj4z9k; /api/scheduled/storageMonthlyBilling", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Disable/pause this Operations Heartbeat immediately before enabling approved AP recurring-storage task; retain paused for rollback." },
  { familyKey: "storage_finalisation_recovery", legacyWriterIdentifier: "VTiger finalisation action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-finalise-storage", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause old finalisation action during approved AP finalisation cutover; retain paused." },
  { familyKey: "main_customer_invoice", legacyWriterIdentifier: "VTiger main action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-main-invoice; confirm legacy Make main writer remains paused", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause/redirect only this AP-equivalent action after exact approval; confirm Make remains paused." },
  { familyKey: "deposit_invoice", legacyWriterIdentifier: "VTiger deposit action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-deposit-invoice; confirm legacy Make deposit writer remains paused", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause/redirect only after exact approval; confirm Make remains paused." },
  { familyKey: "final_weight_overweight", legacyWriterIdentifier: "VTiger action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-finalise-main-invoice", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause/redirect only after exact Draft-main-invoice cutover approval." },
  { familyKey: "final_weight_underweight", legacyWriterIdentifier: "VTiger action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-finalise-main-invoice-underweight", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause/redirect only after exact Draft-main-invoice cutover approval." },
  { familyKey: "extra_hire", legacyWriterIdentifier: "VTiger action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-extra-hire-invoice", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause/redirect only after exact invoice + Hire End Date cutover approval." },
  { familyKey: "warranty_customer_invoice_and_aviso_po", legacyWriterIdentifier: "VTiger action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-warranty-reconcile, plus Main Customer Invoice warranty entry path", legacyWriterOwner: "ContainerZone Operations / IT", legacyDisableAction: "Pause/redirect only after coordinated warranty/main-invoice cutover approval; preserve shared warranty ledger." },
] as const;

export const FINANCIAL_CUTOVER_EXCLUSIONS = [
  "xero-receivables-hourly — Operations task UID 9Mee6XbbAbx7dQRFHo3FCk",
  "containerzone-monthly-underwriting-declaration — Operations task UID cDiqD3PQ3zXMDKAT5Z4zwm",
  "/api/webhooks/vtiger-storage-import",
  "/api/webhooks/vtiger-initialise-hire-end-date",
] as const;

export function frozenRuleVersion(rules: FinancialAutomationRules): string {
  return `rules-${createHash("sha256").update(JSON.stringify(rules)).digest("hex").slice(0, 16)}`;
}

export function releaseEndpointIdentifier(familyKey: string): string {
  return `${DISABLED_RELEASE_ENDPOINT.replace(":family", familyKey)}; financial writer execution lock active`;
}

export function releaseAuthenticationDescription(): string {
  return SHADOW_AUTH;
}

export function releaseRollbackPlan(): string {
  return DEFAULT_ROLLBACK;
}

export function releaseFamilyStatus(input: {
  candidateOutcome?: "found" | "no_current_candidate" | "blocked" | "not_run";
  confirmedShadowTestId: number | null;
  xeroOutcome: FinancialXeroConnectionTest["outcome"];
  vtigerOutcome: VtigerFinancialConnectionTest["outcome"];
  hasLegacyWriterInventory: boolean;
  hasCurrentDocumentManifest: boolean;
  hasDisabledPostSuccessMapping?: boolean;
  evidenceFresh?: boolean;
}): { status: "included" | "held" | "no_current_candidate"; reason: string } {
  if (input.candidateOutcome === "no_current_candidate") {
    return { status: "no_current_candidate", reason: "NO_CURRENT_CANDIDATE: the bounded current discovery found no eligible source/period. This is factual readiness evidence, not a failure or inferred pass." };
  }
  const reasons: string[] = [];
  if (input.candidateOutcome === "blocked") reasons.push("Current candidate discovery is blocked by AP-side mapping or read-only source access.");
  if (input.candidateOutcome === "not_run") reasons.push("No bounded current candidate discovery has been run for this family.");
  if (input.xeroOutcome !== "passed") reasons.push("AP Management Xero GET-only tenant readiness is not passing.");
  if (input.vtigerOutcome !== "passed") reasons.push("AP Management VTiger authenticated exact-read readiness is not passing.");
  if (!input.confirmedShadowTestId) reasons.push("No exact named reviewer-confirmed shadow test exists for this family branch.");
  if (input.evidenceFresh === false) reasons.push("Source, rules or Xero preflight evidence is stale and requires a fresh candidate test.");
  if (!input.hasLegacyWriterInventory) reasons.push("The overlapping Operations/VTiger/Make writer and exact disable action are not documented.");
  if (!input.hasCurrentDocumentManifest) reasons.push("No complete current due/queued Draft document manifest is available.");
  if (input.hasDisabledPostSuccessMapping === false) reasons.push("Disabled VTiger post-success field and assigned-user mapping is not yet validated by GET-only metadata.");
  if (reasons.length === 0) return { status: "included", reason: "All mandatory release gates passed; still awaiting a final user approval before activation." };
  return { status: "held", reason: `Held — ${reasons.join(" ")}` };
}
