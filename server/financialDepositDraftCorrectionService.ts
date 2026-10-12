import axios from "axios";
import { financialSha256 } from "./financialProposalIntegrity";
import { getDepositInvoiceReleasePolicy, assertDepositInvoiceRelease } from "./financialDepositInvoiceRelease";
import { preflightFinancialXeroIntents, readDepositInvoiceXeroItemConfiguration } from "./financialReadOnlyXeroService";
import { readMainCustomerInvoiceFacts } from "./financialMainCustomerInvoiceService";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const DEPOSIT_ITEM_CODE = "Deposit Required";

type XeroInvoice = Record<string, any>;
export type DepositDraftCorrectionPreview = {
  dealId: string;
  dealNumber: string;
  quoteNumber: string;
  depositDescription: string;
  depositInvoice: XeroInvoice;
  mainInvoice: XeroInvoice;
  depositPayload: FinancialDraftPayload;
  mainPayload: FinancialDraftPayload;
  mainTotalBefore: number;
  mainTotalAfter: number;
  deductionExclusive: number;
  deductionTax: number;
  deductionInclusive: number;
  noWrites: true;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
function date(value: unknown): string | null {
  const raw = String(value ?? "");
  const ms = raw.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
  const parsed = ms ? new Date(Number(ms[1])) : new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}
function presentString(value: unknown): string { return String(value ?? "").trim(); }

async function xeroGet(path: string, auth: { token: string; tenantId: string }) {
  return axios.get(`${XERO_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" },
  });
}

function completeInvoice(invoice: XeroInvoice, expectedNumber: string): XeroInvoice {
  if (!invoice || presentString(invoice.InvoiceNumber) !== expectedNumber || presentString(invoice.Status).toUpperCase() !== "DRAFT" || presentString(invoice.Type) !== "ACCREC" || !presentString(invoice.InvoiceID)) {
    throw new Error(`Only the exact current Draft ACCREC ${expectedNumber} can be corrected.`);
  }
  if (presentString(invoice.CurrencyCode) !== "AUD" || !presentString(invoice.LineAmountTypes) || !invoice.Contact?.ContactID || !date(invoice.DateString ?? invoice.Date) || !Array.isArray(invoice.LineItems) || !invoice.LineItems.length) {
    throw new Error(`Current Draft ${expectedNumber} lacks complete retained header/line evidence.`);
  }
  if (Number(invoice.AmountPaid ?? 0) !== 0 || Number(invoice.AmountCredited ?? 0) !== 0 || ["Payments", "CreditNotes", "Prepayments", "Overpayments"].some(key => Array.isArray(invoice[key]) && invoice[key].length)) {
    throw new Error(`Current Draft ${expectedNumber} has allocation evidence and cannot be corrected.`);
  }
  return invoice;
}

/** Retain only Xero writable header fields and every current line exactly. */
function writableDraft(invoice: XeroInvoice): XeroInvoice {
  const out: XeroInvoice = {};
  for (const key of ["InvoiceID", "InvoiceNumber", "Type", "Status", "Reference", "CurrencyCode", "CurrencyRate", "LineAmountTypes", "BrandingThemeID", "Url", "ExpectedPaymentDate", "PlannedPaymentDate"]) {
    if (invoice[key] !== undefined && invoice[key] !== null) out[key] = clone(invoice[key]);
  }
  out.Contact = { ContactID: presentString(invoice.Contact?.ContactID) };
  out.Date = date(invoice.DateString ?? invoice.Date);
  const dueDate = date(invoice.DueDateString ?? invoice.DueDate);
  if (dueDate) out.DueDate = dueDate;
  out.LineItems = clone(invoice.LineItems);
  return out;
}

function payload(invoice: XeroInvoice, sourceHash: string, correction: "deposit_description" | "main_deduction"): FinancialDraftPayload {
  const documentNumber = presentString(invoice.InvoiceNumber);
  const invoiceId = presentString(invoice.InvoiceID);
  return {
    method: "POST",
    endpoint: `/Invoices/${encodeURIComponent(invoiceId)}`,
    documentFamily: "customer_invoice",
    documentNumber,
    expectedXeroDocumentId: invoiceId,
    body: { Invoices: [invoice] },
    idempotencyKey: financialSha256({ workflow: "deposit_draft_correction", correction, sourceHash, invoice }),
  };
}

function expectedDescription(template: string, quoteNumber: string, mainInvoiceNumber: string): string {
  const rendered = template.replace(/Q<>/g, quoteNumber).replace(/INV-<>/g, mainInvoiceNumber).replace(/\s+/g, " ").trim();
  if (rendered !== `Deposit for ${quoteNumber} from ${mainInvoiceNumber}`) {
    throw new Error("Current Xero Deposit Required item description is not the approved Deposit template.");
  }
  return rendered;
}

/** GET-only exact Draft/source preflight. No local rows or Xero writes are created. */
export async function previewDepositDraftCorrection(dealId: string): Promise<DepositDraftCorrectionPreview> {
  const facts = await readMainCustomerInvoiceFacts(dealId);
  if (!/^D\d{1,12}$/i.test(facts.dealNumber) || !/^Q\d{1,12}$/i.test(facts.quoteNumber)) throw new Error("Current Deal/Quote numbers are not suitable for the approved Deposit correction.");
  const mainNumber = `INV-${facts.dealNumber.slice(1)}`;
  const depositNumber = `${mainNumber}-D`;
  // This existing guarded GET-only path proves expected tenant plus exact number/contact states.
  const intents = [mainNumber, depositNumber].map(number => ({ documentFamily: "customer_invoice" as const, documentType: "deposit_correction", proposedAction: "update_draft" as const, proposedDocumentNumber: number, reference: null, partyName: facts.customerName, partySourceId: null, accountCode: "200", gstTreatment: "GST_EXCLUSIVE" as const, currency: "AUD" as const, subtotal: 0, taxAmount: 0, total: 0, issueDate: new Date(), dueDate: null, lineItems: [{ itemCode: "", description: "evidence", quantity: 1, unitAmount: 0, lineAmount: 0, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" as const }], sourceWorkflow: "deposit_invoice" as const, sourceRecordId: dealId, validationStatus: "valid" as const }));
  const preflight = await preflightFinancialXeroIntents(intents);
  if (preflight.some(item => item.duplicateState !== "found" || item.status !== "DRAFT" || !item.xeroDocumentId || !item.contactCheck.found || !item.contactCheck.contactId)) throw new Error("Exact current Deposit/main Draft, customer or tenant preflight is incomplete.");
  const auth = await getXeroReadAuthWithRefresh();
  const [mainResponse, depositResponse, itemResponse, itemConfig] = await Promise.all([
    xeroGet(`/Invoices/${encodeURIComponent(preflight[0]!.xeroDocumentId!)}`, auth),
    xeroGet(`/Invoices/${encodeURIComponent(preflight[1]!.xeroDocumentId!)}`, auth),
    xeroGet(`/Items/${encodeURIComponent(DEPOSIT_ITEM_CODE)}`, auth),
    readDepositInvoiceXeroItemConfiguration(),
  ]);
  const main = completeInvoice(mainResponse.data?.Invoices?.[0], mainNumber);
  const deposit = completeInvoice(depositResponse.data?.Invoices?.[0], depositNumber);
  if (main.LineAmountTypes !== "Exclusive" || deposit.LineAmountTypes !== "Inclusive" || main.Contact?.ContactID !== deposit.Contact?.ContactID || main.Contact?.ContactID !== preflight[0]!.contactCheck.contactId) throw new Error("Deposit and main Draft GST/contact evidence is incompatible.");
  if (!Array.isArray(deposit.LineItems) || deposit.LineItems.length !== 1 || presentString(deposit.LineItems[0]?.ItemCode) !== DEPOSIT_ITEM_CODE || Number(deposit.Total) <= 0 || Math.abs(Number(deposit.Total) - Number(deposit.LineItems[0]?.LineAmount)) > 0.01) throw new Error("Exact Deposit Draft has unexpected lines or amount; correction is held.");
  const item = (itemResponse.data?.Items ?? []).find((row: any) => row?.Code === DEPOSIT_ITEM_CODE);
  const description = expectedDescription(presentString(item?.Description), facts.quoteNumber, mainNumber);
  const deductionInclusive = money(Number(deposit.Total));
  const deductionExclusive = money(deductionInclusive / 1.1);
  const deductionTax = money(deductionInclusive - deductionExclusive);
  if (!Number.isFinite(deductionExclusive) || deductionExclusive <= 0 || presentString(itemConfig.accountCode) !== "200") throw new Error("Current Deposit account/amount cannot support the approved correction.");
  const expectedDeposit = writableDraft(deposit);
  expectedDeposit.LineItems[0].Description = description;
  const expectedMain = writableDraft(main);
  expectedMain.LineItems.push({ Description: `Deposit deduction — ${depositNumber}`, Quantity: 1, UnitAmount: -deductionExclusive, AccountCode: itemConfig.accountCode, TaxType: "OUTPUT" });
  const sourceHash = financialSha256({ dealId, facts, main, deposit, description, deductionExclusive, deductionTax, deductionInclusive, itemConfig });
  return { dealId, dealNumber: facts.dealNumber, quoteNumber: facts.quoteNumber, depositDescription: description, depositInvoice: deposit, mainInvoice: main,
    depositPayload: payload(expectedDeposit, sourceHash, "deposit_description"), mainPayload: payload(expectedMain, sourceHash, "main_deduction"),
    mainTotalBefore: money(Number(main.Total)), mainTotalAfter: money(Number(main.Total) - deductionInclusive), deductionExclusive, deductionTax, deductionInclusive, noWrites: true };
}

/** Approved incident correction only: Deposit description first, then the exact main Draft deduction. */
export async function applyApprovedDepositDraftCorrection(dealId: string) {
  const policy = await getDepositInvoiceReleasePolicy();
  assertDepositInvoiceRelease(policy);
  const first = await previewDepositDraftCorrection(dealId);
  const context = (kind: "deposit_description" | "main_deduction") => ({ workflowType: "deposit_draft_correction", approvalReference: policy.releaseKey, globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, depositDraftCorrectionKind: kind, depositDraftCorrectionReleaseKey: policy.releaseKey, depositDraftCorrectionApprovedBy: policy.approvedBy! });
  const depositResult = await executeGuardedFinancialWriterCommand({ workflowType: "deposit_draft_correction", proposedAction: "update_draft", payload: first.depositPayload, preparedBy: policy.approvedBy!, authorisation: context("deposit_description"), expectedExactDraft: (first.depositPayload.body.Invoices as Record<string, any>[])[0]! });
  if (depositResult.outcome !== "succeeded") return { ok: false as const, stage: "deposit_description" as const, outcome: depositResult };
  // Fresh evidence after the first update prevents a stale main-Draft amendment.
  const second = await previewDepositDraftCorrection(dealId);
  if (second.depositDescription !== first.depositDescription || second.mainTotalBefore !== first.mainTotalBefore || financialSha256(second.mainPayload.body) !== financialSha256(first.mainPayload.body)) throw new Error("Current correction evidence changed after Deposit description update; main Draft deduction is held.");
  const mainResult = await executeGuardedFinancialWriterCommand({ workflowType: "deposit_draft_correction", proposedAction: "update_draft", payload: second.mainPayload, preparedBy: policy.approvedBy!, authorisation: context("main_deduction"), expectedExactDraft: (second.mainPayload.body.Invoices as Record<string, any>[])[0]! });
  if (mainResult.outcome !== "succeeded") return { ok: false as const, stage: "main_deduction" as const, outcome: mainResult };
  return { ok: true as const, depositExecutionId: depositResult.executionId, mainExecutionId: mainResult.executionId, depositInvoiceNumber: first.depositPayload.documentNumber, mainInvoiceNumber: first.mainPayload.documentNumber, mainTotalBefore: first.mainTotalBefore, mainTotalAfter: first.mainTotalAfter };
}
