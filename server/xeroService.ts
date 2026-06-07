import axios from "axios";
import { getXeroToken, upsertXeroToken } from "./db";

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
    scope: "openid profile email accounting.invoices accounting.contacts accounting.payments accounting.settings offline_access",
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
async function findExistingXeroBill(
  invoiceNumber: string,
  auth: { token: string; tenantId: string }
): Promise<any | null> {
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    "Xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };
  // Strategy 1: with Type=ACCPAY
  try {
    const r1 = await axios.get(`${XERO_API_BASE}/Invoices`, {
      headers,
      params: { InvoiceNumbers: invoiceNumber, Type: "ACCPAY" },
    });
    const inv = r1.data?.Invoices?.[0];
    if (inv && inv.Status !== "VOIDED" && inv.Status !== "DELETED") return inv;
  } catch { /* fall through */ }
  // Strategy 2: without Type filter (handles numeric invoice numbers Xero sometimes misses)
  try {
    const r2 = await axios.get(`${XERO_API_BASE}/Invoices`, {
      headers,
      params: { InvoiceNumbers: invoiceNumber },
    });
    const inv = r2.data?.Invoices?.find((i: any) => i.Type === "ACCPAY" && i.Status !== "VOIDED" && i.Status !== "DELETED");
    if (inv) return inv;
  } catch { /* fall through */ }
  return null;
}

