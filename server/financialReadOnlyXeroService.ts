import axios from "axios";
import { getXeroToken } from "./db";
import { runCachedXeroGet, XERO_CACHE_TTL, type XeroRequestAuth } from "./xeroRequestManager";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import { EXPECTED_AP_XERO_TENANT_LABEL, getXeroReadAuthWithRefresh } from "./xeroService";

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
  expiresAt: Date | null;
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
  contactCheck: { partyName: string | null; found: boolean | null; count: number | null; contactId: string | null };
  error: string | null;
};

/** Exact GET-only evidence recorded after a financial Draft request returns. */
export type FinancialDraftReadBack = {
  documentFamily: "purchase_order" | "customer_invoice";
  xeroDocumentId: string;
  documentNumber: string;
  status: "DRAFT";
  partyName: string | null;
  subtotal: number | null;
  total: number | null;
  lineCount: number;
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
    configured: false, tokenState: "missing", tenantName: null, tenantIdHint: null, tenantId: null, expiresAt: null, scopeConfigured: false, readOnlyGuard: true,
  };
  const millis = token.expiresAt.getTime() - Date.now();
  return {
    configured: true,
    tokenState: millis <= 0 ? "expired" : millis < 10 * 60_000 ? "expiring_soon" : "valid",
    tenantName: token.tenantName ?? null,
    tenantIdHint: tenantHint(token.tenantId),
    tenantId: token.tenantId ?? null,
    expiresAt: token.expiresAt,
    scopeConfigured: Boolean(token.scope?.includes("accounting.invoices")),
    readOnlyGuard: true,
  };
}

/**
 * Returns AP authentication for subsequent accounting GETs. Xero access tokens
 * normally last 30 minutes, so an expired session is renewed through the OAuth
 * token endpoint before this function performs any accounting request. The
 * refresh is identity-only; all Xero accounting work in this module remains GET.
 */
