import { financialSha256 } from "./financialProposalIntegrity";
import { writableDraft } from "./financialDepositDraftCorrectionService";
import { assertFinalWeightReadback } from "./financialFinalWeightAdjustmentRules";
import type { FinancialDraftPayload } from "./financialProductionWriter";

/**
 * Closed, one-document exception. This is intentionally not a generic
 * Authorised-Deposit rule and cannot be parameterised by a caller.
 *
 * Main and Deposit Xero identities were resolved from the locally retained
 * D702959 readback evidence before this scope was written. They are still
 * independently re-proved through exact number-to-ID and full-ID Xero GETs
 * before every reservation and immediately before the single POST.
 */
export const D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE = Object.freeze({
  workflowType: "d702959_authorised_deposit_main_deduction_recovery",
  dealId: "5x492104", dealNumber: "D702959",
  originalMainEventId: 1290001, failedMainWriterExecutionId: 2070001,
  depositEventId: 540001, depositWriterExecutionId: 2130001,
  mainInvoiceNumber: "INV-702959", mainXeroInvoiceId: "2f392a0b-e8fb-43f4-a91a-27801b0350fe",
  depositInvoiceNumber: "INV-702959-D", depositXeroInvoiceId: "612b0c98-0c41-48dc-8cb1-4451da360784",
  mainStatus: "DRAFT", depositEvidenceStatus: "AUTHORISED",
  deductionDescription: "Less deposit invoice INV-702959-D",
  originalMainWriterError: "Xero Draft INV-702959 does not match the exact storage contact, lines, account or totals.",
});
export const D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY = "D702959-authorised-deposit-main-deduction-recovery-v1";
export const D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY = "D702959-AUTHORISED-DEPOSIT-MAIN-DEDUCTION-RECOVERY-V1";
const scope = D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE;

export const jsonEvidence = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function exactCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) {
    throw new Error("D702959 recovery monetary evidence must be finite exact numeric cents.");
  }
  return Math.round(value * 100);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
/** Xero can represent a zero credit as null on an unallocated invoice. */
function zero(value: unknown): boolean { return value == null || (typeof value === "number" && Number.isFinite(value) && value === 0); }
function unallocated(invoice: Record<string, any>): boolean {
  return zero(invoice.AmountPaid) && zero(invoice.AmountCredited) &&
    ["Payments", "CreditNotes", "Prepayments", "Overpayments"].every(key => invoice[key] == null || (Array.isArray(invoice[key]) && invoice[key].length === 0));
}
function invoiceDate(invoice: Record<string, any>): string | null {
  const raw = String(invoice.DateString ?? invoice.Date ?? "");
  const ms = raw.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
  const date = new Date(ms ? Number(ms[1]) : raw);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
function fullTotals(invoice: Record<string, any>, lineAmountIsTotal: boolean): void {
  const net = exactCents(invoice.SubTotal), tax = exactCents(invoice.TotalTax), total = exactCents(invoice.Total);
  if (net + tax !== total) throw new Error("D702959 recovery invoice subtotal/tax/total is inconsistent.");
  const lines = invoice.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.LineAmount), 0);
  const taxes = invoice.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.TaxAmount), 0);
  if ((lineAmountIsTotal ? lines !== total : lines !== net) || taxes !== tax) {
    throw new Error("D702959 recovery invoice full line/tax totals are inconsistent.");
  }
}

