import { financialSha256 } from "./financialProposalIntegrity";
import { writableDraft } from "./financialDepositDraftCorrectionService";
import { assertFinalWeightReadback } from "./financialFinalWeightAdjustmentRules";
import type { FinancialDraftPayload } from "./financialProductionWriter";

/** Closed incident scope. This is not a replacement eligibility rule for the generic deduction. */
export const D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE = Object.freeze({
  workflowType: "d702946_deposit_main_deduction_recovery",
  dealId: "5x490313", dealNumber: "D702946", originalMainEventId: 750001,
  failedMainWriterExecutionId: 1110001, mainRecoveryEventId: 1,
  mainRecoveryWriterExecutionId: 1170001, depositEventId: 270001,
  mainInvoiceNumber: "INV-702946", mainXeroInvoiceId: "17a162b6-348c-4409-b4c2-562730659696",
  depositInvoiceNumber: "INV-702946-D", depositXeroInvoiceId: "a52b0ac4-9de9-4007-85ac-731a7f3d1da0",
  depositAmountRequiredInclusive: 500,
  deduction: Object.freeze({ Description: "Less deposit invoice INV-702946-D", Quantity: 1,
    UnitAmount: -454.55, LineAmount: -454.55, TaxAmount: -45.45, AccountCode: "200", TaxType: "OUTPUT" }),
});
export const D702946_RECOVERY_SCOPE_KEY = "D702946-deposit-main-deduction-recovery-v1";
export const D702946_RECOVERY_RELEASE_KEY = "D702946-DEPOSIT-MAIN-DEDUCTION-RECOVERY-V1";
const scope = D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE;
export const jsonEvidence = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function exactCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001)
    throw new Error("Recovery monetary evidence must be finite exact numeric cents.");
  return Math.round(value * 100);
}
/** Xero returns `null` rather than numeric zero for AmountCredited on some unpaid Drafts. */
function zeroOutstandingAmount(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value) && value === 0);
}
export function assertD702946RecoverySource(main: Record<string, any>, deposit: Record<string, any>): void {
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
export function d702946ExistingDeductions(main: Record<string, any>): Record<string, any>[] {
  return (Array.isArray(main.LineItems) ? main.LineItems : []).filter((line: any) =>
    markers.some(marker => String(line?.Description ?? "").includes(marker)));
}
export function assertD702946RecoveryDraft(invoice: Record<string, any>, kind: "main" | "deposit"): void {
  const main = kind === "main";
  if (!invoice || invoice.InvoiceNumber !== (main ? scope.mainInvoiceNumber : scope.depositInvoiceNumber) ||
    invoice.InvoiceID !== (main ? scope.mainXeroInvoiceId : scope.depositXeroInvoiceId) || invoice.Type !== "ACCREC" ||
    invoice.Status !== "DRAFT" || invoice.CurrencyCode !== "AUD" || invoice.LineAmountTypes !== (main ? "Exclusive" : "Inclusive") ||
    typeof invoice.Contact?.ContactID !== "string" || !invoice.Contact.ContactID.trim() ||
    !Array.isArray(invoice.LineItems) || !invoice.LineItems.length || !writableDraft(invoice).Date ||
    !zeroOutstandingAmount(invoice.AmountPaid) || !zeroOutstandingAmount(invoice.AmountCredited) ||
    ["Payments", "CreditNotes", "Prepayments", "Overpayments"].some(key => invoice[key] != null && (!Array.isArray(invoice[key]) || invoice[key].length))) {
    throw new Error(`Exact ${kind} recovery invoice must be an unallocated AUD ACCREC DRAFT with complete evidence.`);
  }
  // Full cent-level totals and lines, rather than accepting rounded near matches.
  const net = exactCents(invoice.SubTotal), tax = exactCents(invoice.TotalTax), total = exactCents(invoice.Total);
  const lines = invoice.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.LineAmount), 0);
  const lineTax = invoice.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.TaxAmount), 0);
  if (net + tax !== total || lineTax !== tax || (main ? lines !== net : lines !== total)) throw new Error("Full Draft line/tax totals are inconsistent.");
  if (!main) {
    const line = invoice.LineItems[0];
    if (invoice.LineItems.length !== 1 || line.ItemCode !== "Deposit Required" || line.Quantity !== 1 ||
      exactCents(line.UnitAmount) !== 50000 || exactCents(line.LineAmount) !== 50000 || total !== 50000 ||
      line.AccountCode !== "200" || line.TaxType !== "OUTPUT") throw new Error("Exact Deposit must be one inclusive $500 Deposit Required line.");
  }
}
export function assertD702946RecoveryPair(main: Record<string, any>, deposit: Record<string, any>): void {
  assertD702946RecoveryDraft(main, "main"); assertD702946RecoveryDraft(deposit, "deposit");
  if (main.Contact.ContactID !== deposit.Contact.ContactID) throw new Error("Recovery Drafts must retain the same nonempty ContactID.");
}
/** Retains the established complete writable Draft header and every full existing line verbatim. */
export function prepareD702946DepositMainDeductionRecoveryPayload(main: Record<string, any>, deposit: Record<string, any>, evidenceHash: string): FinancialDraftPayload {
  assertD702946RecoveryPair(main, deposit);
  if (d702946ExistingDeductions(main).length) throw new Error("Existing Deposit deduction: already present or ambiguous; never append again.");
  if (exactCents(main.SubTotal) !== 902915 || exactCents(main.TotalTax) !== 90292 || exactCents(main.Total) !== 993207)
    throw new Error("Main recovered Draft totals no longer equal the exact approved starting state.");
  const next = writableDraft(main);
  next.LineItems.push(jsonEvidence(scope.deduction));
  return { method: "POST", endpoint: `/Invoices/${scope.mainXeroInvoiceId}`, documentFamily: "customer_invoice",
    documentNumber: scope.mainInvoiceNumber, expectedXeroDocumentId: scope.mainXeroInvoiceId,
    body: { Invoices: [next] }, idempotencyKey: financialSha256({ workflow: scope.workflowType, evidenceHash, body: { Invoices: [next] } }) };
}
export function assertD702946RecoveryPayload(payload: FinancialDraftPayload): void {
  const rows = payload.body.Invoices as Record<string, any>[];
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (payload.method !== "POST" || payload.endpoint !== `/Invoices/${scope.mainXeroInvoiceId}` ||
    payload.expectedXeroDocumentId !== scope.mainXeroInvoiceId || payload.documentNumber !== scope.mainInvoiceNumber ||
    payload.documentFamily !== "customer_invoice" || Object.keys(payload.body).length !== 1 || !row ||
    row.InvoiceID !== scope.mainXeroInvoiceId || row.InvoiceNumber !== scope.mainInvoiceNumber || row.Type !== "ACCREC" ||
    row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" ||
    !row.Contact?.ContactID || !row.Date || !Array.isArray(row.LineItems) || row.LineItems.length < 2 ||
    d702946ExistingDeductions(row).length !== 1 || financialSha256(row.LineItems.at(-1)) !== financialSha256(scope.deduction) ||
    !/^[a-f0-9]{64}$/.test(payload.idempotencyKey)) throw new Error("Recovery authorises only the exact D702946 bounded append-only POST payload.");
}
export function assertD702946RecoveryReadback(actual: Record<string, any>, payload: FinancialDraftPayload): void {
  assertD702946RecoveryPayload(payload);
  assertD702946RecoveryDraft(actual, "main");
  assertFinalWeightReadback(actual, (payload.body.Invoices as Record<string, any>[])[0]!);
  if (exactCents(actual.SubTotal) !== 857460 || exactCents(actual.TotalTax) !== 85747 || exactCents(actual.Total) !== 943207 ||
    d702946ExistingDeductions(actual).length !== 1) throw new Error("Recovery readback does not prove the one exact $500 deduction.");
}
