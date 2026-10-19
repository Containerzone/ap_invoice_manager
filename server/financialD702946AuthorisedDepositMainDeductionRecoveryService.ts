import axios from "axios";
import { randomUUID } from "node:crypto";
import { EXPECTED_AP_XERO_TENANT_LABEL, getXeroReadAuthWithRefresh } from "./xeroService";
import { runXeroRequest, type XeroRequestAuth } from "./xeroRequestManager";
import { readMainCustomerInvoiceFacts } from "./financialMainCustomerInvoiceService";
import { readDepositInvoiceFacts } from "./financialDepositInvoiceSource";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { readD702946RecoveryAnchors, assertNoD702946RecoveryCompetingPaths } from "./financialD702946DepositMainDeductionRecoveryDb";
import {
  reserveD702946AuthorisedDepositMainDeductionRecovery, holdD702946AuthorisedDepositMainDeductionRecovery,
  completeD702946AuthorisedDepositMainDeductionRecovery, getD702946AuthorisedDepositMainDeductionRecoveryEvent,
  assertD702946AuthorisedDepositRecoveryWriterReceipt, type D702946AuthorisedDepositRecoveryEvidence,
} from "./financialD702946AuthorisedDepositMainDeductionRecoveryDb";
import { assertD702946AuthorisedDepositMainDeductionRecoveryRelease, getD702946AuthorisedDepositMainDeductionRecoveryPolicy } from "./financialD702946AuthorisedDepositMainDeductionRecoveryRelease";
import {
  D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY,
  assertD702946AuthorisedDepositRecoverySource, assertD702946AuthorisedDepositRecoveryPair, d702946AuthorisedDepositExistingDeductions,
  prepareD702946AuthorisedDepositMainDeductionRecoveryPayload, assertD702946AuthorisedDepositRecoveryReadback, jsonEvidence,
} from "./financialD702946AuthorisedDepositMainDeductionRecoveryScope";

const BASE = "https://api.xero.com/api.xro/2.0";
async function getOnlyAuth(): Promise<XeroRequestAuth> { return getXeroReadAuthWithRefresh(); }
async function get(auth: XeroRequestAuth, path: string, params?: Record<string, string>): Promise<any> {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  const response = await runXeroRequest(auth, `GET financial-read:d702946-authorised-deposit-recovery:${path}${query}`, () => axios.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" }, params, timeout: 20000,
  }));
  return response.data;
}
/** Exact number and known ID with its specific allowed state; no adoption/first-row selection. */
async function exactByNumberThenId(auth: XeroRequestAuth, number: string, id: string, status: "DRAFT" | "AUTHORISED"): Promise<Record<string, any>> {
  const search = await get(auth, "/Invoices", { InvoiceNumbers: number });
  const matches = (Array.isArray(search?.Invoices) ? search.Invoices : []).filter((row: any) => row?.InvoiceNumber === number);
  if (matches.length !== 1 || matches[0].InvoiceID !== id || matches[0].Type !== "ACCREC" || matches[0].Status !== status)
    throw new Error("Exact invoice number is missing, ambiguous or not in its separately approved recovery state.");
  const full = await get(auth, `/Invoices/${id}`);
  if (!Array.isArray(full?.Invoices) || full.Invoices.length !== 1 || full.Invoices[0]?.InvoiceID !== id || full.Invoices[0]?.InvoiceNumber !== number || full.Invoices[0]?.Status !== status)
    throw new Error("Exact full invoice ID read is missing, ambiguous or changed its approved recovery state.");
  return full.Invoices[0];
}
async function readPair(): Promise<{ main: Record<string, any>; deposit: Record<string, any>; tenantIdHash: string }> {
  const auth = await getOnlyAuth();
  const organisation = await get(auth, "/Organisation");
  if (!String(organisation?.Organisations?.[0]?.Name ?? "").toUpperCase().includes(EXPECTED_AP_XERO_TENANT_LABEL)) throw new Error("Recovery tenant identity is not the expected AP tenant.");
  const [main, deposit] = await Promise.all([
    exactByNumberThenId(auth, scope.mainInvoiceNumber, scope.mainXeroInvoiceId, "DRAFT"),
    exactByNumberThenId(auth, scope.depositInvoiceNumber, scope.depositXeroInvoiceId, "AUTHORISED"),
  ]);
  assertD702946AuthorisedDepositRecoveryPair(main, deposit);
  return { main, deposit, tenantIdHash: financialSha256(auth.tenantId) };
}
async function readSource() {
  const [mainFacts, depositFacts] = await Promise.all([readMainCustomerInvoiceFacts(scope.dealId), readDepositInvoiceFacts(scope.dealId)]);
  assertD702946AuthorisedDepositRecoverySource(mainFacts, depositFacts);
  return jsonEvidence({ mainFacts, depositFacts });
}
export type D702946AuthorisedDepositRecoveryPreview =
  | { status: "already_deducted"; reason: string; noWrites: true }
  | { status: "ready"; evidence: D702946AuthorisedDepositRecoveryEvidence; payload: FinancialDraftPayload; noWrites: true };
