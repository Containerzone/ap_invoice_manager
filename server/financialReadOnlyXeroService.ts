import axios from "axios";
import { getXeroToken } from "./db";
import { runCachedXeroGet, XERO_CACHE_TTL, type XeroRequestAuth } from "./xeroRequestManager";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import { EXPECTED_AP_XERO_TENANT_LABEL } from "./xeroService";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const XERO_IDENTITY_BASE = "https://api.xero.com/connections";
const MAX_FINANCIAL_PREFLIGHTS = 25;
const EXPECTED_AP_TENANT_LABEL = EXPECTED_AP_XERO_TENANT_LABEL;

export type FinancialXeroConnectionStatus = {
  configured: boolean;
  tokenState: "missing" | "expired" | "expiring_soon" | "valid";
  tenantName: string | null;
  tenantIdHint: string | null;
  tenantId: string | null;
  scopeConfigured: boolean;
  readOnlyGuard: true;
};

export type FinancialXeroConnectionTest = FinancialXeroConnectionStatus & {
  outcome: "passed" | "blocked" | "failed";
  organisationName: string | null;
  expectedTenantLabel: string;
  checkedAt: Date;
  message: string;
};

export type FinancialXeroPreflight = {
  documentNumber: string | null;
  documentFamily: "purchase_order" | "customer_invoice";
  duplicateState: "not_found" | "found" | "ambiguous" | "not_checked" | "blocked" | "error";
  xeroDocumentId: string | null;
  status: string | null;
  partyName: string | null;
  itemChecks: Array<{ itemCode: string; found: boolean; purchaseUnitPrice: number | null; salesUnitPrice: number | null; nativeDescription: string | null }>;
  contactCheck: { partyName: string | null; found: boolean | null; count: number | null };
  error: string | null;
};

export type HistoricalXeroPreviewRow = {
  reference: string;
  inferredFamily: "purchase_order" | "customer_invoice" | "needs_review";
  reconciliationState: "matched" | "unmatched" | "ambiguous" | "needs_review" | "blocked";
  xeroDocumentId: string | null;
  documentNumber: string | null;
  status: string | null;
  partyName: string | null;
  importPreviewedAt: Date;
  note: string;
};

type ReadOnlyAuth = XeroRequestAuth & { tenantName: string | null };

function safeMessage(error: unknown): string {
  const status = (error as any)?.response?.status;
  if (status === 401 || status === 403) return "Xero read access was rejected. Re-authenticate the AP Management Xero connection.";
  if (status === 429) return "Xero is currently rate limited; preflight was not completed.";
  if (typeof status === "number") return `Xero read request returned HTTP ${status}.`;
  return "Xero read request could not be completed.";
}

function tenantHint(tenantId: string | null | undefined): string | null {
  if (!tenantId) return null;
  return `…${tenantId.slice(-8)}`;
}

function connectionBase(token: Awaited<ReturnType<typeof getXeroToken>>): FinancialXeroConnectionStatus {
  if (!token) return {
    configured: false, tokenState: "missing", tenantName: null, tenantIdHint: null, tenantId: null, scopeConfigured: false, readOnlyGuard: true,
  };
  const millis = token.expiresAt.getTime() - Date.now();
  return {
    configured: true,
    tokenState: millis <= 0 ? "expired" : millis < 10 * 60_000 ? "expiring_soon" : "valid",
    tenantName: token.tenantName ?? null,
    tenantIdHint: tenantHint(token.tenantId),
    tenantId: token.tenantId ?? null,
    scopeConfigured: Boolean(token.scope?.includes("accounting.invoices")),
    readOnlyGuard: true,
  };
}

/** Returns only an already-valid token. Financial shadow validation never refreshes via POST. */
async function readOnlyAuth(): Promise<ReadOnlyAuth> {
  const token = await getXeroToken();
  if (!token) throw new Error("Xero is not connected in AP Management");
  if (token.expiresAt <= new Date(Date.now() + 60_000)) {
    throw new Error("AP Management's Xero token is expired or near expiry; re-authenticate before read-only validation");
  }
  return { token: token.accessToken, tenantId: token.tenantId, tenantName: token.tenantName ?? null };
}

