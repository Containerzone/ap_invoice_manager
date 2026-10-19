import { financialSha256 } from "./financialProposalIntegrity";
import { writableDraft } from "./financialDepositDraftCorrectionService";
import { assertFinalWeightReadback } from "./financialFinalWeightAdjustmentRules";
import type { FinancialDraftPayload } from "./financialProductionWriter";

/**
 * Closed V2 incident scope. V1 remains immutable and Draft/Draft-only. V2 can
 * use only the exact already-Authorised, wholly outstanding Deposit as evidence
 * while it writes only to the separately verified Main Draft.
 */
export const D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE = Object.freeze({
  workflowType: "d702946_authorised_deposit_main_deduction_recovery",
  dealId: "5x490313", dealNumber: "D702946", originalMainEventId: 750001,
  failedMainWriterExecutionId: 1110001, mainRecoveryEventId: 1,
  mainRecoveryWriterExecutionId: 1170001, depositEventId: 270001,
  mainInvoiceNumber: "INV-702946", mainXeroInvoiceId: "17a162b6-348c-4409-b4c2-562730659696",
  depositInvoiceNumber: "INV-702946-D", depositXeroInvoiceId: "a52b0ac4-9de9-4007-85ac-731a7f3d1da0",
  mainStatus: "DRAFT", depositEvidenceStatus: "AUTHORISED",
  depositAmountRequiredInclusive: 500,
  deduction: Object.freeze({ Description: "Less deposit invoice INV-702946-D", Quantity: 1,
    UnitAmount: -454.55, LineAmount: -454.55, TaxAmount: -45.45, AccountCode: "200", TaxType: "OUTPUT" }),
});
export const D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY = "D702946-authorised-deposit-main-deduction-recovery-v2";
export const D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY = "D702946-AUTHORISED-DEPOSIT-MAIN-DEDUCTION-RECOVERY-V2";
const scope = D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE;
export const jsonEvidence = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function exactCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001)
    throw new Error("Recovery monetary evidence must be finite exact numeric cents.");
  return Math.round(value * 100);
}
/** Xero returns `null` rather than numeric zero for AmountCredited on some unallocated documents. */
function zeroOutstandingAmount(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value) && value === 0);
}
function hasNoAllocationEvidence(invoice: Record<string, any>): boolean {
  return zeroOutstandingAmount(invoice.AmountPaid) && zeroOutstandingAmount(invoice.AmountCredited) &&
    ["Payments", "CreditNotes", "Prepayments", "Overpayments"].every(key => invoice[key] == null || (Array.isArray(invoice[key]) && invoice[key].length === 0));
}
export function assertD702946AuthorisedDepositRecoverySource(main: Record<string, any>, deposit: Record<string, any>): void {
  if (main.dealId !== scope.dealId || deposit.dealId !== scope.dealId || main.dealNumber !== scope.dealNumber ||
    deposit.dealNumber !== scope.dealNumber || main.sourceHoldReason || deposit.sourceHoldReason ||
    !main.sourceRefreshedAt || !deposit.sourceRefreshedAt || !Number.isFinite(Date.parse(main.sourceRefreshedAt)) ||
    !Number.isFinite(Date.parse(deposit.sourceRefreshedAt)) || !main.quoteId || main.quoteId !== deposit.quoteId ||
    !main.quoteNumber || main.quoteNumber !== deposit.quoteNumber || !main.customerVtigerId || !main.customerName ||
    !deposit.customerVtigerId || !deposit.customerName || deposit.mappingEvidence?.depositAmountRequired !== "cf_potentials_extras" ||
    exactCents(deposit.depositAmountRequiredInclusive) !== 50000) {
    throw new Error("Only exact current D702946/5x490313 source with $500 Deposit Amount Required may recover.");
  }
}
const markers = [scope.deduction.Description, `Deposit deduction — ${scope.depositInvoiceNumber}`];
/** Containment, not equality: annotated/historical deductions must never evade the hold. */
export function d702946AuthorisedDepositExistingDeductions(main: Record<string, any>): Record<string, any>[] {
  return (Array.isArray(main.LineItems) ? main.LineItems : []).filter((line: any) =>
    markers.some(marker => String(line?.Description ?? "").includes(marker)));
}
export function assertD702946AuthorisedDepositMainDraft(invoice: Record<string, any>): void {
  if (!invoice || invoice.InvoiceNumber !== scope.mainInvoiceNumber || invoice.InvoiceID !== scope.mainXeroInvoiceId ||
    invoice.Type !== "ACCREC" || invoice.Status !== scope.mainStatus || invoice.CurrencyCode !== "AUD" ||
    invoice.LineAmountTypes !== "Exclusive" || typeof invoice.Contact?.ContactID !== "string" || !invoice.Contact.ContactID.trim() ||
    !Array.isArray(invoice.LineItems) || !invoice.LineItems.length || !writableDraft(invoice).Date || !hasNoAllocationEvidence(invoice)) {
    throw new Error("Exact Main recovery invoice must be an unallocated AUD ACCREC DRAFT with complete evidence.");
  }
  const net = exactCents(invoice.SubTotal), tax = exactCents(invoice.TotalTax), total = exactCents(invoice.Total);
  const lines = invoice.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.LineAmount), 0);
  const lineTax = invoice.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.TaxAmount), 0);
  if (net + tax !== total || lines !== net || lineTax !== tax) throw new Error("Full Main Draft line/tax totals are inconsistent.");
}
/** Evidence only: this function cannot make an Authorised Deposit a write target. */
export function assertD702946AuthorisedDepositEvidence(invoice: Record<string, any>): void {
  if (!invoice || invoice.InvoiceNumber !== scope.depositInvoiceNumber || invoice.InvoiceID !== scope.depositXeroInvoiceId ||
    invoice.Type !== "ACCREC" || invoice.Status !== scope.depositEvidenceStatus || invoice.CurrencyCode !== "AUD" ||
    invoice.LineAmountTypes !== "Inclusive" || typeof invoice.Contact?.ContactID !== "string" || !invoice.Contact.ContactID.trim() ||
    !Array.isArray(invoice.LineItems) || invoice.LineItems.length !== 1 || !writableDraft(invoice).Date || !hasNoAllocationEvidence(invoice)) {
    throw new Error("Exact Deposit evidence must be an unallocated AUD ACCREC AUTHORISED document with complete evidence.");
  }
  const line = invoice.LineItems[0];
  const net = exactCents(invoice.SubTotal), tax = exactCents(invoice.TotalTax), total = exactCents(invoice.Total);
  if (net + tax !== total || exactCents(line.LineAmount) !== total || exactCents(line.TaxAmount) !== tax ||
    exactCents(invoice.AmountDue) !== 50000 || total !== 50000 || line.ItemCode !== "Deposit Required" || line.Quantity !== 1 ||
    exactCents(line.UnitAmount) !== 50000 || line.AccountCode !== "200" || line.TaxType !== "OUTPUT") {
    throw new Error("Exact Authorised Deposit must remain one wholly outstanding $500 Deposit Required line.");
  }
}
export function assertD702946AuthorisedDepositRecoveryPair(main: Record<string, any>, deposit: Record<string, any>): void {
  assertD702946AuthorisedDepositMainDraft(main); assertD702946AuthorisedDepositEvidence(deposit);
  if (main.Contact.ContactID !== deposit.Contact.ContactID) throw new Error("Main Draft and Authorised Deposit evidence must retain the same nonempty ContactID.");
}
/** Retains the full Main Draft header and every existing Main line verbatim; the Deposit is evidence only. */
export function prepareD702946AuthorisedDepositMainDeductionRecoveryPayload(main: Record<string, any>, deposit: Record<string, any>, evidenceHash: string): FinancialDraftPayload {
  assertD702946AuthorisedDepositRecoveryPair(main, deposit);
  if (d702946AuthorisedDepositExistingDeductions(main).length) throw new Error("Existing Deposit deduction: already present or ambiguous; never append again.");
  if (exactCents(main.SubTotal) !== 902915 || exactCents(main.TotalTax) !== 90292 || exactCents(main.Total) !== 993207)
    throw new Error("Main recovered Draft totals no longer equal the exact approved starting state.");
  const next = writableDraft(main);
  next.LineItems.push(jsonEvidence(scope.deduction));
  return { method: "POST", endpoint: `/Invoices/${scope.mainXeroInvoiceId}`, documentFamily: "customer_invoice",
    documentNumber: scope.mainInvoiceNumber, expectedXeroDocumentId: scope.mainXeroInvoiceId,
    body: { Invoices: [next] }, idempotencyKey: financialSha256({ workflow: scope.workflowType, evidenceHash, body: { Invoices: [next] } }) };
}
export function assertD702946AuthorisedDepositRecoveryPayload(payload: FinancialDraftPayload): void {
  const rows = payload.body.Invoices as Record<string, any>[];
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (payload.method !== "POST" || payload.endpoint !== `/Invoices/${scope.mainXeroInvoiceId}` ||
    payload.expectedXeroDocumentId !== scope.mainXeroInvoiceId || payload.documentNumber !== scope.mainInvoiceNumber ||
    payload.documentFamily !== "customer_invoice" || Object.keys(payload.body).length !== 1 || !row ||
    row.InvoiceID !== scope.mainXeroInvoiceId || row.InvoiceNumber !== scope.mainInvoiceNumber || row.Type !== "ACCREC" ||
    row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" || !row.Contact?.ContactID ||
    !row.Date || !Array.isArray(row.LineItems) || row.LineItems.length < 2 ||
    d702946AuthorisedDepositExistingDeductions(row).length !== 1 || financialSha256(row.LineItems.at(-1)) !== financialSha256(scope.deduction) ||
    JSON.stringify(row).includes(scope.depositXeroInvoiceId) || !/^[a-f0-9]{64}$/.test(payload.idempotencyKey)) {
    throw new Error("Authorised-Deposit recovery authorises only the exact D702946 bounded Main Draft append-only POST payload.");
  }
}
export function assertD702946AuthorisedDepositRecoveryReadback(actual: Record<string, any>, payload: FinancialDraftPayload): void {
  assertD702946AuthorisedDepositRecoveryPayload(payload);
  assertD702946AuthorisedDepositMainDraft(actual);
  assertFinalWeightReadback(actual, (payload.body.Invoices as Record<string, any>[])[0]!);
  if (exactCents(actual.SubTotal) !== 857460 || exactCents(actual.TotalTax) !== 85747 || exactCents(actual.Total) !== 943207 ||
    d702946AuthorisedDepositExistingDeductions(actual).length !== 1) throw new Error("Recovery readback does not prove the one exact $500 deduction.");
}
