import axios from "axios";
import { createHash } from "node:crypto";
import { getXeroToken, upsertXeroToken } from "./db";
import {
  invalidateXeroCache,
  runCachedXeroGet,
  runXeroRequest,
  XERO_CACHE_TTL,
} from "./xeroRequestManager";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const XERO_IDENTITY_BASE = "https://api.xero.com/connections";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";

export function getXeroAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    // accounting.transactions was retired for apps created after 2 March 2026.
    // Use granular scopes instead: invoices covers bills/POs/credit notes;
    // payments covers bill payments; contacts covers suppliers.
    scope: "openid profile email accounting.invoices accounting.contacts accounting.payments accounting.settings accounting.attachments offline_access",
    state,
  });
  return `${XERO_AUTH_URL}?${params.toString()}`;
}

export async function exchangeXeroCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope: string }> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const data = response.data;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope,
  };
}

export async function refreshXeroToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  const data = response.data;
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt,
  };
}

export async function getXeroTenants(accessToken: string): Promise<Array<{ tenantId: string; tenantName: string }>> {
  const response = await axios.get(XERO_IDENTITY_BASE, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data.map((t: any) => ({ tenantId: t.tenantId, tenantName: t.tenantName }));
}

async function getValidAccessToken(clientId: string, clientSecret: string): Promise<{ token: string; tenantId: string }> {
  const stored = await getXeroToken();
  if (!stored) throw new Error("Xero is not connected. Please connect Xero in Settings before pushing bills.");

  // Check if token is still valid (with 60s buffer)
  if (stored.expiresAt > new Date(Date.now() + 60000)) {
    return { token: stored.accessToken, tenantId: stored.tenantId };
  }

  // Refresh the token
  try {
    const refreshed = await refreshXeroToken(stored.refreshToken, clientId, clientSecret);
    await upsertXeroToken({
      tenantId: stored.tenantId,
      tenantName: stored.tenantName ?? undefined,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      scope: stored.scope ?? undefined,
      connectedBy: stored.connectedBy,
    });
    return { token: refreshed.accessToken, tenantId: stored.tenantId };
  } catch (err: any) {
    console.error("[Xero] Token refresh failed:", err);
    throw new Error(`Xero token refresh failed: ${err?.response?.data ? JSON.stringify(err.response.data) : err.message}. Please reconnect Xero in Settings.`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getXeroRateLimitRetryDelayMs(headers: Record<string, unknown> | undefined, attempt: number): number {
  const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const raw = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
  const seconds = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(Math.round(seconds * 1000), 500), 10_000);
  }
  return 1_000 * (2 ** attempt);
}

function getXeroRateLimitHeader(headers: Record<string, unknown> | undefined, name: string): string | null {
  const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value == null ? null : String(value);
}

function describeXeroRateLimit(headers: Record<string, unknown> | undefined): string {
  const problem = getXeroRateLimitHeader(headers, "x-rate-limit-problem") ?? "unknown";
  const retryAfter = getXeroRateLimitHeader(headers, "retry-after") ?? "unknown";
  const minuteRemaining = getXeroRateLimitHeader(headers, "x-minlimit-remaining") ?? "unknown";
  const dayRemaining = getXeroRateLimitHeader(headers, "x-daylimit-remaining") ?? "unknown";
  return `problem=${problem}, retryAfter=${retryAfter}s, minuteRemaining=${minuteRemaining}, dayRemaining=${dayRemaining}`;
}

export function createXeroIdempotencyKey(operation: string, payload: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `ap-${operation}-${digest}`.slice(0, 128);
}

/**
 * A Xero HTTP 429 rejects the request before it is processed, so it is safe to
 * retry. The retry count is bounded to avoid leaving the invoice UI waiting too long.
 */
export async function withXeroRateLimitRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = 2
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (err: any) {
      if (err?.response?.status !== 429) throw err;
      if (attempt === maxRetries) {
        throw new Error(`Xero is temporarily rate-limiting ${operationName}. Please retry in a few minutes.`);
      }
      const delayMs = getXeroRateLimitRetryDelayMs(err?.response?.headers, attempt);
      console.warn(`[Xero] ${operationName} rate-limited (HTTP 429); retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await wait(delayMs);
    }
  }
  throw new Error(`Xero could not complete ${operationName}. Please retry shortly.`);
}

export interface XeroBill {
  invoiceId: string;
  invoiceNumber: string;
  reference: string;
  contact: { contactId: string; name: string };
  date: string;
  dueDate: string;
  subTotal: number;
  totalTax: number;
  total: number;
  status: string;
  currencyCode: string;
}

export interface XeroPOLineItem {
  lineItemId: string;
  description: string;
  quantity: number;
  unitAmount: number;
  lineAmount: number;
  taxAmount: number;
  accountCode: string;
  itemCode: string;
  taxType?: string;
}

export interface XeroPurchaseOrder {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  reference: string;
  contact: { contactId: string; name: string };
  date: string;
  deliveryDate: string;
  subTotal: number;
  totalTax: number;
  total: number;
  status: string;
  currencyCode: string;
  lineItems: XeroPOLineItem[];
}

/**
 * Internal helper: find an existing Xero ACCPAY bill by invoice number.
 * Tries two strategies to handle Xero's inconsistent behaviour with numeric invoice numbers:
 *   1. GET with Type=ACCPAY filter
 *   2. GET without Type filter (fallback)
 * Returns the raw Xero invoice object (not the mapped XeroBill type) or null.
 */
/**
 * Normalise a supplier name for fuzzy matching:
 * lowercase, strip punctuation and common business suffixes, collapse whitespace.
 */
function normaliseSupplierName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(pty|ltd|limited|services|service|group|australia|aust|au|the|and|&|p\/l|atf|t\/as)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if two supplier names are a fuzzy match (same logic as checkXeroBillDuplicate).
 */
function supplierNamesMatch(a: string, b: string): boolean {
  const na = normaliseSupplierName(a);
  const nb = normaliseSupplierName(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Word-level overlap: >=50% of words in common
  const wordsA = new Set(na.split(" ").filter(Boolean));
  const wordsB = nb.split(" ").filter(Boolean);
  if (wordsB.length === 0) return false;
  const overlap = wordsB.filter((w) => wordsA.has(w)).length;
  return overlap / wordsB.length >= 0.5;
}

async function findExistingXeroBill(
  invoiceNumber: string,
  auth: { token: string; tenantId: string },
  supplierName?: string
): Promise<any | null> {
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "Xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };

  /**
   * Check if a candidate Xero invoice is a valid match.
   * MUST be ACCPAY (supplier bill), not ACCREC (customer invoice).
   * If supplierName is provided, BOTH invoice number AND supplier name must match.
   * This prevents returning a different supplier's bill or a customer invoice that shares the same number.
   */
  const isMatch = (inv: any): boolean => {
    if (!inv || inv.Status === "VOIDED" || inv.Status === "DELETED") return false;
    // CRITICAL: Only match ACCPAY (supplier bills). Ignore ACCREC (customer invoices)
    // that happen to share the same invoice number.
    if (inv.Type !== "ACCPAY") {
      console.log(`[Xero] findExistingXeroBill: invoice ${invoiceNumber} found in Xero but is Type=${inv.Type} (not ACCPAY) — ignoring`);
      return false;
    }
    if (!supplierName) return true; // no supplier filter — match on invoice number alone
    const xeroContactName: string = inv.Contact?.Name ?? "";
    const matched = supplierNamesMatch(xeroContactName, supplierName);
    if (!matched) {
      console.log(`[Xero] findExistingXeroBill: invoice ${invoiceNumber} found in Xero but supplier mismatch — Xero: "${xeroContactName}" vs app: "${supplierName}" — treating as new bill`);
    }
    return matched;
  };

  // A single unfiltered request handles both numeric and text invoice numbers.
  // Local matching still strictly enforces ACCPAY and supplier identity.
  const data = await runCachedXeroGet<any>(
    auth,
    `invoice-number:${invoiceNumber.trim().toUpperCase()}`,
    XERO_CACHE_TTL.invoiceSearch,
    () => axios.get(`${XERO_API_BASE}/Invoices`, {
      headers,
      params: { InvoiceNumbers: invoiceNumber },
    }),
  );
  return data?.Invoices?.find((invoice: any) => isMatch(invoice)) ?? null;
}

export async function findXeroBillByInvoiceNumber(
  invoiceNumber: string,
  clientId: string,
  clientSecret: string
): Promise<XeroBill | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  try {
    const inv = await findExistingXeroBill(invoiceNumber, auth);
    if (!inv) return null;
    return {
      invoiceId: inv.InvoiceID,
      invoiceNumber: inv.InvoiceNumber,
      reference: inv.Reference ?? "",
      contact: { contactId: inv.Contact?.ContactID, name: inv.Contact?.Name },
      date: inv.DateString ?? inv.Date,
      dueDate: inv.DueDateString ?? inv.DueDate,
      subTotal: parseFloat(inv.SubTotal ?? "0"),
      totalTax: parseFloat(inv.TotalTax ?? "0"),
      total: parseFloat(inv.Total ?? "0"),
      status: inv.Status,
      currencyCode: inv.CurrencyCode ?? "AUD",
    };
  } catch (err: any) {
    console.error("[Xero] Find bill error:", err?.response?.data ?? err.message);
    throw err;
  }
}

/**
 * Check if a bill already exists in Xero for the given invoice number,
 * with fuzzy supplier name matching to catch manual records with name variations.
 * Returns the matching bill with a flag indicating if the supplier name matched.
 */
export async function checkXeroBillDuplicate(
  invoiceNumber: string,
  supplierName: string,
  clientId: string,
  clientSecret: string
): Promise<{ bill: XeroBill; supplierNameMatch: boolean; nameInXero: string } | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;
  try {
    const data = await runCachedXeroGet<any>(
      auth,
      `invoice-number:${invoiceNumber.trim().toUpperCase()}`,
      XERO_CACHE_TTL.invoiceSearch,
      () => axios.get(`${XERO_API_BASE}/Invoices`, {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          Accept: "application/json",
        },
        params: { InvoiceNumbers: invoiceNumber },
      }),
    );
    const inv = (data?.Invoices ?? []).find(
      (invoice: any) => invoice.Type === "ACCPAY" && invoice.Status !== "VOIDED" && invoice.Status !== "DELETED"
    ) ?? null;
    if (!inv) return null;
    const nameInXero: string = inv.Contact?.Name ?? "";
    // Fuzzy name match: normalise both names (lowercase, strip punctuation/common words)
    const normalise = (s: string) =>
      s.toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\b(pty|ltd|limited|services|service|group|australia|aust|au|the|and|&)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const normXero = normalise(nameInXero);
    const normSupplier = normalise(supplierName);
    // Check if either name contains the other (handles abbreviations like PN vs Pacific National)
    const supplierNameMatch =
      normXero === normSupplier ||
      normXero.includes(normSupplier) ||
      normSupplier.includes(normXero) ||
      // Word-level overlap: >=50% of words in common
      (() => {
        const wordsXero = new Set(normXero.split(" ").filter(Boolean));
        const wordsSupplier = normSupplier.split(" ").filter(Boolean);
        if (wordsSupplier.length === 0) return false;
        const overlap = wordsSupplier.filter((w) => wordsXero.has(w)).length;
        return overlap / wordsSupplier.length >= 0.5;
      })();
    const bill: XeroBill = {
      invoiceId: inv.InvoiceID,
      invoiceNumber: inv.InvoiceNumber,
      reference: inv.Reference ?? "",
      contact: { contactId: inv.Contact?.ContactID, name: nameInXero },
      date: inv.DateString ?? inv.Date,
      dueDate: inv.DueDateString ?? inv.DueDate,
      subTotal: parseFloat(inv.SubTotal ?? "0"),
      totalTax: parseFloat(inv.TotalTax ?? "0"),
      total: parseFloat(inv.Total ?? "0"),
      status: inv.Status,
      currencyCode: inv.CurrencyCode ?? "AUD",
    };
    return { bill, supplierNameMatch, nameInXero };
  } catch (err: any) {
    console.error("[Xero] checkXeroBillDuplicate error:", err?.response?.data ?? err.message);
    throw err;
  }
}

export async function findXeroPurchaseOrderByNumber(
  poNumber: string,
  clientId: string,
  clientSecret: string
): Promise<XeroPurchaseOrder | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  try {
    // Xero supports direct lookup by PurchaseOrderNumber as a path segment
    const responseData = await runCachedXeroGet<any>(
      auth,
      `purchase-order:${poNumber.trim().toUpperCase()}`,
      XERO_CACHE_TTL.purchaseOrder,
      () => axios.get(
        `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            Accept: "application/json",
          },
        }
      ),
    );

    const poList = responseData?.PurchaseOrders ?? [];
    if (poList.length === 0) return null;

    const po = poList[0];
    const lineItems: XeroPOLineItem[] = (po.LineItems ?? []).map((li: any) => ({
      lineItemId: li.LineItemID ?? "",
      description: li.Description ?? "",
      quantity: parseFloat(li.Quantity ?? "0"),
      unitAmount: parseFloat(li.UnitAmount ?? "0"),
      lineAmount: parseFloat(li.LineAmount ?? "0"),
      taxAmount: parseFloat(li.TaxAmount ?? "0"),
      accountCode: li.AccountCode ?? "",
      itemCode: li.ItemCode ?? "",
      taxType: li.TaxType ?? undefined,
    }));
    return {
      purchaseOrderId: po.PurchaseOrderID,
      purchaseOrderNumber: po.PurchaseOrderNumber,
      reference: po.Reference ?? "",
      contact: { contactId: po.Contact?.ContactID, name: po.Contact?.Name },
      date: po.DateString ?? po.Date,
      deliveryDate: po.DeliveryDateString ?? po.DeliveryDate ?? "",
      subTotal: parseFloat(po.SubTotal ?? "0"),
      totalTax: parseFloat(po.TotalTax ?? "0"),
      total: parseFloat(po.Total ?? "0"),
      status: po.Status,
      currencyCode: po.CurrencyCode ?? "AUD",
      lineItems,
    };
  } catch (err: any) {
    if (!err?.response) throw err;
    // Only a genuine 404 means the requested PO number does not exist. Network,
    // authentication and rate-limit errors must not be converted to NOT_FOUND.
    if (err?.response?.status === 404) return null;
    const status = err?.response?.status;
    const responseData = err?.response?.data;
    const detail = responseData?.Message
      ?? responseData?.Detail
      ?? (typeof responseData === "string" ? responseData : "")
      ?? err?.message
      ?? "Unknown Xero API error";
    const errorLabel = status ? `HTTP ${status}` : "network error";
    const rateLimitDetail = status === 429 ? `; ${describeXeroRateLimit(err?.response?.headers)}` : "";
    console.error(`[Xero] Find PO failed for "${poNumber}" (${errorLabel}${rateLimitDetail}): ${detail || err?.message || "no response detail"}`);
    throw new Error(`Xero could not retrieve PO ${poNumber} (${errorLabel}${rateLimitDetail}). Please retry shortly.`);
  }
}

