import { randomUUID } from "node:crypto";
import { EXPECTED_AP_XERO_TENANT_LABEL, getXeroReadAuthWithRefresh } from "./xeroService";
import { runBoundedXeroGet, type XeroRequestAuth } from "./xeroRequestManager";
import { readMainCustomerInvoiceFacts } from "./financialMainCustomerInvoiceService";
import { readDepositInvoiceFacts } from "./financialDepositInvoiceSource";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import {
  readD702959AuthorisedDepositRecoveryAnchors,
  assertNoD702959AuthorisedDepositRecoveryCompetingPaths,
  reserveD702959AuthorisedDepositMainDeductionRecovery,
  holdD702959AuthorisedDepositMainDeductionRecovery,
  completeD702959AuthorisedDepositMainDeductionRecovery,
  getD702959AuthorisedDepositMainDeductionRecoveryEvent,
  assertD702959AuthorisedDepositRecoveryWriterReceipt,
  type D702959AuthorisedDepositRecoveryEvidence,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryDb";
import {
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease,
  getD702959AuthorisedDepositMainDeductionRecoveryPolicy,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryRelease";
import {
  D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope,
  D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY,
  assertD702959AuthorisedDepositRecoverySource,
  assertD702959DepositMatchesSource,
  assertD702959AuthorisedDepositRecoveryPair,
  d702959AuthorisedDepositExistingDeductions,
  prepareD702959AuthorisedDepositMainDeductionRecoveryPayload,
  assertD702959AuthorisedDepositRecoveryReadback,
  jsonEvidence,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryScope";

const BASE = "https://api.xero.com/api.xro/2.0";
async function getOnlyAuth(): Promise<XeroRequestAuth> { return getXeroReadAuthWithRefresh(); }
/** The bounded transport accepts only literal GET operations and retains the tenant queue/rate-limit controls. */
async function get(auth: XeroRequestAuth, path: string, params?: Record<string, string>): Promise<any> {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  const response = await runBoundedXeroGet(auth,
    `GET financial-read:d702959-authorised-deposit-recovery:${path}${query}`,
    `${BASE}${path}`,
    { headers: { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" }, params, timeout: 20_000 },
    { retryRateLimitOnce: false });
  return response.data;
}

/** Exact number search followed by full exact ID GET; no first-row adoption is possible. */
async function exactByNumberThenId(auth: XeroRequestAuth, number: string, id: string, status: "DRAFT" | "AUTHORISED"): Promise<Record<string, any>> {
  const search = await get(auth, "/Invoices", { InvoiceNumbers: number });
  const matches = (Array.isArray(search?.Invoices) ? search.Invoices : []).filter((row: any) =>
    row?.InvoiceNumber === number && row?.InvoiceID === id && row?.Type === "ACCREC" && row?.Status === status);
  if (matches.length !== 1) throw new Error("Exact D702959 invoice number is absent, ambiguous, has a changed ID, or is not in its separately allowed state.");
  const full = await get(auth, `/Invoices/${encodeURIComponent(id)}`);
  if (!Array.isArray(full?.Invoices) || full.Invoices.length !== 1 || full.Invoices[0]?.InvoiceID !== id ||
    full.Invoices[0]?.InvoiceNumber !== number || full.Invoices[0]?.Type !== "ACCREC" || full.Invoices[0]?.Status !== status) {
    throw new Error("Exact D702959 full invoice-ID GET is absent, ambiguous, or changed state.");
  }
  return full.Invoices[0];
}
async function readPair(): Promise<{ main: Record<string, any>; deposit: Record<string, any>; tenantIdHash: string }> {
  const auth = await getOnlyAuth();
  const organisation = await get(auth, "/Organisation");
  if (!String(organisation?.Organisations?.[0]?.Name ?? "").toUpperCase().includes(EXPECTED_AP_XERO_TENANT_LABEL)) {
    throw new Error("D702959 recovery tenant identity is not the expected AP tenant.");
  }
  // Sequential reads preserve the bounded GET transport's single tenant queue.
  const main = await exactByNumberThenId(auth, scope.mainInvoiceNumber, scope.mainXeroInvoiceId, "DRAFT");
  const deposit = await exactByNumberThenId(auth, scope.depositInvoiceNumber, scope.depositXeroInvoiceId, "AUTHORISED");
  assertD702959AuthorisedDepositRecoveryPair(main, deposit);
  return { main, deposit, tenantIdHash: financialSha256(auth.tenantId) };
}
async function readSource() {
  const mainFacts = await readMainCustomerInvoiceFacts(scope.dealId);
  const depositFacts = await readDepositInvoiceFacts(scope.dealId);
  assertD702959AuthorisedDepositRecoverySource(mainFacts, depositFacts);
  return jsonEvidence({ mainFacts, depositFacts });
}

export type D702959AuthorisedDepositRecoveryPreview =
  | { status: "already_deducted"; reason: string; noWrites: true }
  | { status: "ready"; evidence: D702959AuthorisedDepositRecoveryEvidence; payload: FinancialDraftPayload; noWrites: true };

/** Fresh GET-only preflight. It cannot reserve a row, write Xero, or write VTiger. */
export async function readD702959AuthorisedDepositMainDeductionRecoveryPreflight(ownExecutionId?: number): Promise<D702959AuthorisedDepositRecoveryPreview> {
  const anchors = await readD702959AuthorisedDepositRecoveryAnchors();
  await assertNoD702959AuthorisedDepositRecoveryCompetingPaths(ownExecutionId);
  const source = await readSource();
  const { main, deposit, tenantIdHash } = await readPair();
  assertD702959DepositMatchesSource(source.depositFacts, deposit);
  const deductions = d702959AuthorisedDepositExistingDeductions(main);
  if (deductions.length > 1) throw new Error("Multiple current or historical D702959 Deposit deduction markers are ambiguous; held.");
  if (deductions.length === 1) return { status: "already_deducted", reason: "D702959 already contains a Deposit deduction marker; no append or adoption.", noWrites: true };
  const mainContact = anchors.originalMain.proposal?.partySourceId;
  const depositContact = anchors.deposit.authorisedPayload?.payload?.body?.Invoices?.[0]?.Contact?.ContactID;
  if (!mainContact || !depositContact || main.Contact.ContactID !== mainContact || deposit.Contact.ContactID !== depositContact) {
    throw new Error("Current D702959 Main/Deposit contact differs from immutable source and Deposit receipt evidence.");
  }
  const sourceSnapshot = { ...source, tenantIdHash };
  const evidence: D702959AuthorisedDepositRecoveryEvidence = {
    scopeKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber,
    originalMainEventId: scope.originalMainEventId, failedMainWriterExecutionId: scope.failedMainWriterExecutionId,
    depositEventId: scope.depositEventId, depositWriterExecutionId: scope.depositWriterExecutionId,
    mainInvoiceNumber: scope.mainInvoiceNumber, mainXeroInvoiceId: scope.mainXeroInvoiceId,
    depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId,
    anchorEvidenceHash: financialSha256(anchors), anchorEvidence: anchors,
    sourceSnapshotHash: financialSha256(sourceSnapshot), sourceSnapshot,
    xeroEvidenceHash: financialSha256({ main, deposit }), mainXeroSnapshot: jsonEvidence(main), depositXeroSnapshot: jsonEvidence(deposit),
  };
  const payload = prepareD702959AuthorisedDepositMainDeductionRecoveryPayload(main, deposit, financialSha256(evidence));
  return { status: "ready", evidence, payload, noWrites: true };
}

/** Server-only explicit preview. No router, UI, webhook, or schedule imports this module. */
export async function previewD702959AuthorisedDepositMainDeductionRecovery(input: { dealId: string; originalMainEventId: number }): Promise<D702959AuthorisedDepositRecoveryPreview> {
  if (input.dealId !== scope.dealId || input.originalMainEventId !== scope.originalMainEventId) {
    throw new Error("Recovery is exclusively D702959 original Main event 1290001.");
  }
  return readD702959AuthorisedDepositMainDeductionRecoveryPreflight();
}

/** Server-only explicit apply: one fresh preflight, one reservation, one POST maximum, then hold on any uncertainty. */
export async function applyApprovedD702959AuthorisedDepositMainDeductionRecovery(input: { dealId: string; originalMainEventId: number }) {
  const policy = await getD702959AuthorisedDepositMainDeductionRecoveryPolicy();
  assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy);
  if (input.dealId !== scope.dealId || input.originalMainEventId !== scope.originalMainEventId) {
    throw new Error("Recovery is exclusively D702959 original Main event 1290001.");
  }
  const first = await readD702959AuthorisedDepositMainDeductionRecoveryPreflight();
  if (first.status !== "ready") return first;
  const token = randomUUID();
  const reservation = await reserveD702959AuthorisedDepositMainDeductionRecovery({ evidence: first.evidence, payload: first.payload, policy, token });
  if (reservation.state !== "reserved") return { status: reservation.state, eventId: reservation.event.id, noWrites: true };
  try {
    const outcome = await executeGuardedFinancialWriterCommand({ workflowType: scope.workflowType, proposedAction: "update_draft", payload: first.payload,
      expectedExactDraft: (first.payload.body.Invoices as Record<string, any>[])[0]!, preparedBy: policy.approvedBy!,
      authorisation: { workflowType: scope.workflowType, approvalReference: policy.releaseKey, globalShadowMode: false, familyLiveEnabled: true,
        releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true,
        d702959AuthorisedDepositMainDeductionRecoveryEventId: reservation.event.id,
        d702959AuthorisedDepositMainDeductionRecoveryToken: token,
        d702959AuthorisedDepositMainDeductionRecoveryReleaseKey: policy.releaseKey,
        d702959AuthorisedDepositMainDeductionRecoveryApprovedBy: policy.approvedBy! } });
    if (outcome.outcome !== "succeeded") {
      await holdD702959AuthorisedDepositMainDeductionRecovery(reservation.event.id, token, "D702959 writer/readback is uncertain or duplicate; no automatic retry.");
      return { status: "reconciliation_required" as const, eventId: reservation.event.id, outcome };
    }
    if (!outcome.recoveryReadbackEvidence) throw new Error("D702959 dedicated exact full readback evidence was not retained.");
    await completeD702959AuthorisedDepositMainDeductionRecovery({ eventId: reservation.event.id, token, executionId: outcome.executionId,
      payloadHash: financialSha256(first.payload), readbackEvidence: outcome.recoveryReadbackEvidence });
    return { status: "draft_updated" as const, eventId: reservation.event.id, executionId: outcome.executionId, readbackEvidence: outcome.recoveryReadbackEvidence };
  } catch (error) {
    await holdD702959AuthorisedDepositMainDeductionRecovery(reservation.event.id, token, error instanceof Error ? error.message : "D702959 recovery uncertain; never retry.");
    throw error;
  }
}

/** GET-only reconciliation of a consumed uncertain attempt; it never submits another Xero request. */
export async function readD702959AuthorisedDepositMainDeductionRecoveryReadback(eventId: number, executionId: number) {
  const event = await getD702959AuthorisedDepositMainDeductionRecoveryEvent(eventId);
  if (!event || event.scopeKey !== D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY ||
    !["submitted", "reconciliation_required", "draft_updated"].includes(event.status) || event.executionId !== executionId || !event.submittedAt ||
    financialSha256(event.authorisedPayload) !== event.payloadHash) {
    throw new Error("D702959 reconciliation requires its exact consumed immutable recovery payload.");
  }
  await assertD702959AuthorisedDepositRecoveryWriterReceipt(executionId, event, ["submitted", "succeeded", "reconciliation_required", "failed"]);
  await assertNoD702959AuthorisedDepositRecoveryCompetingPaths(executionId);
  const anchors = await readD702959AuthorisedDepositRecoveryAnchors();
  const source = await readSource();
  const pair = await readPair();
  assertD702959DepositMatchesSource(source.depositFacts, pair.deposit);
  if (financialSha256(anchors) !== event.anchorEvidenceHash ||
    financialSha256({ ...source, tenantIdHash: pair.tenantIdHash }) !== event.sourceSnapshotHash ||
    financialSha256(pair.deposit) !== financialSha256(event.depositXeroSnapshot)) {
    throw new Error("D702959 readback source/ownership/Authorised Deposit evidence changed; held.");
  }
  assertD702959AuthorisedDepositRecoveryReadback(pair.main, event.authorisedPayload as FinancialDraftPayload);
  return jsonEvidence({ main: pair.main, deposit: pair.deposit, source, anchorEvidenceHash: event.anchorEvidenceHash,
    payloadHash: event.payloadHash, executionId, verifiedAt: new Date().toISOString(), noXeroWrite: true });
}

export async function reconcileD702959AuthorisedDepositMainDeductionRecovery(input: { eventId: number }) {
  const event = await getD702959AuthorisedDepositMainDeductionRecoveryEvent(input.eventId);
  if (!event?.executionId || event.scopeKey !== D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY || event.status !== "reconciliation_required") {
    throw new Error("Only a consumed uncertain D702959 recovery can be reconciled.");
  }
  const readbackEvidence = await readD702959AuthorisedDepositMainDeductionRecoveryReadback(event.id, event.executionId);
  await completeD702959AuthorisedDepositMainDeductionRecovery({ eventId: event.id, executionId: event.executionId,
    payloadHash: event.payloadHash, readbackEvidence });
  return { status: "draft_updated" as const, eventId: event.id, executionId: event.executionId, noXeroWrite: true };
}
