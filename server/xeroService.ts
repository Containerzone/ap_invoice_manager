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
    scope: "openid profile email accounting.transactions accounting.contacts offline_access",
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

async function getValidAccessToken(clientId: string, clientSecret: string): Promise<{ token: string; tenantId: string } | null> {
  const stored = await getXeroToken();
  if (!stored) return null;

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
  } catch (err) {
    console.error("[Xero] Token refresh failed:", err);
    return null;
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
    Status: "DRAFT",
    Reference: data.reference ?? "",
    CurrencyCode: data.currencyCode ?? "AUD",
    LineAmountTypes: "EXCLUSIVE",
    LineItems: data.lineItems.map((li) => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unitAmount,
      AccountCode: li.accountCode ?? "200",
      TaxType: li.taxType ?? "INPUT2",
    })),
  };

  try {
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
    if (!created) return null;
    return { invoiceId: created.InvoiceID, invoiceNumber: created.InvoiceNumber };
  } catch (err: any) {
    console.error("[Xero] Create draft bill error:", err?.response?.data ?? err.message);
    return null;
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
