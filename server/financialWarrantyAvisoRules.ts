import { financialSha256 } from "./financialProposalIntegrity";

export const WARRANTY_RULES_VERSION = "warranty-aviso-v1-append-one-draft-only-no-suffix-no-retry";
export const WARRANTY_RULES_HASH = financialSha256(WARRANTY_RULES_VERSION);
export const AVISO_NAME = "Aviso Broking Pty Ltd";
export const AVISO_ACCOUNT = "313";
export type FieldBinding = { name: string; label: string; type: Record<string, unknown>; mandatory: boolean };
export type WarrantyMapping = { addedServicesValue: string; itemCode: string; nativeDescription: string; premiumExGst: number };
export type WarrantySourceConfig = {
  module: "Potentials";
  potentialsIdPrefix: string;
  fields: Record<"dealNumber" | "addedServices" | "organisation" | "contact" | "modifiedTime", FieldBinding> & { issueDate: FieldBinding | null; dueDate: FieldBinding | null };
  customerFields: { organisation: { name: FieldBinding; modifiedTime: FieldBinding }; contact: { firstName: FieldBinding; lastName: FieldBinding; modifiedTime: FieldBinding } };
  dateSemantics: { issue: "source_iso_date" | "preserve_main_date"; due: "source_iso_date" | "preserve_main_due_date" };
  addedServicesMappings: WarrantyMapping[];
};
export type WarrantyFacts = {
  dealId: string; dealNumber: string; addedServices: string; customerVtigerId: string; customerName: string;
  customerKind: "organisation" | "contact"; sourceModifiedAt: string | null; customerModifiedAt: string | null;
  issueDate: string | null; dueDate: string | null; sourceMappingsHash: string; addedServicesMappingHash: string;
  mapping: WarrantyMapping | null; configurationRequired: string[]; holdReason: string | null;
};
export type XeroRow = Record<string, any>;
export type WarrantyXeroEvidence = {
  tenantId: string;
  mainHistory: XeroRow[]; main: XeroRow | null; otherInvoices: XeroRow[]; poHistory: XeroRow[]; purchaseOrders: XeroRow[];
  customer: XeroRow; supplier: XeroRow; item: XeroRow; accounts: XeroRow[]; taxes: XeroRow[];
  configurationHash: string; comparisonHash: string; historyComplete: true;
};
export type WarrantyPayload = { operation: "append_main_draft" | "create_aviso_draft"; method: "PUT" | "POST"; endpoint: string; body: Record<string, XeroRow[]>; idempotencyKey: string };
export type WarrantyPlan = { mainNumber: string; poNumber: string; expectedMain: XeroRow; expectedPo: XeroRow; mainPayload: WarrantyPayload; poPayload: WarrantyPayload };
export const cents = (n: number) => Math.round((n + Number.EPSILON) * 100);
export const money = (n: number) => cents(n) / 100;
export function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}
export function xeroDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (isoDate(value)) return value;
  const ms = value.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
  const date = ms ? new Date(Number(ms[1])) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
