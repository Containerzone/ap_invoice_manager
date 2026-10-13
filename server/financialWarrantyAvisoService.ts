import { financialSha256 } from "./financialProposalIntegrity";
import { getWarrantyDealClaim, getWarrantyExecutionEntries, recordWarrantyPreview, reserveWarranty } from "./financialWarrantyAvisoDb";
import { assertWarrantyRelease, getWarrantyReleasePolicy } from "./financialWarrantyAvisoRelease";
import { readWarrantyFacts } from "./financialWarrantyAvisoSource";
import { readWarrantyXeroEvidence } from "./financialWarrantyAvisoXero";
import { buildWarrantyPlan, WARRANTY_RULES_HASH, type WarrantyFacts, type WarrantyPlan, type WarrantyXeroEvidence } from "./financialWarrantyAvisoRules";
import { executeWarrantyPair } from "./financialWarrantyAvisoWriter";
import { executeCustomerContactCreationV2, previewCustomerContactResolution, type CustomerContactPlan } from "./financialCustomerContactServiceV2";
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";

export const WARRANTY_WEBHOOK_PATH = "/api/webhooks/vtiger/warranty-aviso";

type WarrantyPreview = Awaited<ReturnType<typeof previewWarrantyAviso>>;

/**
 * Customer contact work is always planned by the shared v2 resolver. A browser
 * preview remains GET-only; it may show `would_create` but cannot create a
 * Xero contact. Automatic processing is the only path that can execute the
 * separately gated, idempotent creation before a fresh full Draft preflight.
 */
export async function previewWarrantyAviso(dealId: string) {
  const policy = await getWarrantyReleasePolicy();
  let facts: WarrantyFacts;
  try { facts = await readWarrantyFacts(dealId, policy.sourceConfig); }
  catch (error) {
    facts = { dealId, dealNumber: "", addedServices: "", customerVtigerId: "", customerName: "", customerKind: "organisation", sourceModifiedAt: null, customerModifiedAt: null,
      issueDate: null, dueDate: null, sourceMappingsHash: "", addedServicesMappingHash: "", mapping: null, configurationRequired: ["Authenticated current Potentials/source/customer metadata and approved exact nonsecret source mapping"],
      holdReason: error instanceof Error ? error.message : "Current warranty source could not be verified." };
  }
  let evidence: WarrantyXeroEvidence | null = null;
  let plan: WarrantyPlan | null = null;
  let contactPlan: CustomerContactPlan | null = null;
  let reason = facts.holdReason ?? (!policy.sourceConfig ? "Warranty source configuration absent/unproven; no custom labels/API names or premium will be guessed." : null);
  if (!reason && policy.sourceConfig) {
    try {
      const currentCustomer = await readCurrentCustomerContactResolution(dealId);
      if (currentCustomer.name !== facts.customerName) {
        reason = "Current Warranty customer identity differs from the shared customer-contact source; no contact or Draft will be selected.";
      } else {
        contactPlan = await previewCustomerContactResolution(currentCustomer);
        if (contactPlan.status === "held") reason = contactPlan.holdReason ?? "Current Xero customer contact is held.";
        else if (contactPlan.status === "would_create") reason = "Exact Xero customer contact is missing; automatic creation is required before the Warranty Draft pair can be preflighted.";
        else {
          evidence = await readWarrantyXeroEvidence(facts, { customerContactId: contactPlan.contactId });
          plan = buildWarrantyPlan(facts, evidence, policy.sourceConfig);
          if (facts.sourceMappingsHash !== policy.sourceMappingsHash || facts.addedServicesMappingHash !== policy.addedServicesMappingHash) reason = "Source/Added Services mapping hashes not explicitly approved.";
          else if (evidence.configurationHash !== policy.xeroConfigurationHash || evidence.supplier.ContactID !== policy.avisoContactId) reason = "Current exact Aviso contact/item/account/tax evidence hash not explicitly approved.";
          const claim = await getWarrantyDealClaim(facts.dealNumber);
          if (claim) reason = "This Deal already has an immutable AP warranty claim; no adoption, repeat amendment or duplicate PO retry.";
        }
      }
    } catch (error) { reason = error instanceof Error ? error.message : "Warranty customer/Xero preflight held."; }
  }
  const event = await recordWarrantyPreview(facts, evidence, plan, reason);
  return {
    state: reason ? "held" as const : "previewed" as const,
    holdReason: reason,
    facts,
    contactPlan,
    evidence,
    plan,
    eventId: event.id,
    sourceSnapshotHash: financialSha256(facts),
    xeroPreflightHash: evidence ? financialSha256(evidence) : null,
    noWrites: true as const,
  };
}

