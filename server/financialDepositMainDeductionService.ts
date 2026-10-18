import axios from "axios";
import { randomUUID } from "node:crypto";
import { getDepositInvoiceReleasePolicy, assertDepositMainDeductionRelease } from "./financialDepositInvoiceRelease";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { readMainCustomerInvoiceFacts } from "./financialMainCustomerInvoiceService";
import { readDepositInvoiceFacts } from "./financialDepositInvoiceSource";
import { getMainCustomerInvoiceEvent } from "./financialMainCustomerInvoiceDb";
import { completeInvoice, writableDraft } from "./financialDepositDraftCorrectionService";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { bindDepositMainDeductionPayload, completeDepositMainDeduction, holdDepositMainDeduction, reserveDepositMainDeduction, verifyDepositMainDeductionWriteAccess } from "./financialDepositMainDeductionDb";
import { runXeroRequest } from "./xeroRequestManager";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const DEPOSIT_ITEM_CODE = "Deposit Required";
type XeroInvoice = Record<string, any>;
export type DepositMainDeductionResult =
  | { status: "disabled" | "not_ready" | "already_deducted" | "held" | "reconciliation_required"; reason: string; xeroWritesAttempted: 0 }
  | { status: "deducted"; eventId: number; executionId: number; mainInvoiceNumber: string; depositInvoiceNumber: string; xeroWritesAttempted: 1 };