export async function createXeroDraftBill(
  data: {
    supplierXeroContactId?: string;
    supplierName: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate?: string;
    lineItems: Array<{
      description: string;
      quantity: number;
      unitAmount: number;
      accountCode?: string;
      taxType?: string;
    }>;
    reference?: string;
    currencyCode?: string;
    /** Xero invoice status. Defaults to DRAFT. Use AUTHORISED for AWAITING PAYMENT, SUBMITTED for AWAITING APPROVAL. */
    xeroStatus?: "DRAFT" | "SUBMITTED" | "AUTHORISED";
    forceCreateNew?: boolean;
  },
  clientId: string,
  clientSecret: string
): Promise<{ invoiceId: string; invoiceNumber: string } | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  const contact = data.supplierXeroContactId
    ? { ContactID: data.supplierXeroContactId }
    : { Name: data.supplierName };

  // When forceCreateNew is true, make InvoiceNumber unique to avoid Xero treating POST as UPDATE
  let xeroInvoiceNumber = data.invoiceNumber;
  if (data.forceCreateNew) {
    const abbr = data.supplierName
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map(w => w.charAt(0).toUpperCase())
      .join("");
    xeroInvoiceNumber = `${data.invoiceNumber}-${abbr}`;
    console.log(`[Xero] createXeroDraftBill: forceCreateNew — using unique InvoiceNumber "${xeroInvoiceNumber}" (original: "${data.invoiceNumber}")`);
  }

  const payload = {
    Type: "ACCPAY",
    Contact: contact,
    InvoiceNumber: xeroInvoiceNumber,
    Date: data.invoiceDate,
    DueDate: data.dueDate ?? data.invoiceDate,
    Status: data.xeroStatus ?? "DRAFT",
    Reference: data.forceCreateNew
      ? `${data.invoiceNumber} | ${data.reference ?? ""}`
      : (data.reference ?? ""),
    CurrencyCode: data.currencyCode ?? "AUD",
    LineAmountTypes: "Exclusive",
    LineItems: data.lineItems.map((li) => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unitAmount,
      // TaxType is mandatory for ACCPAY bills in Xero — always set it
      TaxType: li.taxType ?? "INPUT",
      // AccountCode is mandatory — use provided value or default to 310 (Purchases)
      AccountCode: li.accountCode ?? "310",
    })),
  };

  try {
    // Pre-flight: check if a bill with this invoice number already exists in Xero.
    // Skip when forceCreateNew is set (user acknowledged invoice number conflict with different supplier).
    if (!data.forceCreateNew) {
      const preFlight = await findExistingXeroBill(data.invoiceNumber, auth, data.supplierName);
      if (preFlight) {
        console.log(`[Xero] createXeroDraftBill: bill ${data.invoiceNumber} already exists in Xero for same supplier (Status=${preFlight.Status}, ID=${preFlight.InvoiceID}) — returning existing bill`);
        return { invoiceId: preFlight.InvoiceID, invoiceNumber: preFlight.InvoiceNumber };
      }
    } else {
      console.log(`[Xero] createXeroDraftBill: forceCreateNew=true for ${data.invoiceNumber} — skipping pre-flight duplicate check`);
    }

    const billRequest = { Invoices: [payload] };
    const response = await runXeroRequest(
      auth,
      "create bill",
      () => axios.post(
        `${XERO_API_BASE}/Invoices`,
        billRequest,
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": createXeroIdempotencyKey("bill", billRequest),
          },
        }
      ),
    );

    const created = response.data?.Invoices?.[0];
    if (!created) throw new Error("Xero returned no invoice in response");
    // Check for Xero-level validation errors even on HTTP 200
    if (created.HasErrors) {
      const errors = (created.ValidationErrors ?? []).map((e: any) => e.Message).join("; ");
      // "Invoice not of valid status for modification" means the bill already exists in a
      // non-editable state (SUBMITTED/AUTHORISED/PAID). Fetch and return the existing bill.
      if (errors.includes("not of valid status for modification")) {
        console.warn(`[Xero] createXeroDraftBill: bill ${data.invoiceNumber} already exists in non-editable state — fetching existing bill`);
        const existing = await findExistingXeroBill(data.invoiceNumber, auth, data.supplierName);
        if (existing) {
          console.log(`[Xero] createXeroDraftBill: returning existing bill ${existing.InvoiceNumber} (Status=${existing.Status})`);
          return { invoiceId: existing.InvoiceID, invoiceNumber: existing.InvoiceNumber };
        }
      }
      throw new Error(`Xero bill validation failed: ${errors}`);
    }
    await invalidateXeroCache(auth, `invoice-number:${data.invoiceNumber.trim().toUpperCase()}`);
    return { invoiceId: created.InvoiceID, invoiceNumber: created.InvoiceNumber };
  } catch (err: any) {
    const detail = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error("[Xero] Create draft bill error:", detail);
    throw new Error(`Xero bill creation failed: ${detail}`);
  }
}