/** No amount is embedded in the scope: current source and current Xero evidence must agree. */
export function assertD702959AuthorisedDepositRecoverySource(main: Record<string, any>, deposit: Record<string, any>): void {
  if (main?.dealId !== scope.dealId || deposit?.dealId !== scope.dealId || main?.dealNumber !== scope.dealNumber ||
    deposit?.dealNumber !== scope.dealNumber || main.sourceHoldReason || deposit.sourceHoldReason ||
    !nonempty(main.sourceRefreshedAt) || !nonempty(deposit.sourceRefreshedAt) || !Number.isFinite(Date.parse(main.sourceRefreshedAt)) ||
    !Number.isFinite(Date.parse(deposit.sourceRefreshedAt)) || !nonempty(main.quoteId) || main.quoteId !== deposit.quoteId ||
    !nonempty(main.quoteNumber) || main.quoteNumber !== deposit.quoteNumber || !/^\d+x\d+$/i.test(main.customerVtigerId ?? "") || !nonempty(main.customerName) ||
    main.customerVtigerId !== deposit.customerVtigerId || main.customerKind !== deposit.customerKind || main.customerName.trim() !== deposit.customerName?.trim() ||
    !/^\d+x\d+$/i.test(deposit.customerVtigerId ?? "") || !nonempty(deposit.customerName) ||
    deposit.mappingEvidence?.depositAmountRequired !== "cf_potentials_extras" || exactCents(deposit.depositAmountRequiredInclusive) <= 0) {
    throw new Error("Only the exact current D702959/5x492104 source with a positive mapped Deposit Amount Required may recover.");
  }
}

const markers = [scope.deductionDescription, `Deposit deduction — ${scope.depositInvoiceNumber}`];
/** Containment is intentional: an annotated prior deduction is ambiguous and holds. */
export function d702959AuthorisedDepositExistingDeductions(main: Record<string, any>): Record<string, any>[] {
  return (Array.isArray(main?.LineItems) ? main.LineItems : []).filter((line: any) =>
    markers.some(marker => String(line?.Description ?? "").includes(marker)));
}

/** Only an exact, complete, unallocated Main Draft can ever be the payload target. */
export function assertD702959AuthorisedDepositMainDraft(invoice: Record<string, any>): void {
  if (!invoice || invoice.InvoiceID !== scope.mainXeroInvoiceId || invoice.InvoiceNumber !== scope.mainInvoiceNumber ||
    invoice.Type !== "ACCREC" || invoice.Status !== scope.mainStatus || invoice.CurrencyCode !== "AUD" ||
    invoice.LineAmountTypes !== "Exclusive" || !nonempty(invoice.Contact?.ContactID) || !invoiceDate(invoice) || !unallocated(invoice) ||
    !Array.isArray(invoice.LineItems) || invoice.LineItems.length < 1) {
    throw new Error("Only the exact D702959 Main unallocated AUD ACCREC DRAFT with complete evidence may recover.");
  }
  const ids = new Set<string>();
  for (const line of invoice.LineItems) {
    const deductionLine = markers.some(marker => String(line?.Description ?? "").includes(marker));
    if (!line || (!deductionLine && (!nonempty(line.LineItemID) || ids.has(line.LineItemID) || !Array.isArray(line.Tracking))) || typeof line.Description !== "string" ||
      !Number.isFinite(Number(line.Quantity)) || !Number.isFinite(Number(line.UnitAmount)) ||
      !nonempty(line.AccountCode) || !nonempty(line.TaxType)) {
      throw new Error("Every retained D702959 Main line must have its exact ID, description, amount, account/tax and tracking evidence.");
    }
    exactCents(line.LineAmount); exactCents(line.TaxAmount); if (!deductionLine) ids.add(line.LineItemID);
  }
  if (exactCents(invoice.AmountDue) !== exactCents(invoice.Total)) throw new Error("D702959 Main Draft is not wholly outstanding.");
  fullTotals(invoice, false);
}

/** Evidence only. This function cannot make the Authorised Deposit a write target. */
export function assertD702959AuthorisedDepositEvidence(invoice: Record<string, any>): void {
  if (!invoice || invoice.InvoiceID !== scope.depositXeroInvoiceId || invoice.InvoiceNumber !== scope.depositInvoiceNumber ||
    invoice.Type !== "ACCREC" || invoice.Status !== scope.depositEvidenceStatus || invoice.CurrencyCode !== "AUD" ||
    invoice.LineAmountTypes !== "Inclusive" || !nonempty(invoice.Contact?.ContactID) || !invoiceDate(invoice) || !unallocated(invoice) ||
    !Array.isArray(invoice.LineItems) || invoice.LineItems.length !== 1) {
    throw new Error("Only the exact D702959 wholly outstanding AUD ACCREC AUTHORISED Deposit is evidence.");
  }
  const line = invoice.LineItems[0]!;
  if (!line || line.ItemCode !== "Deposit Required" || Number(line.Quantity) !== 1 || line.AccountCode !== "200" || line.TaxType !== "OUTPUT" ||
    exactCents(line.UnitAmount) !== exactCents(invoice.Total) || exactCents(line.LineAmount) !== exactCents(invoice.Total) ||
    exactCents(invoice.AmountDue) !== exactCents(invoice.Total)) {
    throw new Error("D702959 Authorised Deposit must remain one wholly outstanding inclusive Deposit Required/200/OUTPUT line.");
  }
  fullTotals(invoice, true);
}

