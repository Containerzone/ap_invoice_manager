import { DEFAULT_FINANCIAL_AUTOMATION_RULES } from "./financialAutomationRules";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";

export type FinalWeightDirection = "overweight" | "underweight";
export const FINAL_WEIGHT_RULES_VERSION = "2026-10-11.final-weight.draft-amendment.v1";
export const FINAL_WEIGHT_RULES_HASH = financialSha256({ version: FINAL_WEIGHT_RULES_VERSION, item: DEFAULT_FINANCIAL_AUTOMATION_RULES.itemCodes.overweight, scope: "new_events_only", operations: ["positive-exclusive-SER70-replacement", "due-date-only"], preserve: "all-retained-lines-and-invoice-fields" });
export const FINAL_WEIGHT_PATHS = {
  overweight: "/api/webhooks/vtiger/final-weight-overweight",
  underweight: "/api/webhooks/vtiger/final-weight-underweight",
} as const;
export type FinalWeightFacts = {
  dealId: string; dealNumber: string; dealName: string;
  customerVtigerId: string; customerName: string; customerKind: "organisation" | "contact";
  estimatedWeight: number | null; actualWeight: number | null; perExtraTonne: number | null;
  requiredDueDate: string | null; sourceRefreshedAt: string | null; customerRefreshedAt: string | null;
  mappingEvidence: Record<string, string>; sourceHoldReason: string | null;
};
export type FinalWeightXeroEvidence = {
  exactMatches: Record<string, any>[]; invoice: Record<string, any> | null;
  contact: { count: number; contactId: string | null; partyName: string };
  ser70: { itemCode: "SER70"; accountCode: string; taxType: "OUTPUT" } | null;
};
export type FinalWeightPreview = {
  direction: FinalWeightDirection; eligible: boolean; invoiceNumber: string | null;
  invoiceId: string | null; holdReason: string | null; originalDraft: Record<string, any> | null;
  expectedDraft: Record<string, any> | null; excessAmountExclusive: number | null;
};
export function finalWeightDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const ms = raw.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
  if (ms) { const date = new Date(Number(ms[1])); return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null; }
  // No locale or timestamp fallback for source dates. Xero DateString may be ISO midnight.
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?(?:Z)?)?$/)?.[1];
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Writable invoice header plus EVERY full source line (IDs, tracking, discounts, tax included). */
export function finalWeightDraftEvidence(invoice: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of ["InvoiceID", "InvoiceNumber", "Type", "Status", "Reference", "CurrencyCode", "CurrencyRate", "LineAmountTypes", "BrandingThemeID", "Url", "ExpectedPaymentDate", "PlannedPaymentDate"]) {
    if (invoice[key] !== undefined && invoice[key] !== null) result[key] = clone(invoice[key]);
  }
  result.Contact = { ContactID: invoice.Contact?.ContactID ?? "" };
  result.Date = finalWeightDate(invoice.DateString ?? invoice.Date);
  result.DueDate = finalWeightDate(invoice.DueDateString ?? invoice.DueDate);
  result.LineItems = clone(invoice.LineItems ?? []);
  return result;
}
export function finalWeightSourceHold(facts: FinalWeightFacts, direction: FinalWeightDirection): string | null {
  if (facts.sourceHoldReason) return facts.sourceHoldReason;
  if (!/^\d+x\d{1,12}$/i.test(facts.dealId) || !/^D\d{1,12}$/i.test(facts.dealNumber) || !facts.dealName.trim()) return "An exact named current D-number Deal is required.";
  if (!/^\d+x\d+$/i.test(facts.customerVtigerId) || !facts.customerName.trim()) return "Exact linked current Deal customer is required.";
  if (facts.estimatedWeight === null || facts.actualWeight === null || !Number.isFinite(facts.estimatedWeight) || !Number.isFinite(facts.actualWeight) || facts.estimatedWeight < 0 || facts.actualWeight < 0) return "Current actual and estimated weight must be finite non-negative tonnes.";
  const difference = facts.actualWeight - facts.estimatedWeight;
  if (direction === "overweight" && difference <= 0 || direction === "underweight" && difference >= 0) return "Current weights do not match the dedicated route direction (equal weight is held).";
  if (direction === "overweight" && (facts.perExtraTonne === null || !Number.isFinite(facts.perExtraTonne) || facts.perExtraTonne <= 0)) return "Overweight requires a positive current per-extra-tonne GST-exclusive value.";
  if (direction === "underweight" && !finalWeightDate(facts.requiredDueDate)) return "Underweight requires the verified Full Container Pickup DATE; no invented fallback is allowed.";
  return null;
}
export function buildFinalWeightAdjustment(facts: FinalWeightFacts, direction: FinalWeightDirection, xero: FinalWeightXeroEvidence | null): FinalWeightPreview {
  const number = /^D\d{1,12}$/i.test(facts.dealNumber) ? `INV-${facts.dealNumber.slice(1)}` : null;
  const held = (reason: string): FinalWeightPreview => ({ direction, eligible: false, invoiceNumber: number, invoiceId: xero?.invoice?.InvoiceID ?? null, holdReason: reason, originalDraft: null, expectedDraft: null, excessAmountExclusive: null });
  const sourceHold = finalWeightSourceHold(facts, direction);
  if (sourceHold) return held(sourceHold);
  if (!xero || xero.exactMatches.length !== 1) return held("The exact current main invoice is missing or ambiguous, including deleted/voided history. Never create, adopt or suffix an invoice.");
  const invoice = xero.invoice;
  const match = xero.exactMatches[0]!;
  if (!invoice || !invoice.InvoiceID || invoice.InvoiceID !== match.InvoiceID || invoice.InvoiceNumber !== number || match.InvoiceNumber !== number || invoice.Status !== "DRAFT" || match.Status !== "DRAFT" || invoice.Type !== "ACCREC" || match.Type !== "ACCREC") return held("Only the exact same CURRENT DRAFT ACCREC main invoice ID and number may be amended.");
  if (invoice.CurrencyCode !== "AUD" || invoice.LineAmountTypes !== "Exclusive" || Number(invoice.AmountPaid ?? 0) !== 0 || Number(invoice.AmountCredited ?? 0) !== 0 || (invoice.Payments?.length ?? 0) || (invoice.CreditNotes?.length ?? 0) || (invoice.Prepayments?.length ?? 0) || (invoice.Overpayments?.length ?? 0)) return held("Main invoice currency/GST/payment evidence is not an unallocated AUD GST-exclusive Draft.");
  if (xero.contact.count !== 1 || !xero.contact.contactId || xero.contact.partyName !== facts.customerName || invoice.Contact?.ContactID !== xero.contact.contactId || match.Contact?.ContactID !== xero.contact.contactId) return held("Exact current Deal customer does not uniquely match the Draft invoice contact.");
  if (!finalWeightDate(invoice.DateString ?? invoice.Date) || !finalWeightDate(invoice.DueDateString ?? invoice.DueDate)) return held("Existing Draft dates are missing or ambiguous; retained dates cannot be invented.");
  const lines = invoice.LineItems;
  if (!Array.isArray(lines) || !lines.length || lines.some((line: any) => !line || !String(line.LineItemID ?? "").trim() || typeof line.Description !== "string" ||
    ["Quantity", "UnitAmount", "LineAmount", "TaxAmount"].some(key => line[key] === null || line[key] === undefined || line[key] === "" || !Number.isFinite(Number(line[key]))) ||
    !String(line.AccountCode ?? "").trim() || !String(line.TaxType ?? "").trim()) || new Set(lines.map((line: any) => line.LineItemID)).size !== lines.length) return held("Current full Draft line evidence is incomplete or line IDs collide; no retained line may be dropped or guessed.");
  const originalDraft = finalWeightDraftEvidence(invoice);
  const expectedDraft = clone(originalDraft);
  let excessAmountExclusive: number | null = null;
  if (direction === "underweight") {
    expectedDraft.DueDate = facts.requiredDueDate;
  } else {
    if (!xero.ser70 || xero.ser70.itemCode !== "SER70" || xero.ser70.taxType !== "OUTPUT" || !xero.ser70.accountCode) return held("Current exact SER70 sales item/account/OUTPUT GST configuration is not verified.");
    excessAmountExclusive = Math.round((facts.actualWeight! - facts.estimatedWeight!) * facts.perExtraTonne! * 100) / 100;
    if (!Number.isFinite(excessAmountExclusive) || excessAmountExclusive <= 0 || excessAmountExclusive > 999999999.99) return held("Calculated GST-exclusive excess amount is not a safe positive two-decimal value.");
    const previous = lines.find((line: any) => String(line.ItemCode ?? "").trim().toUpperCase() === "SER70");
    const replacement: Record<string, any> = { ItemCode: "SER70", Description: "Excess weight", Quantity: 1, UnitAmount: excessAmountExclusive, AccountCode: xero.ser70.accountCode, TaxType: "OUTPUT" };
    if (previous?.LineItemID) replacement.LineItemID = previous.LineItemID;
    let inserted = false;
    expectedDraft.LineItems = lines.flatMap((line: any) => {
      if (String(line.ItemCode ?? "").trim().toUpperCase() !== "SER70") return [clone(line)];
      if (inserted) return [];
      inserted = true; return [replacement];
    });
    if (!inserted) expectedDraft.LineItems.push(replacement);
  }
  return { direction, eligible: true, invoiceNumber: number, invoiceId: invoice.InvoiceID, holdReason: null, originalDraft, expectedDraft, excessAmountExclusive };
}
/** Final weight never uses the generic proposal update builder (which reconstructs and loses lines). */
export function prepareFinalWeightPayload(preview: FinalWeightPreview, sourceHash: string): FinancialDraftPayload {
  if (!preview.eligible || !preview.invoiceId || !preview.invoiceNumber || !preview.expectedDraft) throw new Error("No exact final-weight Draft amendment is eligible.");
  const body = { Invoices: [clone(preview.expectedDraft)] };
  return { method: "PUT", endpoint: `/Invoices/${encodeURIComponent(preview.invoiceId)}`, documentFamily: "customer_invoice", documentNumber: preview.invoiceNumber, expectedXeroDocumentId: preview.invoiceId, body, idempotencyKey: financialSha256({ family: "final_weight_adjustment", direction: preview.direction, sourceHash, body }) };
}
/** Used by exact GET readback: compare every retained line field and header, permitting generated IDs/derived totals only. */
export function assertFinalWeightReadback(actual: Record<string, any>, expected: Record<string, any>): void {
  const normalized = finalWeightDraftEvidence(actual);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "LineItems") continue;
    if (financialSha256(normalized[key]) !== financialSha256(value)) throw new Error(`Final-weight readback changed retained invoice ${key}.`);
  }
  for (const key of Object.keys(normalized)) {
    if (key !== "LineItems" && !Object.prototype.hasOwnProperty.call(expected, key)) throw new Error(`Final-weight readback added unexpected invoice ${key}.`);
  }
  if (Number(actual.AmountPaid ?? 0) !== 0 || Number(actual.AmountCredited ?? 0) !== 0 ||
    ["Payments", "CreditNotes", "Prepayments", "Overpayments"].some(key => actual[key]?.length)) throw new Error("Final-weight readback is no longer an unallocated unpaid Draft.");
  if (!Array.isArray(actual.LineItems) || actual.LineItems.length !== expected.LineItems.length) throw new Error("Final-weight readback line count differs.");
  expected.LineItems.forEach((line: Record<string, any>, index: number) => {
    const received = actual.LineItems[index];
    for (const [key, value] of Object.entries(line)) {
      if (financialSha256(received?.[key]) !== financialSha256(value)) throw new Error(`Final-weight readback changed line ${index + 1} ${key}.`);
    }
    for (const key of ["DiscountRate", "DiscountAmount", "Tracking", "ItemCode"]) {
      if (line[key] === undefined && received?.[key] !== undefined && received[key] !== null && received[key] !== "" && received[key] !== 0 &&
        !(Array.isArray(received[key]) && received[key].length === 0)) throw new Error(`Final-weight readback added unexpected line ${index + 1} ${key}.`);
    }
    // Only a newly built/replaced SER70 lacks derived tax/amount evidence. A
    // retained underweight SER70 is compared verbatim above, never recalculated.
    if (line.ItemCode === "SER70" && line.LineAmount === undefined) {
      const net = Math.round(Number(line.Quantity) * Number(line.UnitAmount) * 100) / 100;
      const tax = Math.round(net * 0.1 * 100) / 100;
      if (Number(received?.DiscountRate ?? 0) !== 0 || Number(received?.DiscountAmount ?? 0) !== 0 || received?.Tracking?.length ||
        !Number.isFinite(Number(received?.LineAmount)) || !Number.isFinite(Number(received?.TaxAmount)) ||
        Math.abs(Number(received.LineAmount) - net) > 0.001 || Math.abs(Number(received.TaxAmount) - tax) > 0.001) throw new Error("Final-weight SER70 readback differs from the positive GST-exclusive excess line.");
    }
  });
  const subtotal = actual.LineItems.reduce((sum: number, line: Record<string, any>) => sum + Number(line.LineAmount), 0);
  const tax = actual.LineItems.reduce((sum: number, line: Record<string, any>) => sum + Number(line.TaxAmount), 0);
  if (![subtotal, tax, Number(actual.SubTotal), Number(actual.TotalTax), Number(actual.Total)].every(Number.isFinite) ||
    Math.abs(Number(actual.SubTotal) - subtotal) > 0.01 || Math.abs(Number(actual.TotalTax) - tax) > 0.01 ||
    Math.abs(Number(actual.Total) - subtotal - tax) > 0.01) throw new Error("Final-weight full-line readback totals/tax do not match retained and allowed adjustment evidence.");
}