export type XeroContactCandidate = {
  contactId: string;
  name: string;
  email: string | null;
  taxNumber: string | null;
};

export type XeroContactResolution =
  | {
      status: "matched";
      matchBasis: "saved_contact_id" | "name_and_email" | "name_only" | "email_only";
      contact: XeroContactCandidate;
      candidates: XeroContactCandidate[];
      message: string;
    }
  | {
      status: "needs_selection";
      reason: "multiple_name_matches" | "multiple_email_matches" | "name_email_mismatch" | "email_missing";
      candidates: XeroContactCandidate[];
      nameMatchCount: number;
      emailMatchCount: number;
      message: string;
    }
  | {
      status: "create_new";
      candidates: [];
      message: string;
    }
  | {
      status: "unavailable";
      candidates: [];
      message: string;
    };

const SUPPLIER_LEGAL_SUFFIXES = new Set(["pty", "ltd", "limited", "pl", "p", "inc", "llc", "co", "company"]);

function supplierNameTokens(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function getSupplierNameSearch(value: string): {
  searchTerm: string;
  exactNameKey: string | null;
  firstMeaningfulToken: string;
} {
  const tokens = supplierNameTokens(value);
  const businessTokens = tokens.filter((token) => !SUPPLIER_LEGAL_SUFFIXES.has(token));
  const firstMeaningfulToken = businessTokens.find((token) => token.length > 1) ?? "";
  const firstTokenIsOneLetter = (businessTokens[0] ?? "").length === 1;

  // A leading initial such as "A" in "A & F Transport" is not a meaningful
  // identifier. Searching it returns unrelated A-prefixed contacts, so require
  // a full canonical business-name match instead.
  if (firstTokenIsOneLetter) {
    const exactNameKey = businessTokens.join(" ");
    return {
      // Preserve punctuation and legal suffixes for Xero's own contact search,
      // while using the canonical key below to decide whether a result is valid.
      searchTerm: value.trim(),
      exactNameKey: exactNameKey || null,
      firstMeaningfulToken,
    };
  }

  return {
    searchTerm: firstMeaningfulToken,
    exactNameKey: null,
    firstMeaningfulToken,
  };
}

function normaliseSupplierNameToken(value: string): string {
  return getSupplierNameSearch(value).firstMeaningfulToken;
}

function normaliseSupplierNameKey(value: string): string {
  return supplierNameTokens(value)
    .filter((token) => !SUPPLIER_LEGAL_SUFFIXES.has(token))
    .join(" ");
}

function normaliseLiteralSupplierName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function matchesXeroSupplierName(contactName: string, search: ReturnType<typeof getSupplierNameSearch>): boolean {
  return search.exactNameKey
    ? normaliseSupplierNameKey(contactName) === search.exactNameKey
    : normaliseSupplierNameToken(contactName) === search.firstMeaningfulToken;
}

function normaliseEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function toContactCandidate(contact: any): XeroContactCandidate | null {
  if (!contact?.ContactID) return null;
  return {
    contactId: contact.ContactID,
    name: contact.Name ?? "Unnamed contact",
    email: contact.EmailAddress?.trim() || null,
    taxNumber: contact.TaxNumber?.trim() || null,
  };
}

function deduplicateCandidates(candidates: XeroContactCandidate[]): XeroContactCandidate[] {
  return Array.from(new Map(candidates.map((candidate) => [candidate.contactId, candidate])).values());
}

/**
 * Applies the supplier-contact safety rules independently of the Xero API call.
 * Name matching is based on the first meaningful name token; email matching is exact and case-insensitive.
 */
export function classifyXeroContactMatches(input: {
  supplierName: string;
  supplierEmail: string | null;
  nameMatches: XeroContactCandidate[];
  emailMatches: XeroContactCandidate[];
}): XeroContactResolution {
  const { supplierName, supplierEmail, nameMatches, emailMatches } = input;
  const candidates = deduplicateCandidates([...nameMatches, ...emailMatches]);
  const hasEmail = Boolean(normaliseEmail(supplierEmail));
  const nameAndEmailMatches = nameMatches.filter((nameCandidate) =>
    emailMatches.some((emailCandidate) => emailCandidate.contactId === nameCandidate.contactId)
  );

  // A first-name search may legitimately return several contacts (for example,
  // multiple "SCF ..." entities). A single exact email result within that list
  // is the required tie-breaker and is safe to use without manual selection.
  if (nameMatches.length > 1 && emailMatches.length === 1 && nameAndEmailMatches.length === 1) {
    return {
      status: "matched",
      matchBasis: "name_and_email",
      contact: nameAndEmailMatches[0],
      candidates,
      message: "Multiple first-name candidates were narrowed to one Xero contact by its exact email address.",
    };
  }

  if (nameMatches.length > 1) {
    return {
      status: "needs_selection",
      reason: "multiple_name_matches",
      candidates,
      nameMatchCount: nameMatches.length,
      emailMatchCount: emailMatches.length,
      message: `More than one Xero contact matches the first name token for "${supplierName}". Select and approve the correct contact.`,
    };
  }

  if (emailMatches.length > 1) {
    return {
      status: "needs_selection",
      reason: "multiple_email_matches",
      candidates,
      nameMatchCount: nameMatches.length,
      emailMatchCount: emailMatches.length,
      message: `More than one Xero contact uses the supplier email address. Select and approve the correct contact.`,
    };
  }

  const nameMatch = nameMatches[0];
  const emailMatch = emailMatches[0];

  if (nameMatch && hasEmail) {
    if (emailMatch && emailMatch.contactId === nameMatch.contactId) {
      return {
        status: "matched",
        matchBasis: "name_and_email",
        contact: nameMatch,
        candidates,
        message: "Supplier name and email address match the same Xero contact.",
      };
    }
    return {
      status: "needs_selection",
      reason: "name_email_mismatch",
      candidates,
      nameMatchCount: 1,
      emailMatchCount: emailMatches.length,
      message: emailMatch
        ? "The supplier name and email address match different Xero contacts. Select and approve the correct contact."
        : "The supplier name matches a Xero contact, but its email address does not match. Select and approve the correct contact.",
    };
  }

  if (nameMatch && !hasEmail) {
    return {
      status: "matched",
      matchBasis: "name_only",
      contact: nameMatch,
      candidates,
      message: "A single Xero contact matches the supplier name; no supplier email was available for a second validation.",
    };
  }

  if (emailMatch) {
    return {
      status: "matched",
      matchBasis: "email_only",
      contact: emailMatch,
      candidates,
      message: "No name match was found, but the supplier email address matches one Xero contact.",
    };
  }

  return {
    status: "create_new",
    candidates: [],
    message: "No Xero contact matches the supplier name or email address. A new contact can be created.",
  };
}

export async function resolveXeroSupplierContact(input: {
  supplierName: string;
  supplierEmail: string | null;
  savedContactId?: string | null;
  clientId: string;
  clientSecret: string;
}): Promise<XeroContactResolution> {
  const auth = await getValidAccessToken(input.clientId, input.clientSecret);
  if (!auth) {
    return { status: "unavailable", candidates: [], message: "Xero is not connected or its access token is unavailable." };
  }

  try {
    if (input.savedContactId) {
      // A saved Xero ContactID is the approved, immutable identifier from a
      // prior matching decision. Re-querying Contacts here adds unnecessary
      // Xero traffic and turns a valid supplier into an apparent non-match
      // when Xero is rate-limited.
      const saved: XeroContactCandidate = {
        contactId: input.savedContactId,
        name: input.supplierName,
        email: input.supplierEmail,
        taxNumber: null,
      };
      return {
        status: "matched",
        matchBasis: "saved_contact_id",
        contact: saved,
        candidates: [saved],
        message: "An approved Xero Contact ID is already saved for this supplier.",
      };
    }

    const nameSearch = getSupplierNameSearch(input.supplierName);
    const supplierEmail = normaliseEmail(input.supplierEmail);
    const headers = {
      Authorization: `Bearer ${auth.token}`,
      "Xero-tenant-id": auth.tenantId,
      Accept: "application/json",
    };

    const collectMatches = async (forceFresh = false) => {
      if (forceFresh) {
        // A contact may have just been manually created in Xero. Do not let the
        // six-hour local contact cache turn that into a duplicate creation.
        await invalidateXeroCache(auth, "contact-search:");
      }

      const nameSearchData = nameSearch.searchTerm
        ? await runCachedXeroGet<any>(
            auth,
            `contact-search:${nameSearch.searchTerm}`,
            XERO_CACHE_TTL.supplierSearch,
            () => axios.get(`${XERO_API_BASE}/Contacts`, { headers, params: { searchTerm: nameSearch.searchTerm } }),
          )
        : { Contacts: [] };
      const broadNameMatches = (nameSearchData?.Contacts ?? [])
        .map(toContactCandidate)
        .filter((contact: XeroContactCandidate | null): contact is XeroContactCandidate => Boolean(contact))
        .filter((contact: XeroContactCandidate) => matchesXeroSupplierName(contact.name, nameSearch));
      // A supplier name such as "CONTAINERZONE" may share its first token with
      // housekeeping contacts (for example, "Containerzone House Driver"). When
      // exactly one candidate has the same canonical full supplier name, it is a
      // stronger and safe match than the broader first-token candidate set.
      const literalSupplierName = normaliseLiteralSupplierName(input.supplierName);
      const exactLiteralNameMatches = literalSupplierName
        ? broadNameMatches.filter(
            (contact: XeroContactCandidate) => normaliseLiteralSupplierName(contact.name) === literalSupplierName
          )
        : [];
      const canonicalSupplierName = normaliseSupplierNameKey(input.supplierName);
      const exactCanonicalNameMatches = canonicalSupplierName
        ? broadNameMatches.filter(
            (contact: XeroContactCandidate) => normaliseSupplierNameKey(contact.name) === canonicalSupplierName
          )
        : [];
      const nameMatches = exactLiteralNameMatches.length === 1
        ? exactLiteralNameMatches
        : exactCanonicalNameMatches.length === 1
          ? exactCanonicalNameMatches
          : broadNameMatches;

      const emailSearchData = supplierEmail
        ? await runCachedXeroGet<any>(
            auth,
            `contact-search:${supplierEmail}`,
            XERO_CACHE_TTL.supplierSearch,
            () => axios.get(`${XERO_API_BASE}/Contacts`, { headers, params: { searchTerm: supplierEmail } }),
          )
        : { Contacts: [] };
      const emailMatches = (emailSearchData?.Contacts ?? [])
        .map(toContactCandidate)
        .filter((contact: XeroContactCandidate | null): contact is XeroContactCandidate => Boolean(contact))
        .filter((contact: XeroContactCandidate) => normaliseEmail(contact.email) === supplierEmail);

      return { nameMatches, emailMatches };
    };

    let matches = await collectMatches();
    let resolution = classifyXeroContactMatches({
      supplierName: input.supplierName,
      supplierEmail: input.supplierEmail,
      ...matches,
    });
    if (resolution.status === "create_new") {
      matches = await collectMatches(true);
      resolution = classifyXeroContactMatches({
        supplierName: input.supplierName,
        supplierEmail: input.supplierEmail,
        ...matches,
      });
    }
    return resolution;
  } catch (err: any) {
    const status = err?.response?.status;
    const responseData = err?.response?.data;
    const detail = responseData?.Message
      ?? responseData?.Detail
      ?? (typeof responseData === "string" ? responseData : "")
      ?? err?.message
      ?? "Unknown Xero API error";
    const errorLabel = status ? `HTTP ${status}` : "network error";
    console.error(`[Xero] Supplier contact resolution failed for "${input.supplierName}" (${errorLabel}): ${detail || err?.message || "no response detail"}`);
    return {
      status: "unavailable",
      candidates: [],
      message: detail.startsWith("Xero ")
        ? detail
        : `Xero contact search is unavailable (${errorLabel}). No contact was created.`,
    };
  }
}

export async function createXeroSupplierContact(input: {
  supplierName: string;
  supplierEmail: string | null;
  supplierAbn: string | null;
  clientId: string;
  clientSecret: string;
}): Promise<string | null> {
  const auth = await getValidAccessToken(input.clientId, input.clientSecret);
  if (!auth) return null;

  const payload = {
    Contacts: [{
      Name: input.supplierName,
      EmailAddress: input.supplierEmail ?? undefined,
      TaxNumber: input.supplierAbn ?? undefined,
    }],
  };
  const createResponse = await runXeroRequest(
    auth,
    "create supplier contact",
    () => axios.post(
      `${XERO_API_BASE}/Contacts`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": createXeroIdempotencyKey("contact", payload),
        },
      }
    ),
  );
  await invalidateXeroCache(auth, "contact-search:");

  return createResponse.data?.Contacts?.[0]?.ContactID ?? null;
}

