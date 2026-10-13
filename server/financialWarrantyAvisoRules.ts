import { financialSha256 } from "./financialProposalIntegrity";

export const WARRANTY_RULES_VERSION = "warranty-aviso-v3-current-vtiger-first-ten-native-war-id-po-post-draft-only";
export const WARRANTY_RULES_HASH = financialSha256(WARRANTY_RULES_VERSION);
export const AVISO_NAME = "Aviso Broking Pty Ltd";
export const AVISO_ACCOUNT = "313";
export const WARRANTY_ADDED_SERVICES_MAPPINGS = [
  { addedServicesValue: "Warranty $25k", itemCode: "WAR25", premiumExGst: 192.5 },
  { addedServicesValue: "Warranty $30k", itemCode: "WAR30", premiumExGst: 228.9 },
  { addedServicesValue: "Warranty $40k", itemCode: "WAR40", premiumExGst: 305.2 },
  { addedServicesValue: "Warranty $50k", itemCode: "WAR50", premiumExGst: 381.5 },
  { addedServicesValue: "Warranty $60k", itemCode: "WAR60", premiumExGst: 457.8 },
  { addedServicesValue: "Warranty $70k", itemCode: "WAR70", premiumExGst: 534.1 },
  { addedServicesValue: "Warranty $75k", itemCode: "WAR75", premiumExGst: 572.25 },
  { addedServicesValue: "Warranty $80k", itemCode: "WAR80", premiumExGst: 610.4 },
  { addedServicesValue: "Warranty $90k", itemCode: "WAR90", premiumExGst: 686.7 },
  { addedServicesValue: "Warranty $100k", itemCode: "WAR100", premiumExGst: 763 },
] as const;
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
export type WarrantyPayload = { operation: "append_main_draft" | "create_aviso_draft"; method: "POST"; endpoint: string; body: Record<string, XeroRow[]>; idempotencyKey: string };
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
  return Object.fromEntries(LINE_KEYS.filter(k => Object.hasOwn(line, k)).map(k => [k, structuredClone(line[k])])) as XeroRow;
}

export function assertWarrantyConfiguration(facts: WarrantyFacts, e: WarrantyXeroEvidence): void {
  requireFact(!facts.holdReason && facts.mapping && /^D\d{1,12}$/.test(facts.dealNumber), facts.holdReason ?? "Exact approved Added Services mapping required.");
  const mapping = facts.mapping;
  const expected = WARRANTY_ADDED_SERVICES_MAPPINGS.find(row => row.addedServicesValue === mapping.addedServicesValue);
  requireFact(expected && mapping.itemCode === expected.itemCode && mapping.premiumExGst === expected.premiumExGst && mapping.nativeDescription.trim(), "Selected Warranty mapping is not one of the exact approved native WAR items/premiums.");
  requireFact(e.historyComplete === true && e.customer.ContactStatus === "ACTIVE" && e.customer.Name === facts.customerName && e.customer.ContactID, "Exact current Xero customer is missing/archived/ambiguous.");
  requireFact(e.supplier.Name === AVISO_NAME && e.supplier.ContactStatus === "ACTIVE" && e.supplier.ContactID && e.supplier.ContactID !== e.customer.ContactID, "Exact Aviso supplier contact mismatch.");
  requireFact(e.item.Code === mapping.itemCode && e.item.IsSold === true && e.item.IsPurchased === true &&
    e.item.Description === mapping.nativeDescription && e.item.PurchaseDescription === mapping.nativeDescription &&
    e.item.SalesDetails?.UnitPrice === mapping.premiumExGst && e.item.PurchaseDetails?.UnitPrice === mapping.premiumExGst &&
    e.item.PurchaseDetails?.AccountCode === AVISO_ACCOUNT && e.item.PurchaseDetails?.TaxType === "INPUT" &&
    typeof e.item.SalesDetails?.AccountCode === "string" && e.item.SalesDetails.AccountCode && e.item.SalesDetails.TaxType === "OUTPUT", "Current native WAR item description/premium/account/GST evidence drift; hold.");
  for (const [code, tax, kinds] of [[AVISO_ACCOUNT, "INPUT", ["EXPENSE", "DIRECTCOSTS"]], [e.item.SalesDetails.AccountCode, "OUTPUT", ["REVENUE", "SALES"]]] as const) {
    const rows = e.accounts.filter(a => a.Code === code);
    requireFact(rows.length === 1 && rows[0].Status === "ACTIVE" && rows[0].TaxType === tax && (kinds as readonly string[]).includes(rows[0].Type), `Exact active account ${code} and ${tax} GST evidence required.`);
    const taxes = e.taxes.filter(t => t.TaxType === tax);
    requireFact(taxes.length === 1 && taxes[0].Status === "ACTIVE" && taxes[0].EffectiveRate === 10, `Exact active 10% ${tax} GST evidence required.`);
  }
  requireFact(e.poHistory.length === 0 && e.purchaseOrders.length === 0, "Aviso ID-reference collision in any status/history; no adoption, suffix bypass or retry.");
  requireFact(!e.otherInvoices.some(i => !Array.isArray(i.LineItems) || i.LineItems.some((line: any) => /^WAR/i.test(String(line.ItemCode ?? "")))), "Tentative warranty suffix/history exists or is unreadable; reconcile without adoption.");
}