/**
 * The financial migration may only reach Xero through this GET-only helper.
 * Keeping verb and endpoint construction here makes an accidental future write
 * fail review and keeps test evidence explicit.
 */
async function xeroRead<T>(auth: ReadOnlyAuth, cacheKey: string, url: string, params?: Record<string, string>): Promise<T> {
  return runCachedXeroGet<T>(
    auth,
    `financial-read:${cacheKey}`,
    XERO_CACHE_TTL.invoiceSearch,
    () => axios.get(url, {
      headers: { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" },
      params,
    }),
    { forceRefresh: true },
  );
}

export async function getFinancialXeroConnectionStatus(): Promise<FinancialXeroConnectionStatus> {
  return connectionBase(await getXeroToken());
}

/** Runs only GET connection/organisation reads; it never refreshes a token or changes Xero state. */
export async function testFinancialXeroConnection(): Promise<FinancialXeroConnectionTest> {
  const token = await getXeroToken();
  const base = connectionBase(token);
  const checkedAt = new Date();
  if (!token || base.tokenState === "expired") {
    return { ...base, outcome: "blocked", organisationName: null, expectedTenantLabel: EXPECTED_AP_TENANT_LABEL, checkedAt, message: "AP Management has no usable Xero token for a read-only test." };
  }
  try {
    const auth = await readOnlyAuth();
    const [organisation, connections] = await Promise.all([
      xeroRead<any>(auth, "organisation", `${XERO_API_BASE}/Organisation`),
      // The identity endpoint is also a GET. It confirms the stored AP token is
      // connected to an organisation without exposing credentials to the browser.
      runCachedXeroGet<any>(auth, "financial-read:connections", XERO_CACHE_TTL.invoiceSearch, () => axios.get(XERO_IDENTITY_BASE, {
        headers: { Authorization: `Bearer ${auth.token}`, Accept: "application/json" },
      }), { forceRefresh: true }),
    ]);
    const organisationName = organisation?.Organisations?.[0]?.Name ?? connections?.[0]?.tenantName ?? auth.tenantName;
    const matchedExpectedTenant = String(organisationName ?? "").trim().toUpperCase().includes(EXPECTED_AP_TENANT_LABEL);
    if (!matchedExpectedTenant) {
      return { ...base, outcome: "failed", organisationName: organisationName ?? null, expectedTenantLabel: EXPECTED_AP_TENANT_LABEL, checkedAt, message: `Connected Xero organisation does not match the expected AP tenant label ${EXPECTED_AP_TENANT_LABEL}. No Xero write endpoint was called.` };
    }
    return { ...base, outcome: "passed", organisationName: organisationName ?? null, expectedTenantLabel: EXPECTED_AP_TENANT_LABEL, checkedAt, message: "Read-only organisation and connection checks passed for the expected AP tenant. No Xero write endpoint was called." };
  } catch (error) {
    return { ...base, outcome: "failed", organisationName: null, expectedTenantLabel: EXPECTED_AP_TENANT_LABEL, checkedAt, message: safeMessage(error) };
  }
}

function initialPreflight(intent: ProposedFinancialDocument): FinancialXeroPreflight {
  return {
    documentNumber: intent.proposedDocumentNumber,
    documentFamily: intent.documentFamily,
    duplicateState: intent.proposedDocumentNumber ? "not_checked" : "blocked",
    xeroDocumentId: null,
    status: null,
    partyName: null,
    itemChecks: [],
    contactCheck: { partyName: intent.partyName, found: null, count: null },
    error: intent.proposedDocumentNumber ? null : "No proposed document reference is available for Xero preflight.",
  };
}

async function preflightContact(auth: ReadOnlyAuth, partyName: string | null): Promise<FinancialXeroPreflight["contactCheck"]> {
  if (!partyName?.trim()) return { partyName: null, found: null, count: null };
  const response = await xeroRead<any>(auth, `contact:${partyName.trim().toUpperCase()}`, `${XERO_API_BASE}/Contacts`, { searchTerm: partyName.trim() });
  const contacts = Array.isArray(response?.Contacts) ? response.Contacts : [];
  const exact = contacts.filter((contact: any) => String(contact?.Name ?? "").trim().toLowerCase() === partyName.trim().toLowerCase());
  return { partyName, found: exact.length === 1, count: exact.length };
}

async function preflightItem(auth: ReadOnlyAuth, itemCode: string) {
  try {
    const response = await xeroRead<any>(auth, `item:${itemCode.toUpperCase()}`, `${XERO_API_BASE}/Items/${encodeURIComponent(itemCode)}`);
    const item = response?.Items?.[0] ?? null;
    return {
      itemCode,
      found: Boolean(item),
      purchaseUnitPrice: typeof item?.PurchaseDetails?.UnitPrice === "number" ? item.PurchaseDetails.UnitPrice : Number(item?.PurchaseDetails?.UnitPrice ?? NaN) || null,
      salesUnitPrice: typeof item?.SalesDetails?.UnitPrice === "number" ? item.SalesDetails.UnitPrice : Number(item?.SalesDetails?.UnitPrice ?? NaN) || null,
      nativeDescription: item?.Description ? String(item.Description) : null,
    };
  } catch (error: any) {
    if (error?.response?.status === 404) return { itemCode, found: false, purchaseUnitPrice: null, salesUnitPrice: null, nativeDescription: null };
    throw error;
  }
}

async function preflightDocument(auth: ReadOnlyAuth, result: FinancialXeroPreflight): Promise<void> {
  if (!result.documentNumber) return;
  if (result.documentFamily === "purchase_order") {
    try {
      const response = await xeroRead<any>(auth, `po:${result.documentNumber.toUpperCase()}`, `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(result.documentNumber)}`);
      const po = response?.PurchaseOrders?.[0] ?? null;
      if (!po) { result.duplicateState = "not_found"; return; }
      result.duplicateState = "found";
      result.xeroDocumentId = po.PurchaseOrderID ?? null;
      result.status = po.Status ?? null;
      result.partyName = po.Contact?.Name ?? null;
      return;
    } catch (error: any) {
      if (error?.response?.status === 404) { result.duplicateState = "not_found"; return; }
      throw error;
    }
  }
  const response = await xeroRead<any>(auth, `invoice:${result.documentNumber.toUpperCase()}`, `${XERO_API_BASE}/Invoices`, { InvoiceNumbers: result.documentNumber });
  const records = (response?.Invoices ?? []).filter((invoice: any) => invoice?.Type === "ACCREC" && !["VOIDED", "DELETED"].includes(invoice?.Status));
  if (records.length === 0) { result.duplicateState = "not_found"; return; }
  if (records.length > 1) { result.duplicateState = "ambiguous"; result.error = "More than one active Xero customer invoice has this number."; return; }
  const invoice = records[0];
  result.duplicateState = "found";
  result.xeroDocumentId = invoice.InvoiceID ?? null;
  result.status = invoice.Status ?? null;
  result.partyName = invoice.Contact?.Name ?? null;
}

/**
 * Reads only exact candidate documents, contacts and required items. Calls are
 * intentionally sequential (and capped) so the central Xero rate manager can
 * pace the tenant. Results are evidence, never a permission to write.
 */
export async function preflightFinancialXeroIntents(intents: ProposedFinancialDocument[]): Promise<FinancialXeroPreflight[]> {
  if (intents.length > MAX_FINANCIAL_PREFLIGHTS) throw new Error("Too many proposed documents for a single read-only Xero preflight");
  const auth = await readOnlyAuth();
  const results: FinancialXeroPreflight[] = [];
  for (const intent of intents) {
    const result = initialPreflight(intent);
    try {
      await preflightDocument(auth, result);
      result.contactCheck = await preflightContact(auth, intent.partyName);
      const codes = Array.from(new Set(intent.lineItems.map((line) => line.itemCode.trim()).filter(Boolean))).slice(0, 12);
      for (const code of codes) result.itemChecks.push(await preflightItem(auth, code));
    } catch (error) {
      result.duplicateState = "error";
      result.error = safeMessage(error);
    }
    results.push(result);
  }
  return results;
}

function historicalFamily(reference: string): HistoricalXeroPreviewRow["inferredFamily"] {
  const value = reference.trim().toUpperCase();
  if (/^(A|S|H|JD|GD|I)\d+(?:-\d+)?$/.test(value)) return "purchase_order";
  if (/^INV-\d+(?:-[A-Z0-9]+)?$/.test(value)) return "customer_invoice";
  return "needs_review";
}

/**
 * A bounded, no-persistence historical visibility preview. It considers only
 * supplied reference strings; it does not list or bulk-copy the Xero ledger.
 */
export async function previewHistoricalXeroReferences(references: string[]): Promise<HistoricalXeroPreviewRow[]> {
  const unique = Array.from(new Set(references.map((reference) => reference.trim().toUpperCase()).filter(Boolean))).slice(0, 50);
  const auth = await readOnlyAuth();
  const rows: HistoricalXeroPreviewRow[] = [];
  for (const reference of unique) {
    const inferredFamily = historicalFamily(reference);
    const importPreviewedAt = new Date();
    if (inferredFamily === "needs_review") {
      rows.push({ reference, inferredFamily, reconciliationState: "needs_review", xeroDocumentId: null, documentNumber: null, status: null, partyName: null, importPreviewedAt, note: "Reference does not match an approved A/S/H/JD/GD/I/INV- pattern." });
      continue;
    }
    try {
      if (inferredFamily === "purchase_order") {
        const response = await xeroRead<any>(auth, `historical-po:${reference}`, `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(reference)}`);
        const records = response?.PurchaseOrders ?? [];
        if (records.length === 0) rows.push({ reference, inferredFamily, reconciliationState: "unmatched", xeroDocumentId: null, documentNumber: null, status: null, partyName: null, importPreviewedAt, note: "No matching Xero purchase order was found." });
        else if (records.length > 1) rows.push({ reference, inferredFamily, reconciliationState: "ambiguous", xeroDocumentId: null, documentNumber: null, status: null, partyName: null, importPreviewedAt, note: "More than one Xero purchase order matched; manual review is required." });
        else {
          const item = records[0];
          rows.push({ reference, inferredFamily, reconciliationState: "matched", xeroDocumentId: item.PurchaseOrderID ?? null, documentNumber: item.PurchaseOrderNumber ?? reference, status: item.Status ?? null, partyName: item.Contact?.Name ?? null, importPreviewedAt, note: "Exact purchase-order reference match (preview only)." });
        }
      } else {
        const response = await xeroRead<any>(auth, `historical-invoice:${reference}`, `${XERO_API_BASE}/Invoices`, { InvoiceNumbers: reference });
        const records = (response?.Invoices ?? []).filter((item: any) => item?.Type === "ACCREC" && !["VOIDED", "DELETED"].includes(item?.Status));
        if (records.length === 0) rows.push({ reference, inferredFamily, reconciliationState: "unmatched", xeroDocumentId: null, documentNumber: null, status: null, partyName: null, importPreviewedAt, note: "No matching active Xero customer invoice was found." });
        else if (records.length > 1) rows.push({ reference, inferredFamily, reconciliationState: "ambiguous", xeroDocumentId: null, documentNumber: null, status: null, partyName: null, importPreviewedAt, note: "More than one active customer invoice matched; manual review is required." });
        else {
          const item = records[0];
          rows.push({ reference, inferredFamily, reconciliationState: "matched", xeroDocumentId: item.InvoiceID ?? null, documentNumber: item.InvoiceNumber ?? reference, status: item.Status ?? null, partyName: item.Contact?.Name ?? null, importPreviewedAt, note: "Exact customer-invoice reference match (preview only)." });
        }
      }
    } catch (error: any) {
      if (error?.response?.status === 404) {
        rows.push({ reference, inferredFamily, reconciliationState: "unmatched", xeroDocumentId: null, documentNumber: null, status: null, partyName: null, importPreviewedAt, note: "No matching Xero record was found." });
      } else {
        rows.push({ reference, inferredFamily, reconciliationState: "blocked", xeroDocumentId: null, documentNumber: null, status: null, partyName: null, importPreviewedAt, note: safeMessage(error) });
      }
    }
  }
  return rows;
}