/**
 * Legacy convenience helper retained for automated workflows.
 * It will never choose an ambiguous contact: manual resolution is required instead.
 */
export async function findOrCreateXeroContact(
  supplierName: string,
  supplierEmail: string | null,
  supplierAbn: string | null,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const resolution = await resolveXeroSupplierContact({
    supplierName,
    supplierEmail,
    clientId,
    clientSecret,
  });

  if (resolution.status === "matched") return resolution.contact.contactId;
  if (resolution.status === "create_new") {
    return createXeroSupplierContact({ supplierName, supplierEmail, supplierAbn, clientId, clientSecret });
  }
  if (resolution.status === "needs_selection") {
    throw new Error(`Xero contact needs approval: ${resolution.message}`);
  }
  return null;
}

/**
 * Mark a Xero Purchase Order as BILLED by updating its status.
 * Xero requires the PO to be in AUTHORISED status before it can be set to BILLED.
 * We use the PurchaseOrderNumber to look up the PO ID first, then update it.
 */
export async function markXeroPOAsBilled(
  poNumber: string,
  clientId: string,
  clientSecret: string
): Promise<boolean> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return false;

  try {
    const po = await findXeroPurchaseOrderByNumber(poNumber, clientId, clientSecret);
    if (!po) return false;
    const poId = po.purchaseOrderId;

    // Update the PO status to BILLED
    const payload = { PurchaseOrders: [{ PurchaseOrderID: poId, Status: "BILLED" }] };
    await runXeroRequest(
      auth,
      `mark PO ${poNumber} billed`,
      () => axios.post(
        `${XERO_API_BASE}/PurchaseOrders/${poId}`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": createXeroIdempotencyKey("po-billed", payload),
          },
        }
      ),
    );
    await invalidateXeroCache(auth, `purchase-order:${poNumber.trim().toUpperCase()}`);
    return true;
  } catch (err: any) {
    console.error(`[Xero] Mark PO ${poNumber} as BILLED error:`, err?.response?.data ?? err.message);
    return false;
  }
}

