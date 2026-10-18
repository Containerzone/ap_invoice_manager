import { DEFAULT_FINANCIAL_AUTOMATION_RULES } from "./financialAutomationRules";
import { financialSha256 } from "./financialProposalIntegrity";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { Temporal } from "@js-temporal/polyfill";

export type FinalWeightDirection = "overweight" | "underweight";
export const FINAL_WEIGHT_RULES_VERSION = "2026-10-18.final-weight.draft-amendment.v4";
export const FINAL_WEIGHT_RULES_HASH = financialSha256({ version: FINAL_WEIGHT_RULES_VERSION, item: DEFAULT_FINANCIAL_AUTOMATION_RULES.itemCodes.overweight, scope: "new_events_only", operations: ["positive-exclusive-SER70-replacement", "set-date-to-current-deal-full-container-pickup-date", "set-due-date-to-sydney-calendar-date-plus-2-or-on-account-plus-14", "overweight-reference-customer-po-then-container-number"], preserve: "all-retained-lines-and-invoice-fields-except-Date-DueDate-and-overweight-reference", collectionDate: { source: "current-deal-cf_potentials_fullcontainercollectiondate", exactLabel: "Full Container Pickup DATE", type: "date" }, depositStatus: { source: "current-deal-cf_potentials_depositstatus", exactLabel: "Deposit Status", type: "picklist", onAccountNormalizedValue: "ON ACCOUNT" }, dueDate: { normalSydneyCalendarDays: 2, onAccountSydneyCalendarDays: 14 }, overweightReference: { sourcesInPriorityOrder: ["current-deal-customer-po", "current-deal-container-number"], noFallbackBeyondSources: true, requireCustomerPOMetadata: true } });
export const FINAL_WEIGHT_PATHS = {
  overweight: "/api/webhooks/vtiger/final-weight-overweight",
  underweight: "/api/webhooks/vtiger/final-weight-underweight",
} as const;
export type FinalWeightFacts = {
  dealId: string; dealNumber: string; dealName: string; customerPO: string;
  customerVtigerId: string; customerName: string; customerKind: "organisation" | "contact";
  estimatedWeight: number | null; actualWeight: number | null; perExtraTonne: number | null;
  collectionDate: string | null; depositStatus: string | null; sourceRefreshedAt: string | null; customerRefreshedAt: string | null;
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
/** Picklist comparison is intentionally limited to case and internal/edge whitespace normalization. */
export function normalizedFinalWeightDepositStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ").toUpperCase();
  return normalized;
}
/** Add whole calendar days in Australia/Sydney, including across daylight-saving transitions. */
export function finalWeightSydneyCalendarDueDate(collectionDate: unknown, depositStatus: unknown): string | null {
  const date = finalWeightDate(collectionDate);
  const normalizedStatus = normalizedFinalWeightDepositStatus(depositStatus);
  // A blank scalar Deposit Status is the normal/default two-day case. `null`
  // means a missing or non-scalar source fact and must hold.
  if (!date || normalizedStatus === null) return null;
  try {
    return Temporal.PlainDate.from(date)
      .toZonedDateTime({ timeZone: "Australia/Sydney", plainTime: Temporal.PlainTime.from("12:00") })
      .add({ days: normalizedStatus === "ON ACCOUNT" ? 14 : 2 })
      .toPlainDate()
      .toString();
  } catch {
    return null;
  }
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
  if (!finalWeightDate(facts.collectionDate)) return "Both final-weight routes require the verified Full Container Pickup DATE; no invented fallback is allowed.";
  if (normalizedFinalWeightDepositStatus(facts.depositStatus) === null) return "Both final-weight routes require a scalar Deposit Status; no default is allowed when it is absent or non-scalar.";
  const difference = facts.actualWeight - facts.estimatedWeight;
  if (direction === "overweight" && difference <= 0 || direction === "underweight" && difference >= 0) return "Current weights do not match the dedicated route direction (equal weight is held).";
  if (direction === "overweight" && (facts.perExtraTonne === null || !Number.isFinite(facts.perExtraTonne) || facts.perExtraTonne <= 0)) return "Overweight requires a positive current per-extra-tonne GST-exclusive value.";
  return null;
}
export function buildFinalWeightAdjustment(facts: FinalWeightFacts, direction: FinalWeightDirection, xero: FinalWeightXeroEvidence | null): FinalWeightPreview {
  const number = /^D\d{1,12}$/i.test(facts.dealNumber) ? `INV-${facts.dealNumber.slice(1)}` : null;
  const held = (reason: string): FinalWeightPreview => ({ direction, eligible: false, invoiceNumber: number, invoiceId: xero?.invoice?.InvoiceID ?? null, holdReason: reason, originalDraft: null, expectedDraft: null, excessAmountExclusive: null });
  const sourceHold = finalWeightSourceHold(facts, direction);
  if (sourceHold) return held(sourceHold);
  if (!xero || xero.exactMatches.length !== 1) return held(xero?.exactMatches.length ? `The exact main invoice ${number} is ambiguous (${xero.exactMatches.length} Xero matches); never create, adopt or suffix an invoice.` : `The exact main invoice ${number} was not found in Xero; never create, adopt or suffix an invoice.`);
  const invoice = xero.invoice;
  const match = xero.exactMatches[0]!;
  if (!invoice || !invoice.InvoiceID || invoice.InvoiceID !== match.InvoiceID || invoice.InvoiceNumber !== number || match.InvoiceNumber !== number || invoice.Status !== "DRAFT" || match.Status !== "DRAFT" || invoice.Type !== "ACCREC" || match.Type !== "ACCREC") {
    const status = String(match.Status ?? "unknown").trim().toUpperCase();
    const type = String(match.Type ?? "unknown").trim().toUpperCase();
    return held(`Exact Xero main invoice ${number} is ${status} ${type}; only the same CURRENT DRAFT ACCREC invoice may be amended.`);
  }
  if (invoice.CurrencyCode !== "AUD" || invoice.LineAmountTypes !== "Exclusive" || Number(invoice.AmountPaid ?? 0) !== 0 || Number(invoice.AmountCredited ?? 0) !== 0 || (invoice.Payments?.length ?? 0) || (invoice.CreditNotes?.length ?? 0) || (invoice.Prepayments?.length ?? 0) || (invoice.Overpayments?.length ?? 0)) return held("Main invoice currency/GST/payment evidence is not an unallocated AUD GST-exclusive Draft.");
  // Existing Draft amendments retain the original immutable Xero ContactID.
  // They never rematch or replace the invoice customer from current Deal data.
  if (xero.contact.count !== 1 || !xero.contact.contactId || !invoice.Contact?.ContactID || invoice.Contact?.ContactID !== xero.contact.contactId || match.Contact?.ContactID !== xero.contact.contactId) return held("Exact Draft invoice contact evidence is incomplete or inconsistent; no customer rematch will occur.");
  const lines = invoice.LineItems;
  if (!Array.isArray(lines) || !lines.length || lines.some((line: any) => !line || !String(line.LineItemID ?? "").trim() || typeof line.Description !== "string" ||
    ["Quantity", "UnitAmount", "LineAmount", "TaxAmount"].some(key => line[key] === null || line[key] === undefined || line[key] === "" || !Number.isFinite(Number(line[key]))) ||
    !String(line.AccountCode ?? "").trim() || !String(line.TaxType ?? "").trim()) || new Set(lines.map((line: any) => line.LineItemID)).size !== lines.length) return held("Current full Draft line evidence is incomplete or line IDs collide; no retained line may be dropped or guessed.");
  const originalDraft = finalWeightDraftEvidence(invoice);
  const expectedDraft = clone(originalDraft);
  const collectionDate = finalWeightDate(facts.collectionDate);
  const dueDate = finalWeightSydneyCalendarDueDate(collectionDate, facts.depositStatus);
  if (!collectionDate || !dueDate) return held("Current final-weight collection date or Deposit Status cannot produce a verified Sydney calendar due date.");
  expectedDraft.Date = collectionDate;
  expectedDraft.DueDate = dueDate;
  let excessAmountExclusive: number | null = null;
  if (direction === "underweight") {
    // Underweight intentionally changes no line or reference evidence.
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
    // The verified current Deal source provides no third Reference fallback.
    expectedDraft.Reference = facts.customerPO.trim() || facts.dealName.trim();
  }
  return { direction, eligible: true, invoiceNumber: number, invoiceId: invoice.InvoiceID, holdReason: null, originalDraft, expectedDraft, excessAmountExclusive };
}
/** Final weight never uses the generic proposal update builder (which reconstructs and loses lines). */
export function prepareFinalWeightPayload(preview: FinalWeightPreview, sourceHash: string): FinancialDraftPayload {
  if (!preview.eligible || !preview.invoiceId || !preview.invoiceNumber || !preview.expectedDraft) throw new Error("No exact final-weight Draft amendment is eligible.");
  const body = { Invoices: [clone(preview.expectedDraft)] };
  // Xero Accounting API creates with PUT; an existing invoice is amended only
  // with POST to its exact verified resource ID. The endpoint is therefore not
  // the collection and cannot create a new invoice.
  return { method: "POST", endpoint: `/Invoices/${encodeURIComponent(preview.invoiceId)}`, documentFamily: "customer_invoice", documentNumber: preview.invoiceNumber, expectedXeroDocumentId: preview.invoiceId, body, idempotencyKey: financialSha256({ family: "final_weight_adjustment", direction: preview.direction, sourceHash, body }) };
}
/** Used by exact GET readback: compare every retained line field and header, permitting generated IDs/derived totals only. */
export function assertFinalWeightReadback(actual: Record<string, any>, expected: Record<string, any>): void {
  const normalized = finalWeightDraftEvidence(actual);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "LineItems") continue;
    if (financialSha256(normalized[key]) !== financialSha256(value)) throw new Error(`Final-weight readback changed retained invoice ${key}.`);
  }
  for (const key of Object.keys(normalized)) {
    // Xero returns an explicit null DueDate for a Draft that had no Due Date.
    // Treat that as preserved absence when the immutable expected evidence omits it;
    // do not turn a valid no-Due-Date Draft amendment into a false reconciliation.
    if (key !== "LineItems" && !Object.prototype.hasOwnProperty.call(expected, key) && !(key === "DueDate" && normalized[key] === null)) throw new Error(`Final-weight readback added unexpected invoice ${key}.`);
  }
  if (Number(actual.AmountPaid ?? 0) !== 0 || Number(actual.AmountCredited ?? 0) !== 0 ||
    ["Payments", "CreditNotes", "Prepayments", "Overpayments"].some(key => actual[key]?.length)) throw new Error("Final-weight readback is no longer an unallocated unpaid Draft.");
  if (!Array.isArray(actual.LineItems) || actual.LineItems.length !== expected.LineItems.length) throw new Error("Final-weight readback line count differs.");
  // Xero is permitted to reorder a Draft's lines after a POST. Retained source
  // lines carry immutable LineItemIDs, while a newly appended amendment line
  // has no ID before Xero creates it. Match both forms explicitly so a correct
  // Xero response is not misclassified as an uncertain write merely by order.
  const unmatched = new Set(actual.LineItems.map((_: unknown, index: number) => index));
  const matchLine = (line: Record<string, any>): Record<string, any> => {
    const sourceId = typeof line.LineItemID === "string" ? line.LineItemID.trim() : "";
    const expectedLineAmount = Number(line.LineAmount ?? Number(line.Quantity) * Number(line.UnitAmount));
    const expectedTaxAmount = Number(line.TaxAmount ?? (line.ItemCode === "SER70" ? Math.round(expectedLineAmount * 0.1 * 100) / 100 : 0));
    const candidates = Array.from(unmatched).filter(index => {
      const received = actual.LineItems[index];
      if (sourceId) return received?.LineItemID === sourceId;
      return received?.Description === line.Description &&
        Number(received?.Quantity) === Number(line.Quantity) &&
        Number(received?.UnitAmount) === Number(line.UnitAmount) &&
        Number(received?.LineAmount) === expectedLineAmount &&
        Number(received?.TaxAmount) === expectedTaxAmount &&
        String(received?.AccountCode ?? "") === String(line.AccountCode ?? "") &&
        String(received?.TaxType ?? "") === String(line.TaxType ?? "") &&
        (line.ItemCode === undefined || String(received?.ItemCode ?? "") === String(line.ItemCode));
    });
    if (candidates.length !== 1) throw new Error(sourceId
      ? `Final-weight readback cannot match retained line ID ${sourceId}.`
      : "Final-weight readback cannot match exactly one new amendment line.");
    const index = candidates[0]!;
    unmatched.delete(index);
    return actual.LineItems[index]!;
  };
  expected.LineItems.forEach((line: Record<string, any>, expectedIndex: number) => {
    const received = matchLine(line);
    for (const [key, value] of Object.entries(line)) {
      if (financialSha256(received?.[key]) !== financialSha256(value)) throw new Error(`Final-weight readback changed line ${expectedIndex + 1} ${key}.`);
    }
    for (const key of ["DiscountRate", "DiscountAmount", "Tracking", "ItemCode"]) {
      if (line[key] === undefined && received?.[key] !== undefined && received[key] !== null && received[key] !== "" && received[key] !== 0 &&
        !(Array.isArray(received[key]) && received[key].length === 0)) throw new Error(`Final-weight readback added unexpected line ${expectedIndex + 1} ${key}.`);
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
  if (unmatched.size !== 0) throw new Error("Final-weight readback contains an unexpected unmatched line.");
  const lineTotal = actual.LineItems.reduce((sum: number, line: Record<string, any>) => sum + Number(line.LineAmount), 0);
  const tax = actual.LineItems.reduce((sum: number, line: Record<string, any>) => sum + Number(line.TaxAmount), 0);
  const subtotal = Number(actual.SubTotal);
  const totalTax = Number(actual.TotalTax);
  const total = Number(actual.Total);
  if (![lineTotal, tax, subtotal, totalTax, total].every(Number.isFinite) || Math.abs(totalTax - tax) > 0.01) {
    throw new Error("Final-weight full-line readback totals/tax do not match retained and allowed adjustment evidence.");
  }
  if (actual.LineAmountTypes === "Inclusive") {
    if (Math.abs(total - lineTotal) > 0.01 || Math.abs(total - subtotal - totalTax) > 0.01) {
      throw new Error("Final-weight full-line readback totals/tax do not match retained and allowed adjustment evidence.");
    }
  } else if (actual.LineAmountTypes === "Exclusive") {
    if (Math.abs(subtotal - lineTotal) > 0.01 || Math.abs(total - subtotal - totalTax) > 0.01) {
      throw new Error("Final-weight full-line readback totals/tax do not match retained and allowed adjustment evidence.");
    }
  } else {
    throw new Error("Final-weight readback returned an unsupported line amount treatment.");
  }
}
