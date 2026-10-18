import { randomUUID } from "node:crypto";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { readFinalWeightFacts } from "./financialFinalWeightAdjustmentSource";
import { readFinalWeightXeroEvidence } from "./financialReadOnlyXeroService";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { buildFinalWeightAdjustment, finalWeightSourceHold, prepareFinalWeightPayload, FINAL_WEIGHT_PATHS, FINAL_WEIGHT_RULES_HASH, FINAL_WEIGHT_RULES_VERSION, type FinalWeightDirection, type FinalWeightXeroEvidence } from "./financialFinalWeightAdjustmentRules";
import { bindFinalWeightPayload, claimFinalWeightEvent, completeFinalWeightEvent, getFinalWeightClaim, holdFinalWeightEvent, recordFinalWeightEvidence } from "./financialFinalWeightAdjustmentDb";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { processAutomaticBillingPartySync } from "./financialBillingPartySyncService";
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";
import { previewCustomerContactResolution } from "./financialCustomerContactServiceV2";

/** Administrator preview is entirely non-persistent: no ledger/execution/policy mutation. */
export async function previewFinalWeightAdjustment(dealId: string, direction: FinalWeightDirection, expectedDealNumber?: string) {
  const facts = await readFinalWeightFacts(dealId, direction);
  if (expectedDealNumber && facts.dealNumber.toUpperCase() !== expectedDealNumber.toUpperCase()) throw new Error("Current exact Deal no longer matches its D-number lookup.");
  const sourceHash = sourceSnapshotHash({ ...facts, direction, rulesVersion: FINAL_WEIGHT_RULES_VERSION });
  let xero: FinalWeightXeroEvidence | null = null;
  let readHold: string | null = null;
  if (!finalWeightSourceHold(facts, direction)) {
    try { xero = await readFinalWeightXeroEvidence(`INV-${facts.dealNumber.slice(1)}`, facts.customerName, direction, { skipCustomerMatch: true }); }
    catch (error) { readHold = error instanceof Error ? error.message : "Exact Xero GET-only preflight unavailable."; }
  }
  const preview = buildFinalWeightAdjustment(facts, direction, xero);
  const holdReason = readHold ?? preview.holdReason;
  return { facts, direction, preview, xero, sourceSnapshotHash: sourceHash, rulesSnapshotHash: FINAL_WEIGHT_RULES_HASH,
    xeroPreflightHash: xero ? financialSha256(xero) : null, state: holdReason ? "held" as const : "previewed" as const, holdReason, noWrites: true as const };
}
export function finalWeightClaimHold(claim: { direction: string; status: string } | null, direction: FinalWeightDirection) {
  if (!claim) return null;
  return `Exact main invoice is exclusively claimed by ${claim.direction} (${claim.status}); ${direction} cannot reserve or replay another amendment. Reconcile without clearing claims.`;
}
/** Dedicated dual-direction receivers only; gate asserts before source or any evidence write. */
export async function processAutomaticFinalWeightAdjustment(dealId: string, direction: FinalWeightDirection) {
  const policy = await getFinalWeightReleasePolicy(); assertFinalWeightRelease(policy, direction);
  let result = await previewFinalWeightAdjustment(dealId, direction);
  let billingWrites = 0;
  let holdReason = result.holdReason;
  if (!holdReason && (!result.facts.sourceRefreshedAt || Date.parse(result.facts.sourceRefreshedAt) < Date.parse(policy.effectiveFrom!))) holdReason = "Current Deal final-weight source predates approved new-events-only cutover; reconcile historical events separately.";
  if (!holdReason && result.preview.invoiceId && result.preview.invoiceNumber) {
    holdReason = finalWeightClaimHold(await getFinalWeightClaim(dealId, result.preview.invoiceId, result.preview.invoiceNumber), direction);
  }
  // Billing changes are a separate exact-current Draft-only action. Historical,
  // non-Draft and already claimed final-weight events cannot use this hook.
  if (!holdReason && process.env.FINANCIAL_BILLING_PARTY_SYNC_ENABLED === "true") {
    const billing = await processAutomaticBillingPartySync(dealId, "main_invoice_finalisation");
    billingWrites = billing.xeroWritesAttempted;
    if (!["unchanged", "updated"].includes(billing.status)) {
      holdReason = "warning" in billing && billing.warning ? billing.warning : `Current Deal billing-party sync is ${billing.status}; main finalisation is held.`;
    } else {
      result = await previewFinalWeightAdjustment(dealId, direction);
      holdReason = result.holdReason;
      if (!holdReason && (!result.facts.sourceRefreshedAt || Date.parse(result.facts.sourceRefreshedAt) < Date.parse(policy.effectiveFrom!))) holdReason = "Current Deal changed outside the final-weight cutover during billing refresh.";
      if (!holdReason && result.preview.invoiceId && result.preview.invoiceNumber) holdReason = finalWeightClaimHold(await getFinalWeightClaim(dealId, result.preview.invoiceId, result.preview.invoiceNumber), direction);
      if (!holdReason) {
        const currentParty = await readCurrentCustomerContactResolution(dealId);
        const currentPlan = await previewCustomerContactResolution(currentParty);
        if (!billing.contactId || !billing.sourceSnapshotHash || currentParty.sourceSnapshotHash !== billing.sourceSnapshotHash ||
          currentPlan.status !== "matched" || currentPlan.contactId !== billing.contactId ||
          result.xero?.invoice?.Contact?.ContactID !== billing.contactId) {
          holdReason = "Current Deal billing party changed again during main finalisation; no stale-party amendment will be sent.";
        }
      }
    }
  }
  const event = await recordFinalWeightEvidence({ ...result, holdReason });
  if (holdReason || !result.preview.eligible || !result.xeroPreflightHash) return { ok: false, status: "held" as const, eventId: event.id, recordId: dealId, direction, warning: holdReason ?? "Current final-weight evidence held.", xeroWritesAttempted: billingWrites };
  const token = randomUUID();
  if (!await claimFinalWeightEvent(event.id, token, result.sourceSnapshotHash, result.xeroPreflightHash)) return { ok: false, status: "held" as const, eventId: event.id, recordId: dealId, direction, warning: "Per-document final-weight reservation collision or stale immutable evidence; no further write.", xeroWritesAttempted: billingWrites };
  try {
    const payload = prepareFinalWeightPayload(result.preview, result.sourceSnapshotHash);
    await bindFinalWeightPayload(event.id, token, policy.releaseKey, payload);
    const outcome = await executeGuardedFinancialWriterCommand({ workflowType: "final_weight_adjustment", proposedAction: "update_draft", payload,
      preparedBy: policy.approvedBy!, expectedFinalWeightDraft: result.preview.expectedDraft!,
      authorisation: { workflowType: "final_weight_adjustment", approvalReference: policy.releaseKey, globalShadowMode: false, familyLiveEnabled: true,
        releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true,
        finalWeightAutomaticEventId: event.id, finalWeightDirection: direction, finalWeightReleaseKey: policy.releaseKey, finalWeightApprovedBy: policy.approvedBy! } });
    if (outcome.outcome !== "succeeded") {
      await holdFinalWeightEvent(event.id, token, "Final-weight execution requires exact reconciliation; exclusive claim and payload remain consumed, never blind retry.");
      return { ok: false, status: "reconciliation_required" as const, recordId: dealId, eventId: event.id, direction, warning: "Inspect immutable execution evidence before reconciliation; no automatic retry." };
    }
    await completeFinalWeightEvent(event.id, token, outcome.executionId, { ...outcome.result, expectedDraftHash: financialSha256(result.preview.expectedDraft), exactReadbackVerified: true });
    return { ok: true, status: "draft_updated" as const, recordId: dealId, eventId: event.id, direction, invoiceNumber: outcome.result.documentNumber, invoiceId: outcome.result.xeroDocumentId, xeroWritesAttempted: billingWrites + 1 };
  } catch (error) {
    await holdFinalWeightEvent(event.id, token, error instanceof Error ? error.message : "Final-weight amendment held for reconciliation.");
    throw error;
  }
}
export async function getFinalWeightReadiness() {
  const policy = await getFinalWeightReleasePolicy();
  const branches = (["overweight", "underweight"] as const).map(direction => {
    let releaseHoldReason: string | null = null;
    try { assertFinalWeightRelease(policy, direction); } catch (error) { releaseHoldReason = error instanceof Error ? error.message : "Release disabled."; }
    return { direction, webhookPath: FINAL_WEIGHT_PATHS[direction], writerEnabled: !releaseHoldReason, releaseHoldReason };
  });
  return { module: "Potentials", branches, rulesHash: FINAL_WEIGHT_RULES_HASH, policy, webhookAuthenticationConfigured: Boolean(process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim()), noWrites: true as const };
}