export function buildWarrantyPlan(facts: WarrantyFacts, e: WarrantyXeroEvidence, config: WarrantySourceConfig): WarrantyPlan {
  assertWarrantyConfiguration(facts, e);
  const mainNumber = `INV-${facts.dealNumber.slice(1)}`;
  const poNumber = `ID${facts.dealNumber.slice(1)}`;
  requireFact(e.mainHistory.length === 1 && e.main, "Exact main invoice missing/ambiguous, including deleted/voided history.");
  const main = e.main;
  requireFact(main.Status === "DRAFT", "Non-Draft main MUST NOT amend/revise/replace. Requires explicitly approved WARRANTY_AP_SUFFIX_V1 and a separately implemented path; none exists here.");
  requireFact(main.InvoiceID === e.mainHistory[0].InvoiceID && main.InvoiceNumber === mainNumber && main.Type === "ACCREC" && main.Contact?.ContactID === e.customer.ContactID && main.Contact?.Name === facts.customerName &&
    main.CurrencyCode === "AUD" && main.LineAmountTypes === "Exclusive" && (!main.CurrencyRate || main.CurrencyRate === 1), "Main exact identity/customer/AUD/GST-exclusive evidence mismatch.");
  requireFact(["Payments", "CreditNotes", "Prepayments", "Overpayments"].every(key => !main[key] || Array.isArray(main[key]) && main[key].length === 0) &&
    ["AmountPaid", "AmountCredited"].every(key => main[key] === undefined || main[key] === 0), "Main has financial allocations/payments; hold.");
  requireFact(Array.isArray(main.LineItems) && main.LineItems.length > 0 && !main.LineItems.some((line: any) => /^WAR/i.test(String(line.ItemCode ?? ""))), "Main already has a WAR line or lacks full lines; never replace/remove/adopt.");
  const lines = main.LineItems.map((line: XeroRow) => nativeLine(line, true));
  requireFact(new Set(lines.map((line: XeroRow) => line.LineItemID)).size === lines.length, "Main duplicate line IDs hold.");
  const subtotal = money(lines.reduce((sum: number, line: XeroRow) => sum + line.LineAmount, 0));
  const tax = money(lines.reduce((sum: number, line: XeroRow) => sum + line.TaxAmount, 0));
  requireFact(numeric(main.SubTotal) && numeric(main.TotalTax) && numeric(main.Total) && cents(main.SubTotal) === cents(subtotal) && cents(main.TotalTax) === cents(tax) && cents(main.Total) === cents(subtotal + tax) &&
    (main.AmountDue === undefined || numeric(main.AmountDue) && cents(main.AmountDue) === cents(main.Total)), "Main full-line totals do not reconcile exactly.");
  const date = xeroDate(main.DateString ?? main.Date);
  const due = xeroDate(main.DueDateString ?? main.DueDate);
  requireFact(date && (!due || due >= date), "Exact current main issue date and non-conflicting due date required; no locale/date invention.");
  requireFact((config.dateSemantics.issue === "preserve_main_date" && !config.fields.issueDate || config.dateSemantics.issue === "source_iso_date" && facts.issueDate === date) &&
    (config.dateSemantics.due === "preserve_main_due_date" && !config.fields.dueDate || config.dateSemantics.due === "source_iso_date" && facts.dueDate === due), "Approved source issue/due semantics mismatch; never amend main dates.");
  const mapping = facts.mapping!;
  const warTax = money(mapping.premiumExGst * 0.1);
  const warrantyLine = { ItemCode: mapping.itemCode, Description: mapping.nativeDescription, Quantity: 1, UnitAmount: mapping.premiumExGst, AccountCode: e.item.SalesDetails.AccountCode, TaxType: "OUTPUT", LineAmount: mapping.premiumExGst, TaxAmount: warTax };
  const header: XeroRow = { InvoiceID: main.InvoiceID, InvoiceNumber: mainNumber, Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: e.customer.ContactID }, CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Date: date, LineItems: [...lines, warrantyLine] };
  if (due) header.DueDate = due;
  for (const key of ["Reference", "BrandingThemeID", "Url", "CurrencyRate", "SentToContact"]) if (Object.hasOwn(main, key)) header[key] = main[key];
  const po: XeroRow = { PurchaseOrderNumber: poNumber, Status: "DRAFT", Contact: { ContactID: e.supplier.ContactID }, CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Date: facts.issueDate ?? date,
    Reference: facts.addedServices, LineItems: [{ ...warrantyLine, AccountCode: AVISO_ACCOUNT, TaxType: "INPUT" }] };
  const payload = (operation: WarrantyPayload["operation"], endpoint: string, body: WarrantyPayload["body"]): WarrantyPayload => ({ operation, method: "POST", endpoint, body, idempotencyKey: financialSha256({ operation, dealId: facts.dealId, sourceHash: financialSha256(facts), body }) });
  return { mainNumber, poNumber, expectedMain: { ...header, SubTotal: money(subtotal + mapping.premiumExGst), TotalTax: money(tax + warTax), Total: money(subtotal + mapping.premiumExGst + tax + warTax) },
    expectedPo: { ...po, SubTotal: mapping.premiumExGst, TotalTax: warTax, Total: money(mapping.premiumExGst + warTax) },
    mainPayload: payload("append_main_draft", `/Invoices/${encodeURIComponent(main.InvoiceID)}`, { Invoices: [header] }),
    poPayload: payload("create_aviso_draft", "/PurchaseOrders", { PurchaseOrders: [po] }) };
}