/**
 * Convert one or more Xero Purchase Orders into a single ACCPAY bill.
 * This uses the Xero API to create a bill that references the PO line items.
 * After creation, each PO should be marked as BILLED via markXeroPOAsBilled.
 */
export async function convertPOsToBill(
  data: {
    poNumbers: string[];
    supplierName: string;
    supplierXeroContactId?: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate?: string;
    currencyCode?: string;
    xeroStatus?: "DRAFT" | "SUBMITTED" | "AUTHORISED";
    forceCreateNew?: boolean;
  },
  clientId: string,
  clientSecret: string
): Promise<{ invoiceId: string; invoiceNumber: string } | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  // Fetch all POs and aggregate their line items
  const allLineItems: Array<{
    description: string;
    quantity: number;
    unitAmount: number;
    accountCode: string | null;
    taxType: string | null;
  }> = [];

  for (const poNumber of data.poNumbers) {
    try {
      const po = await findXeroPurchaseOrderByNumber(poNumber, clientId, clientSecret);
      if (!po) {
        console.warn(`[Xero] convertPOsToBill: PO ${poNumber} not found in Xero — skipping`);
        continue;
      }
      const poStatus = po.status;
      // Only pull line items from POs that are AUTHORISED or BILLED (approved stage)
      if (poStatus !== "AUTHORISED" && poStatus !== "BILLED") {
        console.warn(`[Xero] convertPOsToBill: PO ${poNumber} is in status ${poStatus} (not AUTHORISED/BILLED) — including anyway but approval should have moved it to AUTHORISED first`);
      }
      for (const li of po.lineItems ?? []) {
        allLineItems.push({
          description: li.description ?? `PO ${poNumber}`,
          quantity: li.quantity,
          unitAmount: li.unitAmount,
          // Inherit AccountCode and TaxType from the Xero PO — never hardcode
          accountCode: li.accountCode ?? null,
          taxType: li.taxType ?? null,
        });
      }
    } catch (error: any) {
      throw new Error(`Could not load PO ${poNumber} for bill conversion: ${error?.message ?? error}`);
    }
  }

  // If no line items found from POs, create a placeholder line
  if (allLineItems.length === 0) {
    allLineItems.push({
      description: `Invoice ${data.invoiceNumber} — POs: ${data.poNumbers.join(", ")}`,
      quantity: 1,
      unitAmount: 0,
      // Default to account 310 (Purchases) and INPUT (GST on Expenses) for placeholder lines
      accountCode: "310",
      taxType: "INPUT",
    });
  }

  const contact = data.supplierXeroContactId
    ? { ContactID: data.supplierXeroContactId }
    : { Name: data.supplierName };

  // When forceCreateNew is true, the same InvoiceNumber already exists in Xero under a different
  // supplier. Xero treats POST with an existing InvoiceNumber as an UPDATE (not a create).
  // Fix: append a short supplier abbreviation to make the number unique in Xero.
  // The original invoice number is preserved in the Reference field for traceability.
  let xeroInvoiceNumber = data.invoiceNumber;
  if (data.forceCreateNew) {
    const abbr = data.supplierName
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map(w => w.charAt(0).toUpperCase())
      .join("");
    xeroInvoiceNumber = `${data.invoiceNumber}-${abbr}`;
    console.log(`[Xero] convertPOsToBill: forceCreateNew — using unique InvoiceNumber "${xeroInvoiceNumber}" (original: "${data.invoiceNumber}")`);
  }

  const payload = {
    Type: "ACCPAY",
    Contact: contact,
    InvoiceNumber: xeroInvoiceNumber,
    Date: data.invoiceDate,
    DueDate: data.dueDate ?? data.invoiceDate,
    Status: data.xeroStatus ?? "AUTHORISED",
    Reference: data.forceCreateNew
      ? `${data.invoiceNumber} | POs: ${data.poNumbers.join(", ")}`
      : data.poNumbers.join(", "),
    CurrencyCode: data.currencyCode ?? "AUD",
    // LineAmountTypes must match what was set on the PO during approval (we set Exclusive)
    LineAmountTypes: "Exclusive",
    LineItems: allLineItems.map((li) => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unitAmount,
      // TaxType is mandatory for ACCPAY bills — always set it; inherit from PO or default to INPUT (GST on Expenses)
      TaxType: li.taxType ?? "INPUT",
      // AccountCode is mandatory — inherit from PO or default to 310 (Purchases)
      AccountCode: li.accountCode ?? "310",
    })),
  };

  try {
    // Pre-flight: check if a bill with this invoice number already exists in Xero.
    // Uses two strategies to handle Xero's inconsistent behaviour with numeric invoice numbers:
    //   1. GET with Type=ACCPAY filter (standard)
    //   2. GET without Type filter (fallback — Xero sometimes ignores Type for numeric numbers)
    // Supplier name is passed so we only match if BOTH invoice number AND supplier match —
    // prevents returning a different supplier's bill with the same invoice number.
    // Skip pre-flight check when forceCreateNew is set (user acknowledged invoice number conflict)
    if (!data.forceCreateNew) {
      const preFlight = await findExistingXeroBill(data.invoiceNumber, auth, data.supplierName);
      if (preFlight) {
        console.log(`[Xero] convertPOsToBill: bill ${data.invoiceNumber} already exists in Xero for same supplier (Status=${preFlight.Status}, ID=${preFlight.InvoiceID}) — returning existing bill`);
        return { invoiceId: preFlight.InvoiceID, invoiceNumber: preFlight.InvoiceNumber };
      }
    } else {
      console.log(`[Xero] convertPOsToBill: forceCreateNew=true for ${data.invoiceNumber} — skipping pre-flight duplicate check`);
    }

    const billRequest = { Invoices: [payload] };
    const response = await runXeroRequest(
      auth,
      "create bill from purchase orders",
      () => axios.post(
        `${XERO_API_BASE}/Invoices`,
        billRequest,
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": createXeroIdempotencyKey("po-bill", billRequest),
          },
        }
      ),
    );
    const created = response.data?.Invoices?.[0];
    if (!created) throw new Error("Xero returned no invoice in response");
    // Check for Xero-level validation errors even on HTTP 200
    if (created.HasErrors) {
      const errors = (created.ValidationErrors ?? []).map((e: any) => e.Message).join("; ");
      // "Invoice not of valid status for modification" means the bill already exists in a
      // non-editable state (SUBMITTED/AUTHORISED/PAID). Fetch and return the existing bill.
      if (errors.includes("not of valid status for modification")) {
        console.warn(`[Xero] convertPOsToBill: bill ${data.invoiceNumber} already exists in non-editable state — fetching existing bill`);
        const existing = await findExistingXeroBill(data.invoiceNumber, auth, data.supplierName);
        if (existing) {
          console.log(`[Xero] convertPOsToBill: returning existing bill ${existing.InvoiceNumber} (Status=${existing.Status})`);
          return { invoiceId: existing.InvoiceID, invoiceNumber: existing.InvoiceNumber };
        }
      }
      throw new Error(`Xero bill validation failed: ${errors}`);
    }
    await invalidateXeroCache(auth, `invoice-number:${data.invoiceNumber.trim().toUpperCase()}`);
    return { invoiceId: created.InvoiceID, invoiceNumber: created.InvoiceNumber };
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error("[Xero] Convert POs to bill error:", detail);
    throw new Error(`Xero bill creation failed: ${detail}`);
  }
}