function requireFact(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const LINE_KEYS = ["LineItemID", "ItemCode", "Description", "Quantity", "UnitAmount", "AccountCode", "TaxType", "TaxAmount", "LineAmount", "DiscountRate", "Tracking"] as const;
function nativeLine(line: XeroRow, existing: boolean): XeroRow {
  requireFact(line && typeof line === "object" && !Array.isArray(line), "Main line is invalid.");
  requireFact(Object.keys(line).every(k => [...LINE_KEYS, "AccountID"].includes(k as any)), "Unknown main line fields require full-line reconciliation, not lossy replacement.");
  requireFact((!existing || typeof line.LineItemID === "string" && line.LineItemID) && typeof line.Description === "string" &&
    typeof line.AccountCode === "string" && line.AccountCode && typeof line.TaxType === "string" && line.TaxType &&
    numeric(line.Quantity) && line.Quantity > 0 && numeric(line.UnitAmount) && line.UnitAmount >= 0 &&
    numeric(line.LineAmount) && line.LineAmount >= 0 && numeric(line.TaxAmount) && line.TaxAmount >= 0,
    "Main full-line identity/account/amount/tax evidence is incomplete or incompatible.");
  const discount = line.DiscountRate ?? 0;
  requireFact(numeric(discount) && discount >= 0 && discount <= 100 && cents(line.Quantity * line.UnitAmount * (1 - discount / 100)) === cents(line.LineAmount), "Main line arithmetic/discount does not reconcile.");
  requireFact(!line.Tracking || Array.isArray(line.Tracking) && line.Tracking.every((t: any) => typeof t.TrackingCategoryID === "string" && typeof t.TrackingOptionID === "string"), "Main tracking evidence is incomplete.");
  return Object.fromEntries(LINE_KEYS.filter(k => Object.hasOwn(line, k)).map(k => [k, structuredClone(line[k])]));
}
export function assertWarrantyConfiguration(facts: WarrantyFacts, e: WarrantyXeroEvidence): void {
  requireFact(!facts.holdReason && facts.mapping && /^D\d{1,12}$/.test(facts.dealNumber), facts.holdReason ?? "Exact approved Added Services mapping required.");
  const m = facts.mapping;
  requireFact(e.historyComplete === true && e.customer.ContactStatus === "ACTIVE" && e.customer.Name === facts.customerName && e.customer.ContactID, "Exact current Xero customer is missing/archived/ambiguous.");
  requireFact(e.supplier.Name === AVISO_NAME && e.supplier.ContactStatus === "ACTIVE" && e.supplier.ContactID && e.supplier.ContactID !== e.customer.ContactID, "Exact Aviso supplier contact mismatch.");
  requireFact(/^WAR[A-Za-z0-9 _'-]*$/.test(m.itemCode) && e.item.Code === m.itemCode && e.item.IsSold === true && e.item.IsPurchased === true &&
    e.item.Description === m.nativeDescription && e.item.PurchaseDescription === m.nativeDescription &&
    e.item.SalesDetails?.UnitPrice === m.premiumExGst && e.item.PurchaseDetails?.UnitPrice === m.premiumExGst &&
    e.item.PurchaseDetails?.AccountCode === AVISO_ACCOUNT && e.item.PurchaseDetails?.TaxType === "INPUT" &&
    typeof e.item.SalesDetails?.AccountCode === "string" && e.item.SalesDetails.AccountCode && e.item.SalesDetails.TaxType === "OUTPUT", "Current native WAR item description/premium/account/GST evidence drift; hold.");
  for (const [code, tax, kinds] of [[AVISO_ACCOUNT, "INPUT", ["EXPENSE", "DIRECTCOSTS"]], [e.item.SalesDetails.AccountCode, "OUTPUT", ["REVENUE", "SALES"]]] as const) {
    const rows = e.accounts.filter(a => a.Code === code);
    requireFact(rows.length === 1 && rows[0].Status === "ACTIVE" && rows[0].TaxType === tax && (kinds as readonly string[]).includes(rows[0].Type), `Exact active account ${code} and ${tax} GST evidence required.`);
    const taxes = e.taxes.filter(t => t.TaxType === tax);
    requireFact(taxes.length === 1 && taxes[0].Status === "ACTIVE" && taxes[0].EffectiveRate === 10, `Exact active 10% ${tax} GST evidence required.`);
  }
  requireFact(e.poHistory.length === 0 && e.purchaseOrders.length === 0, "Aviso I-reference collision in any status/history; no adoption, suffix bypass or retry.");
  requireFact(!e.otherInvoices.some(i => !Array.isArray(i.LineItems) || i.LineItems.some((l: any) => /^WAR/i.test(String(l.ItemCode ?? "")))), "Tentative warranty suffix/history exists or is unreadable; reconcile without adoption.");
}
export function buildWarrantyPlan(facts: WarrantyFacts, e: WarrantyXeroEvidence, config: WarrantySourceConfig): WarrantyPlan {
  assertWarrantyConfiguration(facts, e);
  const mainNumber = `INV-${facts.dealNumber.slice(1)}`; const poNumber = `I${facts.dealNumber.slice(1)}`;
  requireFact(e.mainHistory.length === 1 && e.main, "Exact main invoice missing/ambiguous, including deleted/voided history.");
  const main = e.main;
  requireFact(main.Status === "DRAFT", "Non-Draft main MUST NOT amend/revise/replace. Requires explicitly approved WARRANTY_AP_SUFFIX_V1 and a separately implemented path; none exists here.");
  requireFact(main.InvoiceID === e.mainHistory[0].InvoiceID && main.InvoiceNumber === mainNumber && main.Type === "ACCREC" && main.Contact?.ContactID === e.customer.ContactID && main.Contact?.Name === facts.customerName &&
    main.CurrencyCode === "AUD" && main.LineAmountTypes === "Exclusive" && (!main.CurrencyRate || main.CurrencyRate === 1), "Main exact identity/customer/AUD/GST-exclusive evidence mismatch.");
  requireFact(["Payments", "CreditNotes", "Prepayments", "Overpayments"].every(k => !main[k] || Array.isArray(main[k]) && main[k].length === 0) &&
    ["AmountPaid", "AmountCredited"].every(k => main[k] === undefined || main[k] === 0), "Main has financial allocations/payments; hold.");
  requireFact(Array.isArray(main.LineItems) && main.LineItems.length > 0 && !main.LineItems.some((l: any) => /^WAR/i.test(String(l.ItemCode ?? ""))), "Main already has a WAR line or lacks full lines; never replace/remove/adopt.");
  const lines = main.LineItems.map((line: XeroRow) => nativeLine(line, true));
  requireFact(new Set(lines.map((l: XeroRow) => l.LineItemID)).size === lines.length, "Main duplicate line IDs hold.");
  const subtotal = money(lines.reduce((n: number, l: XeroRow) => n + l.LineAmount, 0));
  const tax = money(lines.reduce((n: number, l: XeroRow) => n + l.TaxAmount, 0));
  requireFact(numeric(main.SubTotal) && numeric(main.TotalTax) && numeric(main.Total) && cents(main.SubTotal) === cents(subtotal) && cents(main.TotalTax) === cents(tax) && cents(main.Total) === cents(subtotal + tax) &&
    (main.AmountDue === undefined || numeric(main.AmountDue) && cents(main.AmountDue) === cents(main.Total)), "Main full-line totals do not reconcile exactly.");
  const date = xeroDate(main.DateString ?? main.Date); const due = xeroDate(main.DueDateString ?? main.DueDate);
  requireFact(date && due && due >= date, "Exact current main issue/due dates required; no locale/date invention.");
  requireFact((config.dateSemantics.issue === "preserve_main_date" && !config.fields.issueDate || config.dateSemantics.issue === "source_iso_date" && facts.issueDate === date) &&
    (config.dateSemantics.due === "preserve_main_due_date" && !config.fields.dueDate || config.dateSemantics.due === "source_iso_date" && facts.dueDate === due), "Approved source issue/due semantics mismatch; never amend main dates.");
  const m = facts.mapping!; const warTax = money(m.premiumExGst * 0.1);
  const warrantyLine = { ItemCode: m.itemCode, Description: m.nativeDescription, Quantity: 1, UnitAmount: m.premiumExGst, AccountCode: e.item.SalesDetails.AccountCode, TaxType: "OUTPUT", LineAmount: m.premiumExGst, TaxAmount: warTax };
  const header: XeroRow = { InvoiceID: main.InvoiceID, InvoiceNumber: mainNumber, Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: e.customer.ContactID }, CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Date: date, DueDate: due, LineItems: [...lines, warrantyLine] };
  for (const k of ["Reference", "BrandingThemeID", "Url", "CurrencyRate", "SentToContact"]) if (Object.hasOwn(main, k)) header[k] = main[k];
  const po: XeroRow = { PurchaseOrderNumber: poNumber, Status: "DRAFT", Contact: { ContactID: e.supplier.ContactID }, CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Date: facts.issueDate ?? date,
    Reference: facts.addedServices, LineItems: [{ ...warrantyLine, AccountCode: AVISO_ACCOUNT, TaxType: "INPUT" }] };
  const payload = (operation: WarrantyPayload["operation"], method: "PUT" | "POST", endpoint: string, body: WarrantyPayload["body"]): WarrantyPayload => ({ operation, method, endpoint, body, idempotencyKey: financialSha256({ operation, dealId: facts.dealId, sourceHash: financialSha256(facts), body }) });
  return { mainNumber, poNumber, expectedMain: { ...header, SubTotal: money(subtotal + m.premiumExGst), TotalTax: money(tax + warTax), Total: money(subtotal + m.premiumExGst + tax + warTax) },
    expectedPo: { ...po, SubTotal: m.premiumExGst, TotalTax: warTax, Total: money(m.premiumExGst + warTax) },
    mainPayload: payload("append_main_draft", "PUT", `/Invoices/${encodeURIComponent(main.InvoiceID)}`, { Invoices: [header] }),
    poPayload: payload("create_aviso_draft", "POST", "/PurchaseOrders", { PurchaseOrders: [po] }) };
}
/** Full business document comparison: preserve all existing IDs/lines, append exactly one; no total-only validation. */
export function assertWarrantyReadback(actual: XeroRow | null, expected: XeroRow, kind: "main" | "po", expectedId?: string): void {
  requireFact(actual && actual.Status === "DRAFT" && actual.CurrencyCode === "AUD" && actual.LineAmountTypes === "Exclusive" && actual.Contact?.ContactID === expected.Contact.ContactID,
    "Warranty readback status/contact/currency/GST mismatch; reconciliation required.");
  const idKey = kind === "main" ? "InvoiceID" : "PurchaseOrderID"; const numberKey = kind === "main" ? "InvoiceNumber" : "PurchaseOrderNumber";
  requireFact(actual[idKey] && (!expectedId || actual[idKey] === expectedId) && actual[numberKey] === expected[numberKey] && (kind !== "main" || actual.Type === "ACCREC" && actual.InvoiceID === expected.InvoiceID), "Exact warranty document ID/number/type readback mismatch.");
  requireFact(xeroDate(actual.DateString ?? actual.Date) === expected.Date && (kind !== "main" || xeroDate(actual.DueDateString ?? actual.DueDate) === expected.DueDate) && (kind !== "po" || !actual.DueDate && !actual.DueDateString), "Warranty full-document dates mismatch.");
  for (const k of ["Reference", "BrandingThemeID", "Url", "CurrencyRate", "SentToContact"]) requireFact((actual[k] ?? (k === "Reference" || k === "Url" ? "" : null)) === (expected[k] ?? (k === "Reference" || k === "Url" ? "" : null)), `Warranty preserved header ${k} mismatch.`);
  for (const k of ["SubTotal", "TotalTax", "Total"]) requireFact(numeric(actual[k]) && cents(actual[k]) === cents(expected[k]), `Warranty exact ${k} readback mismatch.`);
  requireFact(Array.isArray(actual.LineItems) && actual.LineItems.length === expected.LineItems.length, "Warranty full-line count mismatch.");
  actual.LineItems.forEach((line: XeroRow, i: number) => {
    const wanted = expected.LineItems[i]; const got = nativeLine(line, Boolean(wanted.LineItemID));
    if (!wanted.LineItemID) delete got.LineItemID;
    for (const k of ["DiscountRate", "Tracking"]) { if (k === "DiscountRate" && (got[k] ?? 0) === 0 && (wanted[k] ?? 0) === 0) delete got[k]; if (k === "Tracking" && (!got[k] || got[k].length === 0) && (!wanted[k] || wanted[k].length === 0)) delete got[k]; }
    const normalized = { ...wanted }; if ((normalized.DiscountRate ?? 0) === 0) delete normalized.DiscountRate; if (!normalized.Tracking?.length) delete normalized.Tracking;
    requireFact(financialSha256(got) === financialSha256(normalized), `Warranty exact full-line ${i + 1} mismatch; reconciliation required.`);
  });
}
