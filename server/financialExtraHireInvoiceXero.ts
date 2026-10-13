import axios from "axios";
import {
  getXeroReadAuthWithRefresh,
  EXPECTED_AP_XERO_TENANT_LABEL,
} from "./xeroService";
import { runCachedXeroGet, XERO_CACHE_TTL } from "./xeroRequestManager";
import type {
  ExtraHireHistoryRow,
  ExtraHireItemEvidence,
} from "./financialExtraHireInvoiceRules";
const BASE = "https://api.xero.com/api.xro/2.0";
const ALL_INVOICE_STATUSES = "DRAFT,SUBMITTED,AUTHORISED,PAID,DELETED,VOIDED";
export type ExtraHireXeroEvidence = {
  history: ExtraHireHistoryRow[];
  historyComplete: true;
  exactCandidateMatches: ExtraHireHistoryRow[];
  contactId: string | null;
  contactName: string | null;
  item: ExtraHireItemEvidence;
};
/** Explicit ALL-status evidence, including DELETED/VOIDED, never active-only. Never truncates silently. */
export async function readExtraHireXeroEvidence(
  dealNumber: string,
  customerName: string,
  feet: 20 | 40,
  candidateNumber?: string,
  options: { contactOverride?: { contactId: string; contactName: string } | null; skipContactLookup?: boolean } = {}
): Promise<ExtraHireXeroEvidence> {
  if (
    !/^D\d{1,12}$/.test(dealNumber) ||
    !customerName.trim() ||
    ![20, 40].includes(feet)
  )
    throw new Error(
      "Exact Extra Hire Deal/customer/size required for Xero GET evidence."
    );
  const auth = await getXeroReadAuthWithRefresh();
  const get = (path: string, params?: Record<string, string>) =>
    runCachedXeroGet<any>(
      auth,
      `extra-hire:${path}:${JSON.stringify(params)}`,
      XERO_CACHE_TTL.invoiceSearch,
      () =>
        axios.get(`${BASE}${path}`, {
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Xero-tenant-id": auth.tenantId,
            Accept: "application/json",
          },
          params,
          timeout: 20_000,
        }),
      { forceRefresh: true }
    );
  const org = await get("/Organisation");
  if (
    !String(org?.Organisations?.[0]?.Name ?? "")
      .toUpperCase()
      .includes(EXPECTED_AP_XERO_TENANT_LABEL)
  )
    throw new Error("Extra Hire Xero tenant mismatch.");
  const prefix = `INV-${dealNumber.slice(1)}`;
  const history: ExtraHireHistoryRow[] = [];
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const response = await get("/Invoices", {
      where: `InvoiceNumber.StartsWith("${prefix}")`,
      Statuses: ALL_INVOICE_STATUSES,
      page: String(page),
      pageSize: "100",
    });
    if (!Array.isArray(response?.Invoices))
      throw new Error(
        "Xero Extra Hire history response is incomplete/invalid."
      );
    for (const row of response.Invoices) {
      const number = String(row.InvoiceNumber ?? "").trim();
      if (number !== prefix && !number.startsWith(`${prefix}-`)) continue;
      if (!row.InvoiceID || !row.Status || !row.Type)
        throw new Error(
          "Xero exact history row lacks immutable identity/status/type."
        );
      history.push({
        InvoiceNumber: number,
        InvoiceID: String(row.InvoiceID),
        Status: String(row.Status),
        Type: String(row.Type),
      });
    }
    if (response.Invoices.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete)
    throw new Error(
      "Extra Hire bounded history reached its limit; hold rather than infer a free suffix."
    );
  let contactId: string | null = options.contactOverride?.contactId ?? null;
  let contactName: string | null = options.contactOverride?.contactName ?? null;
  if (!contactId && !options.skipContactLookup) {
    const contacts = await get("/Contacts", { searchTerm: customerName.trim(), includeArchived: "true" });
    if (!Array.isArray(contacts?.Contacts) || contacts.Contacts.length >= 100) throw new Error("Extra Hire contact evidence may be incomplete.");
    const exactContacts = contacts.Contacts.filter((c: any) => String(c.Name ?? "").trim() === customerName.trim());
    if (exactContacts.length !== 1 || !exactContacts[0].ContactID || exactContacts[0].ContactStatus !== "ACTIVE") throw new Error("Xero exact Extra Hire customer contact missing/archived/ambiguous.");
    contactId = String(exactContacts[0].ContactID);
    contactName = String(exactContacts[0].Name);
  }
  const code = `${feet}' Hire` as "20' Hire" | "40' Hire";
  const items = await get(`/Items/${encodeURIComponent(code)}`);
  const exactItems = (Array.isArray(items?.Items) ? items.Items : []).filter(
    (i: any) => i.Code === code
  );
  const item = exactItems.length === 1 ? exactItems[0] : null;
  const rate = item?.SalesDetails?.UnitPrice;
  const accountCode = String(item?.SalesDetails?.AccountCode ?? "").trim();
  if (
    !item ||
    item.IsSold !== true ||
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !accountCode ||
    item.SalesDetails.TaxType !== "OUTPUT"
  )
    throw new Error(
      "Exact hire item sales rate/account/10% OUTPUT GST evidence missing or ambiguous; legacy 45/70 and 210 are not blindly copied."
    );
  const accounts = await get("/Accounts");
  const exactAccounts = (
    Array.isArray(accounts?.Accounts) ? accounts.Accounts : []
  ).filter((a: any) => String(a.Code) === accountCode);
  if (
    exactAccounts.length !== 1 ||
    exactAccounts[0].Status !== "ACTIVE" ||
    !["REVENUE", "SALES"].includes(exactAccounts[0].Type) ||
    exactAccounts[0].TaxType !== "OUTPUT"
  )
    throw new Error(
      "Current hire sales account is inactive/ambiguous or not OUTPUT revenue."
    );
  let exactCandidateMatches: ExtraHireHistoryRow[] = [];
  if (candidateNumber) {
    if (!new RegExp(`^${prefix}-EH[1-9]\\d*$`).test(candidateNumber))
      throw new Error(
        "Extra Hire exact candidate must belong to the approved series."
      );
    const response = await get("/Invoices", {
      InvoiceNumbers: candidateNumber,
      Statuses: ALL_INVOICE_STATUSES,
    });
    if (!Array.isArray(response?.Invoices))
      throw new Error("Xero exact candidate collision GET is invalid.");
    exactCandidateMatches = response.Invoices.filter(
      (r: any) =>
        String(r.InvoiceNumber ?? "")
          .trim()
          .toUpperCase() === candidateNumber
    ).map((r: any) => ({
      InvoiceNumber: r.InvoiceNumber,
      InvoiceID: r.InvoiceID,
      Status: r.Status,
      Type: r.Type,
    }));
    if (exactCandidateMatches.length)
      throw new Error(
        "Exact Extra Hire suffix collision including deleted/voided history; no adoption or bypass."
      );
  }
  return {
    history,
    historyComplete: true,
    exactCandidateMatches,
    contactId,
    contactName,
    item: { itemCode: code, unitAmount: rate, accountCode, taxType: "OUTPUT" },
  };
}