/**
 * Update a Xero Purchase Order's details to match the invoice.
 *
 * Strategy (the ONLY correct approach for Xero):
 *   1. Fetch the existing PO to get its current status, LineAmountTypes, and existing LineItemIDs.
 *   2. Resolve the Contact.
 *   3. Build an update payload that:
 *      - ALWAYS sends LineAmountTypes="Exclusive" when line items are included
 *        (our DB stores GST-exclusive amounts; Xero title-cases this as "Exclusive")
 *      - NEVER sends AccountCode (we inherit it from the existing Xero line item)
 *      - Updates existing line items IN-PLACE by matching LineItemID from the existing PO
 *      - Sends GST-exclusive UnitAmount directly; Xero computes TaxAmount from TaxType
 *      - Only includes Status if we need to change it (DRAFT → AUTHORISED)
 *   4. Send one POST request with the combined payload.
 *
 * This approach avoids ALL the Xero validation errors:
 *   - "Exclusive is not a valid value" — fixed by using title-case "Exclusive"
 *   - "Account code '300' is not a valid code" — fixed by inheriting AccountCode from Xero
 *   - "PurchaseOrder status change is invalid" — fixed by not reverting to DRAFT
 *
 * Throws on any Xero API error so the caller can surface the message to the user.
 */
export async function updateXeroPODetails(
  poNumber: string,
  updates: {
    invoiceNumber?: string;
    supplierName?: string;
    supplierEmail?: string | null;
    supplierXeroContactId?: string;
    status?: "DRAFT" | "SUBMITTED" | "AUTHORISED";
    description?: string;
    /**
     * Line items from the invoice for this specific PO.
     * - unitAmount: the GST-EXCLUSIVE amount from the invoice line (what the extraction stores in `amount`)
     * - quantity: defaults to 1 if null
     * - description: the line item description
     * The function will match these to existing PO line items by position and
     * convert amounts to match the PO's LineAmountTypes automatically.
     */
    lineItems?: Array<{
      description: string;
      quantity: number;
      unitAmount: number; // GST-exclusive amount from invoice
    }>;
  },
  clientId: string,
  clientSecret: string
): Promise<{ poId: string; finalStatus: string }> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) throw new Error("Xero is not connected. Please reconnect Xero in Settings.");

  // ── Step 1: Fetch the existing PO (we MUST have it to inherit LineAmountTypes and AccountCodes) ──
  console.log(`[Xero] updateXeroPODetails: fetching PO "${poNumber}"`);
  const poResponseData = await runCachedXeroGet<any>(
    auth,
    `purchase-order:${poNumber.trim().toUpperCase()}`,
    XERO_CACHE_TTL.purchaseOrder,
    () => axios.get(
      `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          Accept: "application/json",
        },
      }
    ),
  );
  const poList = poResponseData?.PurchaseOrders ?? [];
  if (poList.length === 0) {
    throw new Error(`Purchase Order "${poNumber}" was not found in Xero.`);
  }
  const po = poList[0];
  const poId: string = po.PurchaseOrderID;
  const currentStatus: string = po.Status ?? "DRAFT";
  // Xero returns LineAmountTypes as "Exclusive", "Inclusive", or "NoTax" (title case).
  // Normalise to uppercase for safe comparison.
  const existingLineAmountTypesRaw: string = po.LineAmountTypes ?? "Exclusive";
  const existingLineAmountTypes: string = existingLineAmountTypesRaw.toUpperCase(); // "EXCLUSIVE" | "INCLUSIVE" | "NOTAX"
  const existingLineItems: any[] = po.LineItems ?? [];
  console.log(
    `[Xero] PO "${poNumber}" → ID=${poId}, status=${currentStatus}, ` +
    `lineAmountTypes=${existingLineAmountTypesRaw} (normalised: ${existingLineAmountTypes}), existingLineItems=${existingLineItems.length}`
  );

  // Guard: skip POs that are in a terminal state
  const TERMINAL_STATUSES = new Set(["BILLED", "DELETED", "VOIDED"]);
  if (TERMINAL_STATUSES.has(currentStatus)) {
    console.log(`[Xero] PO "${poNumber}" is ${currentStatus} — skipping update (terminal status)`);
    return { poId, finalStatus: currentStatus };
  }

  // ── Helper: POST to /PurchaseOrders with readable error extraction ───────────────
  async function xeroPost(payload: Record<string, any>, label: string): Promise<any> {
    try {
      const requestBody = { PurchaseOrders: [payload] };
      const resp = await runXeroRequest(
        auth,
        label,
        () => axios.post(
          `${XERO_API_BASE}/PurchaseOrders`,
          requestBody,
          {
            headers: {
              Authorization: `Bearer ${auth.token}`,
              "Xero-tenant-id": auth.tenantId,
              "Content-Type": "application/json",
              Accept: "application/json",
              "Idempotency-Key": createXeroIdempotencyKey("po-update", requestBody),
            },
          }
        ),
      );
      const result = resp.data?.PurchaseOrders?.[0];
      if (result?.HasErrors) {
        const valErrors: any[] = result?.ValidationErrors ?? [];
        const msgs = valErrors.map((e: any) => e.Message ?? JSON.stringify(e)).join("; ");
        const detail = msgs || JSON.stringify(result);
        console.error(`[Xero] ${label} returned HasErrors=true:`, detail);
        throw new Error(`PO ${poNumber}: ${detail}`);
      }
      console.log(`[Xero] ${label} → status: ${result?.Status}`);
      return result;
    } catch (err: any) {
      if ((err as Error).message.startsWith(`PO ${poNumber}:`)) throw err;
      const xeroData = err?.response?.data;
      if (xeroData) {
        const elements: any[] = xeroData.Elements ?? [];
        const valMsgs: string[] = [];
        for (const el of elements) {
          const errs: any[] = el.ValidationErrors ?? [];
          errs.forEach((e: any) => { if (e.Message) valMsgs.push(e.Message); });
        }
        const topMsg: string | undefined = xeroData.Message;
        if (valMsgs.length > 0) {
          const readable = valMsgs.join("; ");
          console.error(`[Xero] ${label} FAILED — ValidationErrors:`, readable);
          throw new Error(`PO ${poNumber}: ${readable}`);
        }
        if (topMsg) {
          console.error(`[Xero] ${label} FAILED — Message:`, topMsg);
          throw new Error(`PO ${poNumber}: ${topMsg}`);
        }
        const body = JSON.stringify(xeroData);
        console.error(`[Xero] ${label} FAILED — raw:`, body);
        throw new Error(`PO ${poNumber}: ${body}`);
      }
      console.error(`[Xero] ${label} FAILED:`, err.message);
      throw new Error(`PO ${poNumber}: ${err.message}`);
    }
  }

  // ── Step 2: Resolve the Contact ─────────────────────────────────────────────────
  let contactPayload: Record<string, string>;
  if (updates.supplierXeroContactId) {
    contactPayload = { ContactID: updates.supplierXeroContactId };
    console.log(`[Xero] Using provided ContactID: ${updates.supplierXeroContactId}`);
  } else if (updates.supplierName) {
    try {
      const resolution = await resolveXeroSupplierContact({
        supplierName: updates.supplierName,
        supplierEmail: updates.supplierEmail ?? null,
        clientId,
        clientSecret,
      });
      if (resolution.status === "matched") {
        contactPayload = { ContactID: resolution.contact.contactId };
        console.log(`[Xero] Safely resolved contact "${updates.supplierName}" → ContactID=${resolution.contact.contactId} (${resolution.matchBasis})`);
      } else if (resolution.status === "create_new") {
        const newContactId = await createXeroSupplierContact({
          supplierName: updates.supplierName,
          supplierEmail: updates.supplierEmail ?? null,
          supplierAbn: null,
          clientId,
          clientSecret,
        });
        if (!newContactId) throw new Error(`Failed to create Xero contact for "${updates.supplierName}"`);
        contactPayload = { ContactID: newContactId };
        console.log(`[Xero] Created contact "${updates.supplierName}" after no name or email match → ContactID=${newContactId}`);
      } else {
        throw new Error(`Contact approval required: ${resolution.message}`);
      }
    } catch (contactErr: any) {
      const errData = contactErr?.response?.data;
      const errMsg = errData?.Message || errData?.Detail || JSON.stringify(errData) || contactErr.message;
      console.error(`[Xero] Contact resolution failed for "${updates.supplierName}":`, errMsg);
      // Fall back to keeping the existing PO contact instead of failing entirely
      console.log(`[Xero] Falling back to existing PO contact: ContactID=${po.Contact?.ContactID}`);
      contactPayload = { ContactID: po.Contact?.ContactID };
    }
  } else {
    contactPayload = { ContactID: po.Contact?.ContactID };
    console.log(`[Xero] Keeping existing contact: ContactID=${po.Contact?.ContactID}`);
  }

  // ── Step 3: Build the update payload ────────────────────────────────────────────────
  const targetStatus = updates.status ?? "AUTHORISED";

  const payload: Record<string, any> = {
    PurchaseOrderID: poId,
    Contact: contactPayload,
    // NEVER include LineAmountTypes — we preserve whatever Xero already has
  };

  // Only change Status if needed (avoids "status change is invalid" errors)
  if (currentStatus !== targetStatus) {
    payload.Status = targetStatus;
    console.log(`[Xero] PO "${poNumber}" status ${currentStatus} → ${targetStatus}`);
  } else {
    console.log(`[Xero] PO "${poNumber}" already ${currentStatus} — updating fields in-place`);
  }

  if (updates.invoiceNumber) payload.Reference = updates.invoiceNumber;
  if (updates.description) payload.DeliveryInstructions = updates.description;

  // ── Step 3a: Update line items IN-PLACE using existing LineItemIDs ───────────
  //
  // KEY RULES:
  //   - We MUST send LineItemID to update an existing line item (not create a new one)
  //   - We MUST preserve AccountCode and TaxType from the existing Xero line item
  //   - We ALWAYS send LineAmountTypes="Exclusive" so Xero treats our amounts as GST-exclusive
  //     (our DB always stores GST-exclusive amounts per extraction prompt)
  //   - We send the GST-exclusive UnitAmount directly — Xero calculates GST from TaxType
  if (updates.lineItems && updates.lineItems.length > 0) {
    // Always tell Xero our amounts are exclusive of GST.
    // This is safe regardless of the PO's existing LineAmountTypes because we are
    // explicitly declaring the type of amounts we are sending.
    // Xero title-cases this value: "Exclusive" (NOT "EXCLUSIVE").
    payload.LineAmountTypes = "Exclusive";

    // Match invoice line items to existing PO line items by position.
    // If the PO has more line items than the invoice, we only update the ones we have data for.
    // If the invoice has more line items than the PO, extras are appended WITHOUT AccountCode.
    const updatedLineItems: any[] = [];

    for (let i = 0; i < updates.lineItems.length; i++) {
      const invoiceLi = updates.lineItems[i];
      const existingLi = existingLineItems[i]; // may be undefined if PO has fewer lines

      // Our DB stores GST-exclusive amounts — send as-is.
      // Xero will compute TaxAmount from the line's TaxType automatically.
      const unitAmountToSend = Math.round(invoiceLi.unitAmount * 100) / 100;

      const lineItem: Record<string, any> = {
        Description: invoiceLi.description,
        Quantity: invoiceLi.quantity,
        UnitAmount: unitAmountToSend,
      };

      if (existingLi?.LineItemID) {
        // Update in-place: include LineItemID so Xero updates this specific line
        lineItem.LineItemID = existingLi.LineItemID;
        // Preserve the existing AccountCode and TaxType — do NOT override
        if (existingLi.AccountCode) lineItem.AccountCode = existingLi.AccountCode;
        if (existingLi.TaxType) lineItem.TaxType = existingLi.TaxType;
        console.log(
          `[Xero] Line ${i + 1}: updating LineItemID=${existingLi.LineItemID} ` +
          `desc="${invoiceLi.description}" qty=${invoiceLi.quantity} unitExcl=${unitAmountToSend}`
        );
      } else {
        // New line item (PO has fewer lines than invoice).
        // Always set AccountCode and TaxType — Xero does not reliably apply account defaults
        // for programmatically-created lines. Business rule: transport invoices use
        // account 310 (Transport Vendors) and INPUT (GST on Expenses).
        lineItem.AccountCode = "310";
        lineItem.TaxType = "INPUT";
        console.log(
          `[Xero] Line ${i + 1}: appending new line ` +
          `desc="${invoiceLi.description}" qty=${invoiceLi.quantity} unitExcl=${unitAmountToSend} ` +
          `AccountCode=310 TaxType=INPUT (defaults for new transport lines)`
        );
      }

      updatedLineItems.push(lineItem);
    }

    payload.LineItems = updatedLineItems;
  } else {
    console.log(`[Xero] No line items provided — updating contact/reference only for PO "${poNumber}"`);
  }

  // ── Step 4: Send the update ──────────────────────────────────────────────────────────
  const afterUpdate = await xeroPost(payload, `Update "${poNumber}"`);
  await invalidateXeroCache(auth, `purchase-order:${poNumber.trim().toUpperCase()}`);
  return { poId, finalStatus: afterUpdate?.Status ?? targetStatus };
}

/**
 * Check if a Xero PO has been paid (i.e. its linked bill has been paid).
 * Returns payment info if found.
 */
export async function getXeroPOPaymentStatus(
  poNumber: string,
  clientId: string,
  clientSecret: string
): Promise<{ isPaid: boolean; paidAmount?: number; paidDate?: string } | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  try {
    const responseData = await runCachedXeroGet<any>(
      auth,
      `purchase-order:${poNumber.trim().toUpperCase()}`,
      XERO_CACHE_TTL.paymentStatus,
      () => axios.get(
        `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            Accept: "application/json",
          },
        }
      ),
    );
    const poList = responseData?.PurchaseOrders ?? [];
    if (poList.length === 0) return null;

    const po = poList[0];
    // A PO is considered paid if its AmountPaid > 0 or HasAttachments indicates payment
    const amountPaid = parseFloat(po.AmountPaid ?? "0");
    const isPaid = amountPaid > 0 || po.Status === "BILLED";
    return {
      isPaid,
      paidAmount: amountPaid > 0 ? amountPaid : undefined,
      paidDate: po.UpdatedDateUTC ? new Date(po.UpdatedDateUTC).toISOString().split("T")[0] : undefined,
    };
  } catch (err: any) {
    if (!err?.response) throw err;
    if (err?.response?.status === 404) return null;
    console.error(`[Xero] Get PO payment status error:`, err?.response?.data ?? err.message);
    return null;
  }
}