export function assertD702959AuthorisedDepositRecoveryPair(main: Record<string, any>, deposit: Record<string, any>): void {
  assertD702959AuthorisedDepositMainDraft(main); assertD702959AuthorisedDepositEvidence(deposit);
  if (main.Contact.ContactID !== deposit.Contact.ContactID) throw new Error("D702959 Main Draft and Authorised Deposit must retain the same exact ContactID.");
}
export function assertD702959DepositMatchesSource(depositFacts: Record<string, any>, deposit: Record<string, any>): void {
  if (!depositFacts || depositFacts.dealId !== scope.dealId || depositFacts.dealNumber !== scope.dealNumber || depositFacts.sourceHoldReason ||
    !nonempty(depositFacts.sourceRefreshedAt) || !Number.isFinite(Date.parse(depositFacts.sourceRefreshedAt)) ||
    !nonempty(depositFacts.customerVtigerId) || !nonempty(depositFacts.customerName) ||
    depositFacts.mappingEvidence?.depositAmountRequired !== "cf_potentials_extras" || exactCents(depositFacts.depositAmountRequiredInclusive) <= 0) {
    throw new Error("Current D702959 mapped Deposit Amount Required source evidence is incomplete.");
  }
  assertD702959AuthorisedDepositEvidence(deposit);
  if (exactCents(depositFacts.depositAmountRequiredInclusive) !== exactCents(deposit.Total)) {
    throw new Error("Current D702959 Deposit Amount Required does not equal the current Authorised Deposit inclusive total.");
  }
}

/** Derives the negative exclusive/tax/inclusive result from the currently proved inclusive Deposit, never a constant. */
export function d702959AuthorisedDepositDeduction(deposit: Record<string, any>): Record<string, any> {
  assertD702959AuthorisedDepositEvidence(deposit);
  const inclusive = exactCents(deposit.Total), tax = exactCents(deposit.TotalTax), exclusive = exactCents(deposit.SubTotal);
  if (exclusive + tax !== inclusive || inclusive <= 0 || exclusive <= 0 || tax < 0) throw new Error("D702959 current Deposit cannot produce a safe negative deduction.");
  return Object.freeze({ Description: scope.deductionDescription, Quantity: 1,
    UnitAmount: -exclusive / 100, LineAmount: -exclusive / 100, TaxAmount: -tax / 100, AccountCode: "200", TaxType: "OUTPUT" });
}

/** Retains every writable Main header and every full retained line in order; only the final new line is appended. */
export function prepareD702959AuthorisedDepositMainDeductionRecoveryPayload(main: Record<string, any>, deposit: Record<string, any>, evidenceHash: string): FinancialDraftPayload {
  if (d702959AuthorisedDepositExistingDeductions(main).length) throw new Error("Existing D702959 Deposit deduction is already present or ambiguous; never append again.");
  assertD702959AuthorisedDepositRecoveryPair(main, deposit);
  const next = writableDraft(main);
  const retained = jsonEvidence(main.LineItems);
  next.LineItems = retained;
  next.LineItems.push(jsonEvidence(d702959AuthorisedDepositDeduction(deposit)));
  const body = { Invoices: [next] };
  const payload: FinancialDraftPayload = { method: "POST", endpoint: `/Invoices/${scope.mainXeroInvoiceId}`, documentFamily: "customer_invoice",
    documentNumber: scope.mainInvoiceNumber, expectedXeroDocumentId: scope.mainXeroInvoiceId, body,
    idempotencyKey: financialSha256({ workflow: scope.workflowType, evidenceHash, body }) };
  assertD702959AuthorisedDepositRecoveryPayload(payload);
  return payload;
}

