import axios from "axios";
import { financialSha256 } from "./financialProposalIntegrity";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { runXeroRequest } from "./xeroRequestManager";
import { consumeWarrantyStep, getWarrantyEvent, getWarrantyExecutionEntries, recordWarrantyReceipt, finishWarranty } from "./financialWarrantyAvisoDb";
import { assertWarrantyRelease, getWarrantyReleasePolicy } from "./financialWarrantyAvisoRelease";
import { readWarrantyFacts } from "./financialWarrantyAvisoSource";
import { readWarrantyDocument, readWarrantyXeroEvidence } from "./financialWarrantyAvisoXero";
import { assertWarrantyConfiguration, assertWarrantyReadback, buildWarrantyPlan, type WarrantyFacts, type WarrantyPayload, type WarrantyPlan, type WarrantyXeroEvidence } from "./financialWarrantyAvisoRules";
import type { FinancialWarrantyAvisoEvent } from "../drizzle/schema";
const BASE = "https://api.xero.com/api.xro/2.0";
export type WarrantyWriterContext = { family: "warranty_aviso"; reservationId: number; releaseKey: string; approvedBy: number; step: "main" | "po" };
/** Independent authorization: no generic family authorisation object or caller-supplied eligibility flags accepted. */
export async function authorizeWarrantyWrite(payload: WarrantyPayload, context: WarrantyWriterContext) {
  const policy = await getWarrantyReleasePolicy(); assertWarrantyRelease(policy);
  const reservation = await getWarrantyEvent(context.reservationId);
  const auth = reservation?.authorisedPayload as any;
  if (context.family !== "warranty_aviso" || !["main", "po"].includes(context.step) || !reservation || reservation.status !== "reserved" || !reservation.claimKey || !reservation.executionGroup ||
    reservation.releaseKey !== policy.releaseKey || context.releaseKey !== policy.releaseKey || context.approvedBy !== policy.approvedBy || reservation.approvedBy !== policy.approvedBy ||
    !auth || auth.policyHash !== financialSha256(policy) || !reservation.sourceSnapshot || !reservation.xeroPreflight || !reservation.proposal ||
    Date.now() - reservation.createdAt.getTime() > 5 * 60_000 || reservation.createdAt.getTime() > Date.now()) throw new Error("Warranty writer has no current immutable release-backed exact payload authority.");
  const originalFacts = reservation.sourceSnapshot as WarrantyFacts; const originalEvidence = reservation.xeroPreflight as WarrantyXeroEvidence;
  if (financialSha256(originalFacts) !== reservation.sourceSnapshotHash || financialSha256(originalEvidence) !== reservation.xeroPreflightHash ||
    !originalFacts.sourceModifiedAt || Date.parse(originalFacts.sourceModifiedAt) < Date.parse(policy.effectiveFrom!)) throw new Error("Warranty source authority corrupted or predates New Events cutover.");
  const rebuilt = buildWarrantyPlan(originalFacts, originalEvidence, policy.sourceConfig!);
  if (financialSha256(rebuilt) !== financialSha256(reservation.proposal) || financialSha256(payload) !== auth[`${context.step}Hash`] ||
    financialSha256(payload) !== financialSha256(context.step === "main" ? rebuilt.mainPayload : rebuilt.poPayload) || !/^[a-f0-9]{64}$/.test(payload.idempotencyKey)) throw new Error("Warranty exact operation/body/line authority mismatch; no generic transport reuse.");
  const prior = await getWarrantyExecutionEntries(reservation.executionGroup);
  const hasVerifiedMainReceipt = prior.some(
    r =>
      r.status === "main_receipt" &&
      (r.receipt as Record<string, unknown> | null)?.readbackVerified === true
  );
  if (prior.some(r => ["reconciliation_required", "drafts_created"].includes(r.status) || r.status === `${context.step}_submitted` || r.status === `${context.step}_receipt`) ||
    context.step === "po" && !hasVerifiedMainReceipt) throw new Error("Warranty immutable attempt consumed/partial/uncertain; no retry or PO-before-verified-main-readback bypass.");
  const facts = await readWarrantyFacts(reservation.dealId, policy.sourceConfig);
  if (facts.holdReason || financialSha256(facts) !== reservation.sourceSnapshotHash || facts.sourceMappingsHash !== policy.sourceMappingsHash || facts.addedServicesMappingHash !== policy.addedServicesMappingHash) throw new Error("Warranty current exact Deal/customer/Added Services/source metadata changed; hold.");
  const current = await readWarrantyXeroEvidence(facts);
  assertWarrantyConfiguration(facts, current);
  if (current.configurationHash !== policy.xeroConfigurationHash || current.supplier.ContactID !== policy.avisoContactId) throw new Error("Warranty exact Aviso/item/account/tax configuration does not match approved policy.");
  if (context.step === "main") {
    if (current.comparisonHash !== originalEvidence.comparisonHash || financialSha256(buildWarrantyPlan(facts, current, policy.sourceConfig!)) !== financialSha256(rebuilt)) throw new Error("Warranty current full main/line/collision preflight drift; no PUT.");
  } else {
    if (current.mainHistory.length !== 1 || current.mainHistory[0].InvoiceID !== rebuilt.expectedMain.InvoiceID ||
      financialSha256(current.otherInvoices) !== financialSha256(originalEvidence.otherInvoices) || financialSha256(current.customer) !== financialSha256(originalEvidence.customer)) throw new Error("Warranty post-main current candidate/customer history changed; PO held.");
    assertWarrantyReadback(current.main, rebuilt.expectedMain, "main", rebuilt.expectedMain.InvoiceID);
  }
  return { reservation, plan: rebuilt };
}
/** Exactly one dedicated warranty operation; never retries transport. Receipt stored even when response/full readback mismatch. */
export async function executeWarrantyOperation(payload: WarrantyPayload, context: WarrantyWriterContext) {
  const { reservation, plan } = await authorizeWarrantyWrite(payload, context);
  const auth = await getXeroReadAuthWithRefresh();
  if (auth.tenantId !== (reservation.xeroPreflight as WarrantyXeroEvidence).tenantId) throw new Error("Warranty write session tenant changed after exact current preflight; hold.");
  await consumeWarrantyStep(reservation, context.step);
  let receipt: Record<string, unknown> = { operation: payload.operation, payloadHash: financialSha256(payload), idempotencyKey: payload.idempotencyKey, transportAttempted: true };
  try {
    const response = await runXeroRequest<any>(auth, `warranty-aviso:${payload.operation}:${reservation.id}`, () => {
      const headers = { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, "Content-Type": "application/json", "Idempotency-Key": payload.idempotencyKey };
      return payload.method === "PUT" ? axios.put(`${BASE}${payload.endpoint}`, payload.body, { headers, timeout: 20_000 }) : axios.post(`${BASE}${payload.endpoint}`, payload.body, { headers, timeout: 20_000 });
    }, { retryTransientGatewayFailures: false });
    receipt = { ...receipt, httpStatus: response.status, response: response.data };
    const list = context.step === "main" ? response.data?.Invoices : response.data?.PurchaseOrders;
    const row = Array.isArray(list) && list.length === 1 ? list[0] : null;
    const id = row?.[context.step === "main" ? "InvoiceID" : "PurchaseOrderID"];
    if (!row || typeof id !== "string" || !id || row.Status !== "DRAFT" || context.step === "main" && id !== plan.expectedMain.InvoiceID ||
      row[context.step === "main" ? "InvoiceNumber" : "PurchaseOrderNumber"] !== (context.step === "main" ? plan.mainNumber : plan.poNumber)) throw new Error("Warranty response exact Draft/ID/number mismatch; reconciliation required.");
    const readback = await readWarrantyDocument(context.step, id);
    receipt = { ...receipt, xeroDocumentId: id, readback };
    assertWarrantyReadback(readback, context.step === "main" ? plan.expectedMain : plan.expectedPo, context.step, id);
    await recordWarrantyReceipt(reservation, context.step, { ...receipt, readbackVerified: true });
    return { xeroDocumentId: id, receipt: { ...receipt, readbackVerified: true } };
  } catch (error) {
    receipt = { ...receipt, readbackVerified: false, error: error instanceof Error ? error.message : "Warranty uncertain transport/readback." };
    await recordWarrantyReceipt(reservation, context.step, receipt);
    throw new Error("Warranty attempted operation requires reconciliation; immutable response/receipt retained, no retry.");
  }
}
/** A first-document success + any second-document failure leaves receipts and a terminal reconciliation_required entry. No CRM mutation. */
export async function executeWarrantyPair(reservation: FinancialWarrantyAvisoEvent, plan: WarrantyPlan, approvedBy: number) {
  let attempted = 0; const receipts: unknown[] = [];
  const context = (step: "main" | "po"): WarrantyWriterContext => ({ family: "warranty_aviso", reservationId: reservation.id, releaseKey: reservation.releaseKey!, approvedBy, step });
  try {
    attempted = 1; receipts.push((await executeWarrantyOperation(plan.mainPayload, context("main"))).receipt);
    attempted = 2; receipts.push((await executeWarrantyOperation(plan.poPayload, context("po"))).receipt);
    await finishWarranty(reservation, "drafts_created", null, { receipts });
    return { ok: true, status: "drafts_created" as const, eventId: reservation.id, xeroWritesAttempted: attempted, receipts };
  } catch (error) {
    await finishWarranty(reservation, "reconciliation_required", error instanceof Error ? error.message : "Warranty execution uncertain.", { receipts });
    return { ok: false, status: "reconciliation_required" as const, eventId: reservation.id, warning: "Immutable warranty claim/attempt/receipts require reconciliation; no duplicate retries.", xeroWritesAttemptedUpperBound: attempted };
  }
}
