import axios from "axios";
import { getXeroReadAuthWithRefresh, EXPECTED_AP_XERO_TENANT_LABEL } from "./xeroService";
import { runCachedXeroGet, XERO_CACHE_TTL } from "./xeroRequestManager";
import { financialSha256 } from "./financialProposalIntegrity";
import { AVISO_NAME, WARRANTY_MAIN_ACCOUNT, type WarrantyFacts, type WarrantyXeroEvidence, type XeroRow } from "./financialWarrantyAvisoRules";
const BASE = "https://api.xero.com/api.xro/2.0";
export const WARRANTY_INVOICE_STATUSES = "DRAFT,SUBMITTED,AUTHORISED,PAID,DELETED,VOIDED";
export const WARRANTY_PO_STATUSES = ["DRAFT", "SUBMITTED", "AUTHORISED", "BILLED", "DELETED"] as const;
async function session() {
  const auth = await getXeroReadAuthWithRefresh();
  const get = (path: string, params?: Record<string, string>) => runCachedXeroGet<any>(auth, `warranty-aviso:${path}:${JSON.stringify(params)}`, XERO_CACHE_TTL.invoiceSearch,
    () => axios.get(`${BASE}${path}`, { headers: { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" }, params, timeout: 20_000 }), { forceRefresh: true });
  const org = await get("/Organisation");
  if (!String(org?.Organisations?.[0]?.Name ?? "").toUpperCase().includes(EXPECTED_AP_XERO_TENANT_LABEL)) throw new Error("Warranty Xero tenant mismatch; hold.");
  return { get, tenantId: auth.tenantId };
}
function rows(response: any, key: string): XeroRow[] {
  if (!Array.isArray(response?.[key]) || response[key].length >= 100) throw new Error(`Warranty exact ${key} evidence incomplete or bounded limit reached; hold, not truncation.`);
  return response[key];
}
/** No broad ledger reads: exact INV-number, that Deal's tentative suffixes, exact ID-number including every PO state, exact contacts/item/accounts/tax only. */
export async function readWarrantyXeroEvidence(facts: WarrantyFacts, options: { customerContactId?: string | null } = {}): Promise<WarrantyXeroEvidence> {
  if (facts.holdReason || !/^D\d{1,12}$/.test(facts.dealNumber) || !facts.mapping || !facts.customerName) throw new Error("Exact approved warranty source required before Xero preflight.");
  const { get, tenantId } = await session();
  const mainNumber = `INV-${facts.dealNumber.slice(1)}`; const poNumber = `ID${facts.dealNumber.slice(1)}`;
  const mainHistory = rows(await get("/Invoices", { InvoiceNumbers: mainNumber, Statuses: WARRANTY_INVOICE_STATUSES, page: "1", pageSize: "100" }), "Invoices")
    .filter(i => String(i.InvoiceNumber ?? "").toUpperCase() === mainNumber);
  const detail = async (r: XeroRow, kind: "invoice" | "po") => {
    const key = kind === "invoice" ? "InvoiceID" : "PurchaseOrderID";
    if (typeof r[key] !== "string" || !r[key] || typeof r.Status !== "string") throw new Error("Exact warranty history lacks immutable ID/status; hold.");
    const list = rows(await get(`/${kind === "invoice" ? "Invoices" : "PurchaseOrders"}/${encodeURIComponent(r[key])}`), kind === "invoice" ? "Invoices" : "PurchaseOrders");
    if (list.length !== 1 || list[0][key] !== r[key] || list[0].Status !== r.Status || list[0][kind === "invoice" ? "InvoiceNumber" : "PurchaseOrderNumber"] !== r[kind === "invoice" ? "InvoiceNumber" : "PurchaseOrderNumber"] || !Array.isArray(list[0].LineItems)) throw new Error("Exact warranty ID/history/full-line detail drift; hold.");
    return list[0];
  };
  let main: XeroRow | null = null;
  if (mainHistory.length === 1) main = await detail(mainHistory[0], "invoice");
  const tentative = rows(await get("/Invoices", { where: `InvoiceNumber.StartsWith("${mainNumber}-")`, Statuses: WARRANTY_INVOICE_STATUSES, page: "1", pageSize: "100" }), "Invoices")
    .filter(i => String(i.InvoiceNumber ?? "").toUpperCase().startsWith(`${mainNumber}-`));
  const otherInvoices: XeroRow[] = [];
  for (const r of tentative) otherInvoices.push(await detail(r, "invoice"));
  const poHistory: XeroRow[] = [];
  // Xero PO uses singular Status; never rely on default ACTIVE-only collection results for collision evidence.
  for (const Status of WARRANTY_PO_STATUSES) {
    const matches = rows(await get("/PurchaseOrders", { where: `PurchaseOrderNumber=="${poNumber}"`, Status, page: "1" }), "PurchaseOrders")
      .filter(r => String(r.PurchaseOrderNumber ?? "").toUpperCase() === poNumber);
    poHistory.push(...matches);
  }
  // Direct exact number GET also catches unexpected/future states, including VOIDED/PAID if returned.
  try { poHistory.push(...rows(await get(`/PurchaseOrders/${poNumber}`), "PurchaseOrders")); }
  catch (e: any) { if (e?.response?.status !== 404) throw e; }
  const unique = new Map<string, XeroRow>();
  for (const r of poHistory) {
    if (!r.PurchaseOrderID || String(r.PurchaseOrderNumber ?? "").toUpperCase() !== poNumber || !r.Status) throw new Error("Exact Aviso PO collision history identity mismatch.");
    const prev = unique.get(r.PurchaseOrderID); if (prev && prev.Status !== r.Status) throw new Error("Aviso PO status changed during current preflight; hold.");
    unique.set(r.PurchaseOrderID, r);
  }
  const purchaseOrders: XeroRow[] = [];
  for (const r of Array.from(unique.values())) purchaseOrders.push(await detail(r, "po"));
  const contact = async (name: string, immutableId?: string | null) => {
    if (immutableId) {
      const matches = rows(await get(`/Contacts/${encodeURIComponent(immutableId)}`), "Contacts");
      const row = matches.length === 1 ? matches[0] : null;
      if (!row || row.ContactID !== immutableId || row.Name !== name || row.ContactStatus !== "ACTIVE") throw new Error(`Exact ${name} Xero contact ID is missing, inactive or changed; hold.`);
      return row;
    }
    const matches = rows(await get("/Contacts", { where: `Name=="${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`, includeArchived: "true", page: "1" }), "Contacts").filter(c => c.Name === name);
    if (matches.length !== 1 || !matches[0].ContactID || matches[0].ContactStatus !== "ACTIVE") throw new Error(`Exact ${name} Xero contact absent/archived/ambiguous; hold.`);
    return matches[0];
  };
  const customer = await contact(facts.customerName, options.customerContactId); const supplier = await contact(AVISO_NAME);
  const items = rows(await get(`/Items/${encodeURIComponent(facts.mapping.itemCode)}`), "Items").filter(i => i.Code === facts.mapping!.itemCode);
  if (items.length !== 1) throw new Error("Current exact native WAR item absent/ambiguous.");
  const item = items[0]; const codes = Array.from(new Set(["313", WARRANTY_MAIN_ACCOUNT].filter((c): c is string => typeof c === "string" && /^\d+$/.test(c))));
  const accounts = rows(await get("/Accounts", { where: codes.map(c => `Code=="${c}"`).join(" OR ") }), "Accounts");
  const taxes = rows(await get("/TaxRates", { where: 'TaxType=="INPUT" OR TaxType=="OUTPUT"' }), "TaxRates");
  const configurationHash = financialSha256({ tenantId, supplier: { ContactID: supplier.ContactID, Name: supplier.Name, ContactStatus: supplier.ContactStatus },
    item: { Code: item.Code, Description: item.Description, PurchaseDescription: item.PurchaseDescription, IsSold: item.IsSold, IsPurchased: item.IsPurchased, SalesDetails: item.SalesDetails, PurchaseDetails: item.PurchaseDetails }, accounts, taxes });
  const evidence = { tenantId, mainHistory, main, otherInvoices, poHistory: Array.from(unique.values()), purchaseOrders, customer, supplier, item, accounts, taxes, configurationHash, historyComplete: true as const };
  return { ...evidence, comparisonHash: financialSha256(evidence) };
}
export async function readWarrantyDocument(kind: "main" | "po", immutableId: string): Promise<XeroRow> {
  if (!immutableId || !/^[A-Za-z0-9-]+$/.test(immutableId)) throw new Error("Exact immutable warranty document ID required.");
  const { get } = await session();
  const list = rows(await get(`/${kind === "main" ? "Invoices" : "PurchaseOrders"}/${encodeURIComponent(immutableId)}`), kind === "main" ? "Invoices" : "PurchaseOrders");
  if (list.length !== 1) throw new Error("Exact warranty readback missing/ambiguous.");
  return list[0];
}