/**
 * Upload a file attachment to a Xero bill (ACCPAY invoice).
 * Xero Attachments API: PUT /Invoices/{InvoiceID}/Attachments/{FileName}
 * The file is fetched from a signed S3 URL and streamed to Xero.
 */
export async function uploadXeroBillAttachment(opts: {
  clientId: string;
  clientSecret: string;
  xeroInvoiceId: string;
  fileName: string;
  fileUrl: string; // publicly accessible URL (signed S3 URL)
  mimeType?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const auth = await getValidAccessToken(opts.clientId, opts.clientSecret);
    const { token, tenantId } = auth;

    // Download the file bytes from storage (follow redirects, presigned S3 URL)
    const fileResp = await axios.get(opts.fileUrl, {
      responseType: "arraybuffer",
      maxRedirects: 5,
    });
    const fileBuffer = Buffer.from(fileResp.data);
    const mimeType = opts.mimeType ?? "application/pdf";

    // Sanitise file name for Xero:
    // - Replace spaces, special chars, and + with underscore
    // - Keep only safe URL characters (letters, digits, hyphens, underscores, dots)
    const safeName = opts.fileName
      .replace(/[<>:"\\|?*\x00+ ]/g, "_") // replace unsafe chars and spaces
      .replace(/_+/g, "_");                  // collapse consecutive underscores

    // Use the GUID directly — do NOT encodeURIComponent (hyphens must stay as-is)
    // Encode only the filename portion for the URL path
    const uploadUrl = `${XERO_API_BASE}/Invoices/${opts.xeroInvoiceId}/Attachments/${encodeURIComponent(safeName)}`;

    const contentDigest = createHash("sha256").update(fileBuffer).digest("hex");
    await runXeroRequest(
      auth,
      "upload invoice attachment",
      () => axios.put(uploadUrl, fileBuffer, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Xero-tenant-id": tenantId,
          "Content-Type": mimeType,
          "Content-Length": String(fileBuffer.length),
          "Content-Disposition": `attachment; filename="${safeName}"`,
          Accept: "application/json",
          "Idempotency-Key": createXeroIdempotencyKey("attachment", {
            invoiceId: opts.xeroInvoiceId,
            safeName,
            contentDigest,
          }),
        },
        maxRedirects: 5,
      }),
    );

    console.log(`[Xero] Attachment uploaded to bill ${opts.xeroInvoiceId}: ${safeName}`);
    return { success: true };
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
    console.error(`[Xero] Attachment upload failed:`, detail);
    return { success: false, error: detail };
  }
}