/** Full business-document comparison: preserve every existing line/header and append exactly one native WAR line. */
export function assertWarrantyReadback(actual: XeroRow | null, expected: XeroRow, kind: "main" | "po", expectedId?: string): void {
  requireFact(actual && actual.Status === "DRAFT" && actual.CurrencyCode === "AUD" && actual.LineAmountTypes === "Exclusive" && actual.Contact?.ContactID === expected.Contact.ContactID,
    "Warranty readback status/contact/currency/GST mismatch; reconciliation required.");
  const idKey = kind === "main" ? "InvoiceID" : "PurchaseOrderID";
  const numberKey = kind === "main" ? "InvoiceNumber" : "PurchaseOrderNumber";
  requireFact(actual[idKey] && (!expectedId || actual[idKey] === expectedId) && actual[numberKey] === expected[numberKey] && (kind !== "main" || actual.Type === "ACCREC" && actual.InvoiceID === expected.InvoiceID), "Exact warranty document ID/number/type readback mismatch.");
  const expectedDue = expected.DueDate ?? null;
  const actualDue = xeroDate(actual.DueDateString ?? actual.DueDate);
  requireFact(xeroDate(actual.DateString ?? actual.Date) === expected.Date && (kind !== "main" || actualDue === expectedDue) && (kind !== "po" || !actual.DueDate && !actual.DueDateString), "Warranty full-document dates mismatch.");
  for (const key of ["Reference", "BrandingThemeID", "Url", "CurrencyRate", "SentToContact"]) requireFact((actual[key] ?? (key === "Reference" || key === "Url" ? "" : null)) === (expected[key] ?? (key === "Reference" || key === "Url" ? "" : null)), `Warranty preserved header ${key} mismatch.`);
  for (const key of ["SubTotal", "TotalTax", "Total"]) requireFact(numeric(actual[key]) && cents(actual[key]) === cents(expected[key]), `Warranty exact ${key} readback mismatch.`);
  requireFact(Array.isArray(actual.LineItems) && actual.LineItems.length === expected.LineItems.length, "Warranty full-line count mismatch.");
  actual.LineItems.forEach((line: XeroRow, index: number) => {
    const wanted = expected.LineItems[index];
    const got = nativeLine(line, Boolean(wanted.LineItemID));
    if (!wanted.LineItemID) delete got.LineItemID;
    for (const key of ["DiscountRate", "Tracking"]) {
      if (key === "DiscountRate" && (got[key] ?? 0) === 0 && (wanted[key] ?? 0) === 0) delete got[key];
      if (key === "Tracking" && (!got[key] || got[key].length === 0) && (!wanted[key] || wanted[key].length === 0)) delete got[key];
    }
    const normalized = { ...wanted };
    if ((normalized.DiscountRate ?? 0) === 0) delete normalized.DiscountRate;
    if (!normalized.Tracking?.length) delete normalized.Tracking;
    requireFact(financialSha256(got) === financialSha256(normalized), `Warranty exact full-line ${index + 1} mismatch; reconciliation required.`);
  });
}