async function readOnlyAuth(): Promise<ReadOnlyAuth> {
  const stored = await getXeroToken();
  if (!stored) throw new Error("Xero is not connected in AP Management");
  const auth = await getXeroReadAuthWithRefresh();
  const current = await getXeroToken();
  return { token: auth.token, tenantId: auth.tenantId, tenantName: current?.tenantName ?? stored.tenantName ?? null };
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

/**
 * Proves the accounting tenant immediately before a proposal can become
 * execution-eligible. OAuth connection selection is also guarded elsewhere,
 * but the financial preflight never relies on a stored tenant label alone.
 */
async function assertExpectedFinancialTenant(auth: ReadOnlyAuth): Promise<void> {
  const organisation = await xeroRead<any>(auth, "execution-tenant", `${XERO_API_BASE}/Organisation`);
  const organisationName = String(organisation?.Organisations?.[0]?.Name ?? "").trim();
  if (!organisationName.toUpperCase().includes(EXPECTED_AP_TENANT_LABEL)) {
    throw new Error(`Connected Xero organisation does not match the expected AP tenant label ${EXPECTED_AP_TENANT_LABEL}.`);
  }
}

export async function getFinancialXeroConnectionStatus(): Promise<FinancialXeroConnectionStatus> {
  return connectionBase(await getXeroToken());
}

/** Runs only GET connection/organisation reads; it never refreshes a token or changes Xero state. */
export async function testFinancialXeroConnection(): Promise<FinancialXeroConnectionTest> {
  let token = await getXeroToken();
  let base = connectionBase(token);
  const checkedAt = new Date();
  if (!token) {
    return { ...base, outcome: "blocked", organisationName: null, expectedTenantLabel: EXPECTED_AP_TENANT_LABEL, checkedAt, message: "AP Management has no usable Xero token for a read-only test." };
  }
  try {
    const auth = await readOnlyAuth();
    // Refresh the non-secret status after an identity-only OAuth refresh so the
    // UI records the actual access-token expiry used by the GET verification.
    token = await getXeroToken();
    base = connectionBase(token);
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
    contactCheck: { partyName: intent.partyName, found: null, count: null, contactId: null },
    error: intent.proposedDocumentNumber ? null : "No proposed document reference is available for Xero preflight.",
  };
}

async function preflightContact(auth: ReadOnlyAuth, partyName: string | null): Promise<FinancialXeroPreflight["contactCheck"]> {
  if (!partyName?.trim()) return { partyName: null, found: null, count: null, contactId: null };
  const response = await xeroRead<any>(auth, `contact:${partyName.trim().toUpperCase()}`, `${XERO_API_BASE}/Contacts`, { searchTerm: partyName.trim() });
  const contacts = Array.isArray(response?.Contacts) ? response.Contacts : [];
  const exact = contacts.filter((contact: any) => String(contact?.Name ?? "").trim().toLowerCase() === partyName.trim().toLowerCase());
  return {
    partyName,
    found: exact.length === 1,
    count: exact.length,
    contactId: exact.length === 1 && exact[0]?.ContactID ? String(exact[0].ContactID) : null,
  };
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
      // Purchase orders must use the purchase-side wording, not the sales description.
      nativeDescription: (itemCode === "JD 20" || itemCode === "JD 40")
        ? (item?.PurchaseDescription ? String(item.PurchaseDescription) : item?.Description ? String(item.Description) : null)
        : (item?.Description ? String(item.Description) : null),
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
  // Xero still returns deleted/voided invoice numbers and may refuse their reuse.
  // Every exact-number ACCREC is a collision, regardless of its status.
  const records = (response?.Invoices ?? []).filter((invoice: any) => invoice?.Type === "ACCREC"
    && String(invoice?.InvoiceNumber ?? "").trim().toUpperCase() === result.documentNumber!.trim().toUpperCase());
  if (records.length === 0) { result.duplicateState = "not_found"; return; }
  if (records.length > 1) { result.duplicateState = "ambiguous"; result.error = "More than one exact Xero customer invoice has this number, including deleted or voided history; reconcile by immutable ID."; return; }
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
  await assertExpectedFinancialTenant(auth);
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

/** GET-only verification of the three account codes required for loaded storage. */
export async function verifyInitialStorageXeroAccounts(): Promise<void> {
  const auth = await readOnlyAuth();
  await assertExpectedFinancialTenant(auth);
  const response = await xeroRead<any>(auth, "storage-account-codes", `${XERO_API_BASE}/Accounts`);
  const accounts = Array.isArray(response?.Accounts) ? response.Accounts : [];
  for (const code of ["200", "310", "311"]) {
    const matches = accounts.filter((account: any) => String(account?.Code ?? "").trim() === code && String(account?.Status ?? "").toUpperCase() === "ACTIVE");
    if (matches.length !== 1) throw new Error(`Xero storage account ${code} is absent, inactive, or ambiguous.`);
  }
  for (const code of ["JD 20", "JD 40"]) {
    const jd = await preflightItem(auth, code);
    if (!jd.found || !jd.nativeDescription) throw new Error(`Xero ${code} purchase item or its native description is missing.`);
  }
}

/**
 * Reads back the exact Xero Draft created or updated by the guarded writer.
 * A missing, mismatched, or non-Draft response is a reconciliation condition;
 * callers must not infer success from the transport response alone.
 */
export async function readBackFinancialDraft(input: {
  documentFamily: "purchase_order" | "customer_invoice";
  documentNumber: string;
  expectedXeroDocumentId: string;
  expectedDocument?: ProposedFinancialDocument;
}): Promise<FinancialDraftReadBack> {
  const auth = await readOnlyAuth();
  await assertExpectedFinancialTenant(auth);
  const expectedNumber = input.documentNumber.trim();
  if (!expectedNumber || !input.expectedXeroDocumentId.trim()) {
    throw new Error("Exact Xero document number and ID are required for Draft read-back.");
  }
  let document: any = null;
  if (input.documentFamily === "purchase_order") {
    const response = await xeroRead<any>(auth, `post-write-po:${input.expectedXeroDocumentId}`, `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(input.expectedXeroDocumentId)}`);
    document = response?.PurchaseOrders?.[0] ?? null;
  } else {
    const response = await xeroRead<any>(auth, `post-write-invoice:${input.expectedXeroDocumentId}`, `${XERO_API_BASE}/Invoices/${encodeURIComponent(input.expectedXeroDocumentId)}`);
    document = response?.Invoices?.[0] ?? null;
  }
  const documentNumber = String(document?.PurchaseOrderNumber ?? document?.InvoiceNumber ?? "").trim();
  const xeroDocumentId = String(document?.PurchaseOrderID ?? document?.InvoiceID ?? "").trim();
  const status = String(document?.Status ?? "").trim().toUpperCase();
  if (!document || xeroDocumentId !== input.expectedXeroDocumentId || documentNumber.toUpperCase() !== expectedNumber.toUpperCase() || status !== "DRAFT") {
    throw new Error(`Xero Draft read-back did not verify the exact expected document ${expectedNumber}.`);
  }
  const numeric = (value: unknown): number | null => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const expected = input.expectedDocument;
  if (expected) {
    const lines = Array.isArray(document.LineItems) ? document.LineItems : [];
    const dateOnly = (value: unknown) => {
      const raw = String(value ?? "");
      const ms = raw.match(/^\/Date\((\d+)(?:[+-]\d+)?\)\/$/);
      const parsed = ms ? new Date(Number(ms[1])) : new Date(raw);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0,10) : null;
    };
    if (document.Contact?.ContactID !== expected.partySourceId || document.LineAmountTypes !== "Exclusive" ||
      (expected.documentFamily === "customer_invoice" && document.Type !== "ACCREC") ||
      (expected.issueDate && dateOnly(document.DateString ?? document.Date) !== expected.issueDate.toISOString().slice(0,10)) ||
      (expected.dueDate && dateOnly(document.DueDateString ?? document.DueDate) !== expected.dueDate.toISOString().slice(0,10)) ||
      !Number.isFinite(Number(document.SubTotal)) || !Number.isFinite(Number(document.Total)) ||
      Math.abs(Number(document.SubTotal) - expected.subtotal) > 0.01 || Math.abs(Number(document.Total) - expected.total) > 0.01 ||
      lines.length !== expected.lineItems.length || lines.some((line: any, index: number) => {
        const wanted = expected.lineItems[index]!;
        return line.Description !== wanted.description || String(line.AccountCode) !== String(wanted.accountCode) ||
          !Number.isFinite(Number(line.UnitAmount)) ||
          Number(line.Quantity) !== wanted.quantity || Math.abs(Number(line.UnitAmount) - wanted.unitAmount) > 0.001 ||
          line.TaxType !== (expected.documentFamily === "purchase_order" ? "INPUT" : "OUTPUT");
      })) throw new Error(`Xero Draft ${expectedNumber} does not match the exact storage contact, lines, account or totals.`);
  }
  return {
    documentFamily: input.documentFamily,
    xeroDocumentId,
    documentNumber,
    status: "DRAFT",
    partyName: document?.Contact?.Name ? String(document.Contact.Name) : null,
    subtotal: numeric(document?.SubTotal),
    total: numeric(document?.Total),
    lineCount: Array.isArray(document?.LineItems) ? document.LineItems.length : 0,
  };
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