/** Structural boundary only; the ledger also proves the full independently rebuilt payload hash. */
export function assertD702959AuthorisedDepositRecoveryPayload(payload: FinancialDraftPayload): void {
  const rows = payload?.body?.Invoices as Record<string, any>[];
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  const deduction = row?.LineItems?.at(-1);
  const retained = Array.isArray(row?.LineItems) ? row.LineItems.slice(0, -1) : [];
  const retainedIds = new Set(retained.map((line: any) => line?.LineItemID));
  const deductionNet = deduction ? exactCents(deduction.LineAmount) : 0;
  const deductionTax = deduction ? exactCents(deduction.TaxAmount) : 0;
  if (payload.method !== "POST" || payload.endpoint !== `/Invoices/${scope.mainXeroInvoiceId}` ||
    payload.expectedXeroDocumentId !== scope.mainXeroInvoiceId || payload.documentNumber !== scope.mainInvoiceNumber ||
    payload.documentFamily !== "customer_invoice" || Object.keys(payload.body).length !== 1 || !row ||
    row.InvoiceID !== scope.mainXeroInvoiceId || row.InvoiceNumber !== scope.mainInvoiceNumber || row.Type !== "ACCREC" ||
    row.Status !== "DRAFT" || row.CurrencyCode !== "AUD" || row.LineAmountTypes !== "Exclusive" || !nonempty(row.Contact?.ContactID) ||
    !row.Date || !Array.isArray(row.LineItems) || row.LineItems.length < 2 || retained.length < 1 ||
    retained.some((line: any) => !nonempty(line?.LineItemID) || !Array.isArray(line?.Tracking)) || retainedIds.size !== retained.length ||
    d702959AuthorisedDepositExistingDeductions(row).length !== 1 || deduction?.Description !== scope.deductionDescription ||
    deduction?.Quantity !== 1 || deduction?.AccountCode !== "200" || deduction?.TaxType !== "OUTPUT" ||
    deduction?.LineItemID !== undefined || deductionNet >= 0 || deductionTax > 0 || exactCents(deduction.UnitAmount) !== deductionNet ||
    deductionNet + deductionTax >= 0 || JSON.stringify(row).includes(scope.depositXeroInvoiceId) || !/^[a-f0-9]{64}$/.test(payload.idempotencyKey)) {
    throw new Error("D702959 recovery authorises only its exact Main-Draft append-only payload; the Authorised Deposit remains evidence only.");
  }
}

/**
 * Exact POST readback: all retained headers/lines plus one deduction, never a
 * Deposit mutation. The authorised payload appends the line last, but Xero is
 * permitted to reorder Draft lines after a POST; `assertFinalWeightReadback`
 * therefore matches retained LineItemIDs and the generated line by its exact
 * fields independently of display order.
 */
export function assertD702959AuthorisedDepositRecoveryReadback(actual: Record<string, any>, payload: FinancialDraftPayload): void {
  assertD702959AuthorisedDepositRecoveryPayload(payload);
  assertD702959AuthorisedDepositMainDraft(actual);
  const expected = (payload.body.Invoices as Record<string, any>[])[0]!;
  assertFinalWeightReadback(actual, expected);
  if (d702959AuthorisedDepositExistingDeductions(actual).length !== 1 ||
    exactCents(actual.SubTotal) !== actual.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.LineAmount), 0) ||
    exactCents(actual.TotalTax) !== actual.LineItems.reduce((sum: number, line: any) => sum + exactCents(line.TaxAmount), 0) ||
    exactCents(actual.SubTotal) + exactCents(actual.TotalTax) !== exactCents(actual.Total)) {
    throw new Error("D702959 recovery readback does not prove the exact one-line negative Deposit deduction.");
  }
}