const text = (value: unknown) => String(value ?? "").trim();
const cents = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Xero monetary evidence is not numeric.");
  const rounded = Math.round((parsed + Number.EPSILON) * 100);
  if (Math.abs(parsed * 100 - rounded) > 0.001) throw new Error("Xero monetary evidence is not in cents.");
  return rounded;
};
const currency = (centsValue: number) => Math.round(centsValue) / 100;
function date(value: unknown): string | null { const raw = text(value); const ms = raw.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/); const parsed = ms ? new Date(Number(ms[1])) : new Date(raw); return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null; }
async function xeroInvoice(id: string, auth: { token: string; tenantId: string }) {
  const response = await runXeroRequest(
    auth,
    `GET financial-read:deposit-main-deduction:invoice-id:${id}`,
    () => axios.get(`${XERO_API_BASE}/Invoices/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" } }),
  );
  return response.data?.Invoices?.[0] ?? null;
}
async function exactInvoiceByNumber(number: string, auth: { token: string; tenantId: string }) {
  const response = await runXeroRequest(
    auth,
    `GET financial-read:deposit-main-deduction:invoice-number:${number}`,
    () => axios.get(`${XERO_API_BASE}/Invoices`, { headers: { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" }, params: { InvoiceNumbers: number } }),
  );
  const matches = (Array.isArray(response.data?.Invoices) ? response.data.Invoices : []).filter((row: any) => text(row?.Type) === "ACCREC" && text(row?.InvoiceNumber).toUpperCase() === number.toUpperCase());
  if (matches.length !== 1 || !text(matches[0]?.InvoiceID)) return null;
  return xeroInvoice(text(matches[0].InvoiceID), auth);
}
function exactDraft(invoice: XeroInvoice, number: string): XeroInvoice {
  const row = completeInvoice(invoice, number);
  if (text(row.CurrencyCode) !== "AUD" || row.LineAmountTypes !== "Exclusive") throw new Error(`Exact main Draft ${number} has incompatible currency or GST treatment.`);
  return row;
}
function deductionDescription(depositNumber: string) { return `Less deposit invoice ${depositNumber}`; }
function existingDeductions(main: XeroInvoice, depositNumber: string) {
  return main.LineItems.filter((line: any) => {
    const description = text(line?.Description);
    return description === deductionDescription(depositNumber) || description === `Deposit deduction — ${depositNumber}`;
  });
}
function buildPayload(main: XeroInvoice, deposit: XeroInvoice, sourceHash: string, depositInclusiveAmount: number): FinancialDraftPayload {
  const totalCents = cents(depositInclusiveAmount);
  if (totalCents <= 0) throw new Error("Exact Deposit Draft total must be positive.");
  const exclusiveCents = Math.round(totalCents * 10 / 11);
  const gstCents = totalCents - exclusiveCents;
  if (exclusiveCents <= 0 || gstCents < 0) throw new Error("Exact Deposit GST calculation is invalid.");
  const next = writableDraft(main);
  next.LineItems.push({
    Description: deductionDescription(text(deposit.InvoiceNumber)),
    Quantity: 1,
    UnitAmount: -currency(exclusiveCents),
    LineAmount: -currency(exclusiveCents),
    TaxAmount: -currency(gstCents),
    AccountCode: "200",
    TaxType: "OUTPUT",
  });
  return {
    method: "POST",
    endpoint: `/Invoices/${encodeURIComponent(text(main.InvoiceID))}`,
    documentFamily: "customer_invoice",
    documentNumber: text(main.InvoiceNumber),
    expectedXeroDocumentId: text(main.InvoiceID),
    body: { Invoices: [next] },
    idempotencyKey: financialSha256({ workflow: "deposit_main_deduction", sourceHash, main: next, depositInvoiceId: deposit.InvoiceID }),
  };
}

/**
 * Optional post-create action shared by either protected Deposit or Main route.
 * It never creates a Draft; it updates only an exact current main Draft after the
 * separately armed Deposit-main deduction release passes.
 */
export async function processAutomaticDepositMainDeduction(dealId: string): Promise<DepositMainDeductionResult> {
  const policy = await getDepositInvoiceReleasePolicy();
  try { assertDepositMainDeductionRelease(policy); }
  catch (error) { return { status: "disabled", reason: error instanceof Error ? error.message : "Deposit deduction release is disabled.", xeroWritesAttempted: 0 }; }
  try {
    const facts = await readMainCustomerInvoiceFacts(dealId);
    const depositFacts = await readDepositInvoiceFacts(dealId);
    if (!/^D\d{1,12}$/i.test(facts.dealNumber)) return { status: "held", reason: "Current Deal number is not suitable for a Deposit/main deduction.", xeroWritesAttempted: 0 };
    const mainNumber = `INV-${facts.dealNumber.slice(1)}`;
    const depositNumber = `${mainNumber}-D`;
    const auth = await getXeroReadAuthWithRefresh();
    const [mainRaw, depositRaw] = await Promise.all([exactInvoiceByNumber(mainNumber, auth), exactInvoiceByNumber(depositNumber, auth)]);
    if (!mainRaw || !depositRaw) return { status: "not_ready", reason: "Exact current main and Deposit invoices must both exist before a Deposit deduction.", xeroWritesAttempted: 0 };
    const main = exactDraft(mainRaw, mainNumber);
    const deposit = completeInvoice(depositRaw, depositNumber);
    const mainEvent = await getMainCustomerInvoiceEvent(dealId);
    if (!mainEvent || mainEvent.status !== "drafts_created" || text(mainEvent.xeroInvoiceId) !== text(main.InvoiceID)) {
      return { status: "not_ready", reason: "Exact main Draft is not a current AP-owned Main Invoice receipt; no legacy invoice will be adopted or amended.", xeroWritesAttempted: 0 };
    }
    if (text(deposit.CurrencyCode) !== "AUD" || deposit.LineAmountTypes !== "Inclusive" || deposit.LineItems?.length !== 1 || text(deposit.LineItems?.[0]?.ItemCode) !== DEPOSIT_ITEM_CODE || Number(deposit.AmountPaid ?? 0) !== 0 || Number(deposit.AmountCredited ?? 0) !== 0) throw new Error("Exact Deposit Draft is not an unpaid one-line inclusive Deposit Required invoice.");
    if (text(main.Contact?.ContactID) !== text(deposit.Contact?.ContactID)) throw new Error("Exact main and Deposit Drafts have different Xero contacts.");
    const duplicates = existingDeductions(main, depositNumber);
    if (duplicates.length === 1) return { status: "already_deducted", reason: "Exact main Draft already contains the one Deposit deduction line.", xeroWritesAttempted: 0 };
    if (duplicates.length > 1) throw new Error("More than one Deposit deduction line exists; no line will be selected or removed.");
    const sourceDepositCents = cents(depositFacts.depositAmountRequiredInclusive);
    if (sourceDepositCents !== cents(deposit.Total)) throw new Error("Current VTiger Deposit Amount Required does not equal the exact Xero Deposit Draft total; deduction is held for reconciliation.");
    const factsHash = sourceSnapshotHash({ mainFacts: facts, depositFacts, source: "deposit_main_deduction_v2_operations_amount" });
    const xeroEvidenceHash = financialSha256({ main, deposit });
    const token = randomUUID();
    const reservation = await reserveDepositMainDeduction({ dealId, dealNumber: facts.dealNumber, depositInvoiceNumber: depositNumber, depositXeroInvoiceId: text(deposit.InvoiceID), mainInvoiceNumber: mainNumber, mainXeroInvoiceId: text(main.InvoiceID), sourceSnapshotHash: factsHash, xeroEvidenceHash, token });
    if (reservation.state === "completed") return { status: "already_deducted", reason: "Exact Deposit deduction is already recorded as completed.", xeroWritesAttempted: 0 };
    if (reservation.state === "blocked") return { status: reservation.event.status === "reconciliation_required" ? "reconciliation_required" : "held", reason: reservation.event.holdReason ?? "Deposit deduction is already reserved; no duplicate update.", xeroWritesAttempted: 0 };
    const payload = buildPayload(main, deposit, financialSha256({ factsHash, xeroEvidenceHash }), depositFacts.depositAmountRequiredInclusive!);
    await bindDepositMainDeductionPayload(reservation.event.id, token, policy.releaseKey, payload);
    const authorisation = { workflowType: "deposit_main_deduction", approvalReference: policy.releaseKey, globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, depositMainDeductionAutomaticEventId: reservation.event.id, depositMainDeductionReleaseKey: policy.releaseKey, depositMainDeductionApprovedBy: policy.approvedBy!, depositMainDeductionToken: token };
    const outcome = await executeGuardedFinancialWriterCommand({ workflowType: "deposit_main_deduction", proposedAction: "update_draft", payload, preparedBy: policy.approvedBy!, authorisation, expectedExactDraft: (payload.body.Invoices as Record<string, any>[])[0]! });
    if (outcome.outcome !== "succeeded") { await holdDepositMainDeduction(reservation.event.id, token, "Deposit-to-main Draft update needs exact reconciliation; no retry/adoption is allowed."); return { status: "reconciliation_required", reason: "Deposit-to-main Draft update is awaiting reconciliation.", xeroWritesAttempted: 0 }; }
    await completeDepositMainDeduction({ eventId: reservation.event.id, token, executionId: outcome.executionId });
    return { status: "deducted", eventId: reservation.event.id, executionId: outcome.executionId, mainInvoiceNumber: mainNumber, depositInvoiceNumber: depositNumber, xeroWritesAttempted: 1 };
  } catch (error) {
    return { status: "held", reason: error instanceof Error ? error.message : "Deposit-to-main deduction evidence is held.", xeroWritesAttempted: 0 };
  }
}
