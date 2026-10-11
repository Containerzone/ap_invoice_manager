import { financialSha256 } from "./financialProposalIntegrity";
import { getWarrantyDealClaim, getWarrantyExecutionEntries, recordWarrantyPreview, reserveWarranty } from "./financialWarrantyAvisoDb";
import { assertWarrantyRelease, getWarrantyReleasePolicy } from "./financialWarrantyAvisoRelease";
import { readWarrantyFacts } from "./financialWarrantyAvisoSource";
import { readWarrantyXeroEvidence } from "./financialWarrantyAvisoXero";
import { buildWarrantyPlan, WARRANTY_RULES_HASH, type WarrantyFacts, type WarrantyPlan, type WarrantyXeroEvidence } from "./financialWarrantyAvisoRules";
import { executeWarrantyPair } from "./financialWarrantyAvisoWriter";
export const WARRANTY_WEBHOOK_PATH = "/api/webhooks/vtiger/warranty-aviso";
export async function previewWarrantyAviso(dealId: string) {
  const policy = await getWarrantyReleasePolicy();
  let facts: WarrantyFacts;
  try { facts = await readWarrantyFacts(dealId, policy.sourceConfig); }
  catch (error) {
    facts = { dealId, dealNumber: "", addedServices: "", customerVtigerId: "", customerName: "", customerKind: "organisation", sourceModifiedAt: null, customerModifiedAt: null,
      issueDate: null, dueDate: null, sourceMappingsHash: "", addedServicesMappingHash: "", mapping: null, configurationRequired: ["Authenticated current Potentials/source/customer metadata and approved exact nonsecret source mapping"],
      holdReason: error instanceof Error ? error.message : "Current warranty source could not be verified." };
  }
  let evidence: WarrantyXeroEvidence | null = null; let plan: WarrantyPlan | null = null;
  let reason = facts.holdReason ?? (!policy.sourceConfig ? "Warranty source configuration absent/unproven; no custom labels/API names or premium will be guessed." : null);
  if (!reason && policy.sourceConfig) {
    try { evidence = await readWarrantyXeroEvidence(facts); plan = buildWarrantyPlan(facts, evidence, policy.sourceConfig);
      if (facts.sourceMappingsHash !== policy.sourceMappingsHash || facts.addedServicesMappingHash !== policy.addedServicesMappingHash) reason = "Source/Added Services mapping hashes not explicitly approved.";
      else if (evidence.configurationHash !== policy.xeroConfigurationHash || evidence.supplier.ContactID !== policy.avisoContactId) reason = "Current exact Aviso contact/item/account/tax evidence hash not explicitly approved.";
      const claim = await getWarrantyDealClaim(facts.dealNumber);
      if (claim) reason = "This Deal already has an immutable AP warranty claim; no adoption, repeat amendment or duplicate PO retry.";
    } catch (error) { reason = error instanceof Error ? error.message : "Warranty Xero preflight held."; }
  }
  const event = await recordWarrantyPreview(facts, evidence, plan, reason);
  return { state: reason ? "held" as const : "previewed" as const, holdReason: reason, facts, evidence, plan, eventId: event.id,
    sourceSnapshotHash: financialSha256(facts), xeroPreflightHash: evidence ? financialSha256(evidence) : null, noWrites: true as const };
}
/** Only invoked after dedicated flag/policy gate; each execution re-describes/retrieves exact current source and re-GETs all exact candidates. */
export async function processAutomaticWarrantyAviso(dealId: string) {
  const policy = await getWarrantyReleasePolicy(); assertWarrantyRelease(policy);
  const preview = await previewWarrantyAviso(dealId);
  if (preview.facts.dealNumber) {
    const claim = await getWarrantyDealClaim(preview.facts.dealNumber);
    if (claim) {
      const entries = claim.executionGroup ? await getWarrantyExecutionEntries(claim.executionGroup) : [];
      return { ok: false, status: entries.some(e => e.status === "drafts_created") ? "duplicate_replay" as const : "reconciliation_required" as const,
        warning: "Immutable warranty claim already exists; no financial operations or retries.", xeroWritesAttempted: 0 };
    }
  }
  if (preview.state !== "previewed" || !preview.plan || !preview.evidence || !preview.facts.sourceModifiedAt || Date.parse(preview.facts.sourceModifiedAt) < Date.parse(policy.effectiveFrom!))
    return { ok: false, status: "held" as const, warning: preview.holdReason ?? "Source predates approved New Events cutover or exact current Draft preflight is incomplete.", xeroWritesAttempted: 0 };
  // Re-read the insert-only evidence entry, then atomically reserve the one Deal lifetime claim.
  const { getWarrantyEvent } = await import("./financialWarrantyAvisoDb");
  const event = await getWarrantyEvent(preview.eventId);
  if (!event) throw new Error("Warranty immutable evidence missing; no execution.");
  let reservation;
  try { reservation = await reserveWarranty(event, policy, preview.plan); }
  catch { return { ok: false, status: "held" as const, warning: "Warranty immutable claim could not be exclusively reserved; reconcile rather than retry.", xeroWritesAttempted: 0 }; }
  return executeWarrantyPair(reservation, preview.plan, policy.approvedBy!);
}
export async function getWarrantyReadiness() {
  const policy = await getWarrantyReleasePolicy(); let releaseReady = false; let holdReason: string | null = null;
  try { assertWarrantyRelease(policy); releaseReady = true; } catch (e) { holdReason = e instanceof Error ? e.message : "Warranty release held."; }
  return { module: "Potentials", webhookPath: WARRANTY_WEBHOOK_PATH, ruleHash: WARRANTY_RULES_HASH, flagEnabled: process.env.FINANCIAL_WARRANTY_AUTOMATIC_ENABLED === "true",
    writerEnabled: releaseReady, policy, holdReason, migrationApplication: "Additive AP-local warranty ledger migration 0045 is applied; release policy and writer gate remain disabled.",
    configurationRequired: policy.sourceConfig ? [] : ["Unproven actual Added Services API name/full picklist metadata and one approved WAR description/exclusive premium mapping", "Issue/due source semantics, customer field metadata and source timestamp timezone", "Current exact Xero Aviso/account/item/10% GST evidence hash"],
    legacyWriterInventory: "VTiger action → https://supplycrm-7kuu33x8.manus.space/api/webhooks/vtiger-warranty-reconcile, plus Main Customer Invoice warranty entry path",
    noWrites: true as const };
}