/** Fresh read-only final-boundary preflight. It never reserves a row or writes to Xero/VTiger. */
export async function readD702946AuthorisedDepositMainDeductionRecoveryPreflight(ownExecutionId?: number): Promise<D702946AuthorisedDepositRecoveryPreview> {
  const [anchorEvidence, sourceSnapshot] = await Promise.all([readD702946RecoveryAnchors(), readSource()]);
  await assertNoD702946RecoveryCompetingPaths(ownExecutionId);
  const { main, deposit, tenantIdHash } = await readPair();
  const existing = d702946AuthorisedDepositExistingDeductions(main);
  if (existing.length > 1) throw new Error("Multiple recovery/historical Deposit deduction markers are ambiguous; held.");
  if (existing.length === 1) return { status: "already_deducted", reason: "A recovery or historical Deposit deduction marker is already present; no append or adoption.", noWrites: true };
  const mainContact = anchorEvidence.mainRecovery.authorisedPayload.payload.body.Invoices[0]?.Contact?.ContactID;
  const depositContact = anchorEvidence.deposit.authorisedPayload.payload.body.Invoices[0]?.Contact?.ContactID;
  if (main.Contact.ContactID !== mainContact || deposit.Contact.ContactID !== depositContact) throw new Error("Current Main/Deposit contacts differ from their exact completed creation receipts.");
  const fullSource = { ...sourceSnapshot, tenantIdHash };
  const evidence: D702946AuthorisedDepositRecoveryEvidence = {
    scopeKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber,
    originalMainEventId: scope.originalMainEventId, failedMainWriterExecutionId: scope.failedMainWriterExecutionId,
    mainRecoveryEventId: scope.mainRecoveryEventId, mainRecoveryWriterExecutionId: scope.mainRecoveryWriterExecutionId,
    depositEventId: scope.depositEventId, depositWriterExecutionId: anchorEvidence.depositWriter.id,
    mainInvoiceNumber: scope.mainInvoiceNumber, mainXeroInvoiceId: scope.mainXeroInvoiceId,
    depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId,
    anchorEvidenceHash: financialSha256(anchorEvidence), anchorEvidence,
    sourceSnapshotHash: financialSha256(fullSource), sourceSnapshot: fullSource,
    xeroEvidenceHash: financialSha256({ main, deposit }), mainXeroSnapshot: jsonEvidence(main), depositXeroSnapshot: jsonEvidence(deposit),
  };
  const payload = prepareD702946AuthorisedDepositMainDeductionRecoveryPayload(main, deposit, financialSha256(evidence));
  return { status: "ready", evidence, payload, noWrites: true };
}
/** Server-only explicit preview; no webhook, router, UI or schedule imports it. */
export async function previewD702946AuthorisedDepositMainDeductionRecovery(input: { dealId: string; originalMainEventId: number }): Promise<D702946AuthorisedDepositRecoveryPreview> {
  if (input.dealId !== scope.dealId || input.originalMainEventId !== scope.originalMainEventId) throw new Error("Recovery is exclusively D702946 original main event 750001.");
  return readD702946AuthorisedDepositMainDeductionRecoveryPreflight();
}
/** Server-only explicit invocation. It changes only the current Main Draft after V2 gate/policy/evidence verification. */
export async function applyApprovedD702946AuthorisedDepositMainDeductionRecovery(input: { dealId: string; originalMainEventId: number }) {
  const policy = await getD702946AuthorisedDepositMainDeductionRecoveryPolicy(); assertD702946AuthorisedDepositMainDeductionRecoveryRelease(policy);
  if (input.dealId !== scope.dealId || input.originalMainEventId !== scope.originalMainEventId) throw new Error("Recovery is exclusively D702946 original main event 750001.");
  const first = await readD702946AuthorisedDepositMainDeductionRecoveryPreflight();
  if (first.status !== "ready") return first;
  const token = randomUUID();
  const reservation = await reserveD702946AuthorisedDepositMainDeductionRecovery({ evidence: first.evidence, payload: first.payload, policy, token });
  if (reservation.state !== "reserved") return { status: reservation.state, eventId: reservation.event.id, noWrites: true };
  try {
    const outcome = await executeGuardedFinancialWriterCommand({ workflowType: scope.workflowType, proposedAction: "update_draft", payload: first.payload,
      expectedExactDraft: (first.payload.body.Invoices as Record<string, any>[])[0]!, preparedBy: policy.approvedBy!,
      authorisation: { workflowType: scope.workflowType, approvalReference: policy.releaseKey, globalShadowMode: false, familyLiveEnabled: true,
        releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true,
        d702946AuthorisedDepositMainDeductionRecoveryEventId: reservation.event.id, d702946AuthorisedDepositMainDeductionRecoveryToken: token,
        d702946AuthorisedDepositMainDeductionRecoveryReleaseKey: policy.releaseKey, d702946AuthorisedDepositMainDeductionRecoveryApprovedBy: policy.approvedBy! } });
    if (outcome.outcome !== "succeeded") {
      await holdD702946AuthorisedDepositMainDeductionRecovery(reservation.event.id, token, "Bounded Authorised-Deposit recovery writer/readback uncertain or duplicate; no automatic retry.");
      return { status: "reconciliation_required" as const, eventId: reservation.event.id, outcome };
    }
    const readbackEvidence = outcome.recoveryReadbackEvidence;
    if (!readbackEvidence) throw new Error("Dedicated full Authorised-Deposit recovery readback evidence was not retained.");
    await completeD702946AuthorisedDepositMainDeductionRecovery({ eventId: reservation.event.id, token, executionId: outcome.executionId, payloadHash: financialSha256(first.payload), readbackEvidence });
    return { status: "draft_updated" as const, eventId: reservation.event.id, executionId: outcome.executionId, readbackEvidence };
  } catch (error) {
    await holdD702946AuthorisedDepositMainDeductionRecovery(reservation.event.id, token, error instanceof Error ? error.message : "Recovery uncertain; never retry.");
    throw error;
  }
}
/** GET-only external reconciliation. It never POSTs and requires unchanged Authorised Deposit evidence. */
export async function readD702946AuthorisedDepositMainDeductionRecoveryReadback(eventId: number, executionId: number) {
  const event = await getD702946AuthorisedDepositMainDeductionRecoveryEvent(eventId);
  if (!event || event.scopeKey !== D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY || !["submitted", "reconciliation_required", "draft_updated"].includes(event.status) || event.executionId !== executionId || !event.submittedAt ||
    financialSha256(event.authorisedPayload) !== event.payloadHash) throw new Error("Reconciliation requires the original consumed immutable bounded V2 recovery payload.");
  await assertD702946AuthorisedDepositRecoveryWriterReceipt(executionId, event, ["submitted", "succeeded", "reconciliation_required", "failed"]);
  await assertNoD702946RecoveryCompetingPaths(executionId);
  const [anchors, source, pair] = await Promise.all([readD702946RecoveryAnchors(), readSource(), readPair()]);
  if (financialSha256(anchors) !== event.anchorEvidenceHash || financialSha256({ ...source, tenantIdHash: pair.tenantIdHash }) !== event.sourceSnapshotHash ||
    financialSha256(pair.deposit) !== financialSha256(event.depositXeroSnapshot)) throw new Error("Recovery readback source/ownership/Authorised Deposit evidence changed; held.");
  assertD702946AuthorisedDepositRecoveryReadback(pair.main, event.authorisedPayload as FinancialDraftPayload);
  return jsonEvidence({ main: pair.main, deposit: pair.deposit, source, anchorEvidenceHash: event.anchorEvidenceHash,
    payloadHash: event.payloadHash, executionId, verifiedAt: new Date().toISOString(), noXeroWrite: true });
}
export async function reconcileD702946AuthorisedDepositMainDeductionRecovery(input: { eventId: number }) {
  const event = await getD702946AuthorisedDepositMainDeductionRecoveryEvent(input.eventId);
  if (!event?.executionId || event.scopeKey !== D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY || event.status !== "reconciliation_required") throw new Error("Only a consumed uncertain Authorised-Deposit recovery may be reconciled.");
  const readbackEvidence = await readD702946AuthorisedDepositMainDeductionRecoveryReadback(event.id, event.executionId);
  await completeD702946AuthorisedDepositMainDeductionRecovery({ eventId: event.id, executionId: event.executionId, payloadHash: event.payloadHash, readbackEvidence });
  return { status: "draft_updated" as const, eventId: event.id, executionId: event.executionId, noXeroWrite: true };
}