export async function findXeroBillByInvoiceNumber(
  invoiceNumber: string,
  clientId: string,
  clientSecret: string
): Promise<XeroBill | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  try {
    const response = await axios.get(`${XERO_API_BASE}/Invoices`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Xero-tenant-id": auth.tenantId,
        Accept: "application/json",
      },
      params: {
        InvoiceNumbers: invoiceNumber,
        Type: "ACCPAY",
      },
    });

    const invoicesList = response.data?.Invoices ?? [];
    if (invoicesList.length === 0) return null;

    const inv = invoicesList[0];
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
    return null;
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
    const response = await axios.get(`${XERO_API_BASE}/Invoices`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Xero-tenant-id": auth.tenantId,
        Accept: "application/json",
      },
      params: { InvoiceNumbers: invoiceNumber, Type: "ACCPAY" },
    });
    const invoicesList = response.data?.Invoices ?? [];
    if (invoicesList.length === 0) return null;
    const inv = invoicesList[0];
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
    return null;
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
    const response = await axios.get(
      `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          Accept: "application/json",
        },
      }
    );

    const poList = response.data?.PurchaseOrders ?? [];
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
    // 404 means no PO found with that number — not an error worth logging loudly
    if (err?.response?.status === 404) return null;
    console.error("[Xero] Find PO error:", err?.response?.data ?? err.message);
    return null;
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
  },
  clientId: string,
  clientSecret: string
): Promise<{ invoiceId: string; invoiceNumber: string } | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  const contact = data.supplierXeroContactId
    ? { ContactID: data.supplierXeroContactId }
    : { Name: data.supplierName };

  const payload = {
    Type: "ACCPAY",
    Contact: contact,
    InvoiceNumber: data.invoiceNumber,
    Date: data.invoiceDate,
    DueDate: data.dueDate ?? data.invoiceDate,
    Status: data.xeroStatus ?? "DRAFT",
    Reference: data.reference ?? "",
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
    // Uses findExistingXeroBill which tries both with and without Type=ACCPAY filter.
    const preFlight = await findExistingXeroBill(data.invoiceNumber, auth);
    if (preFlight) {
      console.log(`[Xero] createXeroDraftBill: bill ${data.invoiceNumber} already exists in Xero (Status=${preFlight.Status}, ID=${preFlight.InvoiceID}) — returning existing bill`);
      return { invoiceId: preFlight.InvoiceID, invoiceNumber: preFlight.InvoiceNumber };
    }

    const response = await axios.post(
      `${XERO_API_BASE}/Invoices`,
      { Invoices: [payload] },
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
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
        const existing = await findExistingXeroBill(data.invoiceNumber, auth);
        if (existing) {
          console.log(`[Xero] createXeroDraftBill: returning existing bill ${existing.InvoiceNumber} (Status=${existing.Status})`);
          return { invoiceId: existing.InvoiceID, invoiceNumber: existing.InvoiceNumber };
        }
      }
      throw new Error(`Xero bill validation failed: ${errors}`);
    }
    return { invoiceId: created.InvoiceID, invoiceNumber: created.InvoiceNumber };
  } catch (err: any) {
    const detail = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error("[Xero] Create draft bill error:", detail);
    throw new Error(`Xero bill creation failed: ${detail}`);
  }
}

export async function findOrCreateXeroContact(
  supplierName: string,
  supplierEmail: string | null,
  supplierAbn: string | null,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const auth = await getValidAccessToken(clientId, clientSecret);
  if (!auth) return null;

  try {
    // Search for existing contact
    const searchResponse = await axios.get(`${XERO_API_BASE}/Contacts`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Xero-tenant-id": auth.tenantId,
        Accept: "application/json",
      },
      params: { searchTerm: supplierName },
    });

    const contacts = searchResponse.data?.Contacts ?? [];
    if (contacts.length > 0) return contacts[0].ContactID;

    // Create new contact
    const createResponse = await axios.post(
      `${XERO_API_BASE}/Contacts`,
      {
        Contacts: [
          {
            Name: supplierName,
            EmailAddress: supplierEmail ?? undefined,
            TaxNumber: supplierAbn ?? undefined,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );

    return createResponse.data?.Contacts?.[0]?.ContactID ?? null;
  } catch (err: any) {
    console.error("[Xero] Contact find/create error:", err?.response?.data ?? err.message);
    return null;
  }
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
    // First look up the PO to get its ID
    const getResponse = await axios.get(
      `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          Accept: "application/json",
        },
      }
    );
    const poList = getResponse.data?.PurchaseOrders ?? [];
    if (poList.length === 0) return false;

    const po = poList[0];
    const poId = po.PurchaseOrderID;

    // Update the PO status to BILLED
    await axios.post(
      `${XERO_API_BASE}/PurchaseOrders/${poId}`,
      { PurchaseOrders: [{ PurchaseOrderID: poId, Status: "BILLED" }] },
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
    );
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
      const response = await axios.get(
        `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            Accept: "application/json",
          },
        }
      );
      const poList = response.data?.PurchaseOrders ?? [];
      if (poList.length === 0) {
        console.warn(`[Xero] convertPOsToBill: PO ${poNumber} not found in Xero — skipping`);
        continue;
      }
      const po = poList[0];
      const poStatus = po.Status as string;
      // Only pull line items from POs that are AUTHORISED or BILLED (approved stage)
      if (poStatus !== "AUTHORISED" && poStatus !== "BILLED") {
        console.warn(`[Xero] convertPOsToBill: PO ${poNumber} is in status ${poStatus} (not AUTHORISED/BILLED) — including anyway but approval should have moved it to AUTHORISED first`);
      }
      for (const li of po.LineItems ?? []) {
        allLineItems.push({
          description: li.Description ?? `PO ${poNumber}`,
          quantity: parseFloat(li.Quantity ?? "1"),
          unitAmount: parseFloat(li.UnitAmount ?? "0"),
          // Inherit AccountCode and TaxType from the Xero PO — never hardcode
          accountCode: li.AccountCode ?? null,
          taxType: li.TaxType ?? null,
        });
      }
    } catch {
      // Skip POs that can't be fetched
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

  const payload = {
    Type: "ACCPAY",
    Contact: contact,
    InvoiceNumber: data.invoiceNumber,
    Date: data.invoiceDate,
    DueDate: data.dueDate ?? data.invoiceDate,
    Status: data.xeroStatus ?? "AUTHORISED",
    Reference: data.poNumbers.join(", "),
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
    // If a non-voided/deleted bill is found, return it immediately to avoid
    // "Invoice not of valid status for modification" errors.
    const preFlight = await findExistingXeroBill(data.invoiceNumber, auth);
    if (preFlight) {
      console.log(`[Xero] convertPOsToBill: bill ${data.invoiceNumber} already exists in Xero (Status=${preFlight.Status}, ID=${preFlight.InvoiceID}) — returning existing bill`);
      return { invoiceId: preFlight.InvoiceID, invoiceNumber: preFlight.InvoiceNumber };
    }

    const response = await axios.post(
      `${XERO_API_BASE}/Invoices`,
      { Invoices: [payload] },
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }
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
        const existing = await findExistingXeroBill(data.invoiceNumber, auth);
        if (existing) {
          console.log(`[Xero] convertPOsToBill: returning existing bill ${existing.InvoiceNumber} (Status=${existing.Status})`);
          return { invoiceId: existing.InvoiceID, invoiceNumber: existing.InvoiceNumber };
        }
      }
      throw new Error(`Xero bill validation failed: ${errors}`);
    }
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
  const getResponse = await axios.get(
    `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
    {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Xero-tenant-id": auth.tenantId,
        Accept: "application/json",
      },
    }
  );
  const poList = getResponse.data?.PurchaseOrders ?? [];
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
      const resp = await axios.post(
        `${XERO_API_BASE}/PurchaseOrders`,
        { PurchaseOrders: [payload] },
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
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
    const contactSearch = await axios.get(`${XERO_API_BASE}/Contacts`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Xero-tenant-id": auth.tenantId,
        Accept: "application/json",
      },
      params: { searchTerm: updates.supplierName },
    });
    const contacts: any[] = contactSearch.data?.Contacts ?? [];
    if (contacts.length > 0) {
      contactPayload = { ContactID: contacts[0].ContactID };
      console.log(`[Xero] Resolved contact "${updates.supplierName}" → ContactID=${contacts[0].ContactID}`);
    } else {
      console.log(`[Xero] Contact "${updates.supplierName}" not found — creating it`);
      const createResp = await axios.post(
        `${XERO_API_BASE}/Contacts`,
        { Contacts: [{ Name: updates.supplierName }] },
        {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );
      const newContact = createResp.data?.Contacts?.[0];
      if (!newContact?.ContactID) throw new Error(`Failed to create Xero contact for "${updates.supplierName}"`);
      contactPayload = { ContactID: newContact.ContactID };
      console.log(`[Xero] Created contact "${updates.supplierName}" → ContactID=${newContact.ContactID}`);
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
    const response = await axios.get(
      `${XERO_API_BASE}/PurchaseOrders/${encodeURIComponent(poNumber)}`,
      {
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Xero-tenant-id": auth.tenantId,
          Accept: "application/json",
        },
      }
    );
    const poList = response.data?.PurchaseOrders ?? [];
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
    const { token, tenantId } = await getValidAccessToken(opts.clientId, opts.clientSecret);

    // Download the file bytes from storage (follow redirects, presigned S3 URL)
    const fileResp = await axios.get(opts.fileUrl, {
      responseType: "arraybuffer",
      maxRedirects: 5,
    });
    const fileBuffer = Buffer.from(fileResp.data);
    const mimeType = opts.mimeType ?? "application/pdf";

    // Sanitise file name for Xero:
    // - Replace spaces and special chars with underscore
    // - Brackets must NOT be encoded per Xero docs (other chars must be unencoded)
    const safeName = opts.fileName.replace(/[<>:"\\|?*\x00+]/g, "_");

    const uploadUrl = `${XERO_API_BASE}/Invoices/${encodeURIComponent(opts.xeroInvoiceId)}/Attachments/${safeName}`;

    await axios.put(uploadUrl, fileBuffer, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-tenant-id": tenantId,
        "Content-Type": mimeType,
        "Content-Length": String(fileBuffer.length),
        Accept: "application/json",
      },
      maxRedirects: 5,
    });

    console.log(`[Xero] Attachment uploaded to bill ${opts.xeroInvoiceId}: ${safeName}`);
    return { success: true };
  } catch (err: any) {
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
    console.error(`[Xero] Attachment upload failed:`, detail);
    return { success: false, error: detail };
  }
}