function retainedClaimResult(preview: WarrantyPreview, entries: Array<{ status: string }>) {
  return {
    ok: false,
    status: entries.some(entry => entry.status === "drafts_created") ? "duplicate_replay" as const : "reconciliation_required" as const,
    warning: "Immutable warranty claim already exists; no financial operations or retries.",
    xeroWritesAttempted: 0,
    contactWritesAttempted: 0,
  };
}

/** Only invoked after dedicated flag/policy gate; every execution reads current source and full Xero evidence again. */
export async function processAutomaticWarrantyAviso(dealId: string) {
  const policy = await getWarrantyReleasePolicy();
  assertWarrantyRelease(policy);
  let preview = await previewWarrantyAviso(dealId);
  let contactWritesAttempted: 0 | 1 = 0;

  // A missing contact is the only preview hold that can proceed. The shared v2
  // resolver rechecks VTiger and Xero immediately before any Contact POST.
  if (preview.contactPlan?.status === "would_create") {
    const contact = await executeCustomerContactCreationV2(preview.contactPlan);
    contactWritesAttempted = contact.contactWritesAttempted;
    if (contact.status !== "created" && contact.status !== "matched") {
      return { ok: false, status: contact.status === "reconciliation_required" ? "reconciliation_required" as const : "held" as const,
        warning: contact.holdReason ?? "Warranty customer contact could not be resolved safely.", xeroWritesAttempted: contactWritesAttempted, contactWritesAttempted };
    }
    // A contact creation never authorizes the pair. Re-read current source,
    // contact, native items, accounts, tax, collisions and exact main Draft.
    preview = await previewWarrantyAviso(dealId);
  }

  if (preview.facts.dealNumber) {
    const claim = await getWarrantyDealClaim(preview.facts.dealNumber);
    if (claim) {
      const entries = claim.executionGroup ? await getWarrantyExecutionEntries(claim.executionGroup) : [];
      return retainedClaimResult(preview, entries);
    }
  }
  if (preview.state !== "previewed" || !preview.plan || !preview.evidence || !preview.facts.sourceModifiedAt || Date.parse(preview.facts.sourceModifiedAt) < Date.parse(policy.effectiveFrom!)) {
    return { ok: false, status: "held" as const, warning: preview.holdReason ?? "Source predates approved New Events cutover or exact current Draft preflight is incomplete.", xeroWritesAttempted: contactWritesAttempted, contactWritesAttempted };
  }
  const { getWarrantyEvent } = await import("./financialWarrantyAvisoDb");
  const event = await getWarrantyEvent(preview.eventId);
  if (!event) throw new Error("Warranty immutable evidence missing; no execution.");
  let reservation;
  try { reservation = await reserveWarranty(event, policy, preview.plan); }
  catch { return { ok: false, status: "held" as const, warning: "Warranty immutable claim could not be exclusively reserved; reconcile rather than retry.", xeroWritesAttempted: contactWritesAttempted, contactWritesAttempted }; }
  const result = await executeWarrantyPair(reservation, preview.plan, policy.approvedBy!);
  if (result.ok) return { ...result, xeroWritesAttempted: (result.xeroWritesAttempted ?? 0) + contactWritesAttempted, contactWritesAttempted };
  return { ...result, xeroWritesAttemptedUpperBound: (result.xeroWritesAttemptedUpperBound ?? 0) + contactWritesAttempted, contactWritesAttempted };
}

export async function getWarrantyReadiness() {
  const policy = await getWarrantyReleasePolicy();
  let releaseReady = false;
  let holdReason: string | null = null;
  try { assertWarrantyRelease(policy); releaseReady = true; } catch (error) { holdReason = error instanceof Error ? error.message : "Warranty release held."; }
  return { module: "Potentials", webhookPath: WARRANTY_WEBHOOK_PATH, ruleHash: WARRANTY_RULES_HASH, flagEnabled: process.env.FINANCIAL_WARRANTY_AUTOMATIC_ENABLED === "true",
    writerEnabled: releaseReady, policy, holdReason, migrationApplication: "Additive AP-local warranty ledger migration 0045 is applied; release policy and writer gate remain disabled.",
    configurationRequired: policy.sourceConfig ? [] : ["Verified Potentials Added Services multipicklist metadata and all ten exact WAR mappings", "Issue/due source semantics, customer field metadata and source timestamp timezone", "Current exact Xero Aviso/account/item/10% GST evidence hash"],
    legacyWriterInventory: "VTiger action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-warranty-reconcile, plus Main Customer Invoice warranty entry path",
    noWrites: true as const };
}
