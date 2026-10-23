import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  cached: vi.fn(),
  auth: vi.fn(),
  token: vi.fn(),
}));
vi.mock("axios", () => ({ default: { get: m.get, post: m.post, put: m.put } }));
vi.mock("./db", () => ({ getXeroToken: m.token }));
vi.mock("./xeroService", () => ({
  EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE",
  getXeroReadAuthWithRefresh: m.auth,
}));
vi.mock("./xeroRequestManager", () => ({
  XERO_CACHE_TTL: { invoiceSearch: 1 },
  runCachedXeroGet: m.cached,
  runCachedBoundedXeroGet: async (_auth: unknown, _cacheKey: string, _ttl: number, _operation: string, url: string, config: unknown) => (await m.get(url, config)).data,
}));
import { readExtraHireXeroEvidence } from "./financialExtraHireInvoiceXero";
import { readBackFinancialDraft } from "./financialReadOnlyXeroService";
import { buildExtraHireInvoice } from "./financialExtraHireInvoiceRules";
const defaults = () => ({
  org: { Organisations: [{ Name: "CONTAINERZONE" }] },
  history: { Invoices: [] },
  contact: {
    Contacts: [
      { ContactID: "contact-1", Name: "Synthetic", ContactStatus: "ACTIVE" },
    ],
  },
  item: {
    Items: [
      {
        Code: "20' Hire",
        IsSold: true,
        SalesDetails: { UnitPrice: 45, AccountCode: "210", TaxType: "OUTPUT" },
      },
    ],
  },
  account: {
    Accounts: [
      { Code: "210", Status: "ACTIVE", Type: "REVENUE", TaxType: "OUTPUT" },
    ],
  },
});
let data: any;
beforeEach(() => {
  vi.clearAllMocks();
  data = defaults();
  m.token.mockResolvedValue({});
  m.auth.mockResolvedValue({ token: "synthetic", tenantId: "tenant" });
  m.cached.mockImplementation(async (_a, _k, _ttl, fn) => (await fn()).data);
  m.get.mockImplementation(async (url: string, opts: any) => ({
    data: url.endsWith("/Organisation")
      ? data.org
      : url.includes("/Contacts")
        ? data.contact
        : url.includes("/Items/")
          ? data.item
          : url.includes("/Accounts")
            ? data.account
            : url.includes("/Invoices/")
              ? data.readback
              : opts.params?.InvoiceNumbers
                ? { Invoices: data.exact ?? [] }
                : data.history,
  }));
});
const noWrites = () => {
  expect(m.post).not.toHaveBeenCalled();
  expect(m.put).not.toHaveBeenCalled();
};
describe("Extra Hire GET-only fresh current Xero evidence", () => {
  it("gets all-status current Deal history, exact active contact and current hire sales rate/account", async () => {
    const e = await readExtraHireXeroEvidence(
      "D77",
      "Synthetic",
      20,
      "INV-77-EH1"
    );
    expect(e).toMatchObject({
      historyComplete: true,
      history: [],
      contactId: "contact-1",
      item: {
        itemCode: "20' Hire",
        unitAmount: 45,
        accountCode: "210",
        taxType: "OUTPUT",
      },
    });
    const historyCall = m.get.mock.calls.find(
      ([url, opts]) => url.endsWith("/Invoices") && opts.params?.where
    )!;
    expect(historyCall[1].params).toEqual({
      where: 'InvoiceNumber.StartsWith("INV-77")',
      Statuses: "DRAFT,SUBMITTED,AUTHORISED,PAID,DELETED,VOIDED",
      page: "1",
      pageSize: "100",
    });
    expect(m.cached.mock.calls.every(c => c[4].forceRefresh === true)).toBe(
      true
    );
    noWrites();
  });
  it.each(["DRAFT", "AUTHORISED", "PAID", "DELETED", "VOIDED"])(
    "exact-number %s collision is held including inactive history",
    async Status => {
      data.exact = [
        {
          InvoiceNumber: "INV-77-EH1",
          InvoiceID: "collision",
          Status,
          Type: "ACCREC",
        },
      ];
      await expect(
        readExtraHireXeroEvidence("D77", "Synthetic", 20, "INV-77-EH1")
      ).rejects.toThrow(/collision/);
      noWrites();
    }
  );
  it("history preserves deleted/voided evidence rather than filtering it", async () => {
    data.history.Invoices = [
      {
        InvoiceNumber: "INV-77-D",
        InvoiceID: "deleted",
        Status: "DELETED",
        Type: "ACCREC",
      },
      {
        InvoiceNumber: "INV-77-EH1",
        InvoiceID: "void",
        Status: "VOIDED",
        Type: "ACCREC",
      },
    ];
    expect(
      (await readExtraHireXeroEvidence("D77", "Synthetic", 20)).history.map(
        r => r.Status
      )
    ).toEqual(["DELETED", "VOIDED"]);
    noWrites();
  });
  it("bounded pagination never claims history completeness after truncation", async () => {
    data.history.Invoices = Array.from({ length: 100 }, (_, i) => ({
      InvoiceNumber: `INV-77-EH${i + 1}`,
      InvoiceID: `id-${i}`,
      Status: "DRAFT",
      Type: "ACCREC",
    }));
    await expect(
      readExtraHireXeroEvidence("D77", "Synthetic", 20)
    ).rejects.toThrow(/bounded history/);
    expect(
      m.get.mock.calls.filter(([url]) => url.endsWith("/Invoices"))
    ).toHaveLength(10);
    noWrites();
  });
  it.each(["missing", "archived", "duplicate"])(
    "holds %s customer",
    async kind => {
      if (kind === "missing") data.contact.Contacts = [];
      if (kind === "archived")
        data.contact.Contacts[0].ContactStatus = "ARCHIVED";
      if (kind === "duplicate")
        data.contact.Contacts.push({
          ...data.contact.Contacts[0],
          ContactID: "other",
        });
      await expect(
        readExtraHireXeroEvidence("D77", "Synthetic", 20)
      ).rejects.toThrow(/contact/);
      noWrites();
    }
  );
  it.each(["rate", "account", "tax", "duplicate", "inactive-account"])(
    "holds invalid exact sales %s evidence",
    async kind => {
      if (kind === "rate") delete data.item.Items[0].SalesDetails.UnitPrice;
      if (kind === "account")
        delete data.item.Items[0].SalesDetails.AccountCode;
      if (kind === "tax") data.item.Items[0].SalesDetails.TaxType = "NONE";
      if (kind === "duplicate") data.item.Items.push({ ...data.item.Items[0] });
      if (kind === "inactive-account")
        data.account.Accounts[0].Status = "ARCHIVED";
      await expect(
        readExtraHireXeroEvidence("D77", "Synthetic", 20)
      ).rejects.toThrow(/evidence|account/);
      noWrites();
    }
  );
});
const expected = () => {
  const d = buildExtraHireInvoice(
    {
      dealId: "5x77",
      dealNumber: "D77",
      containerNumber: "ABCU1234567",
      containerType: "20 Foot Standard",
      containerFeet: 20,
      hireDuration: 30,
      hireEndDate: "2026-01-31",
      customerVtigerId: "3x88",
      customerName: "Synthetic",
      customerKind: "organisation",
      sourceRefreshedAt: "2026-01-01",
      customerRefreshedAt: null,
      mappingEvidence: {},
      sourceHoldReason: null,
    },
    "INV-77-EH1",
    {
      itemCode: "20' Hire",
      unitAmount: 45,
      accountCode: "210",
      taxType: "OUTPUT",
    },
    "CURRENT_HIRE_END_DATE_NO_DUE_DATE"
  ).document!;
  d.partySourceId = "contact-1";
  return d;
};
const row = () => ({
  InvoiceID: "xero-1",
  InvoiceNumber: "INV-77-EH1",
  Type: "ACCREC",
  Status: "DRAFT",
  Contact: { ContactID: "contact-1", Name: "Synthetic" },
  Reference: "ABCU1234567",
  CurrencyCode: "AUD",
  LineAmountTypes: "Exclusive",
  DateString: "2026-01-31",
  SubTotal: 192.87,
  TotalTax: 19.29,
  Total: 212.16,
  LineItems: [
    {
      ItemCode: "20' Hire",
      Description: "20' Extra Hire — ABCU1234567",
      Quantity: 4.286,
      UnitAmount: 45,
      AccountCode: "210",
      TaxType: "OUTPUT",
      LineAmount: 192.87,
      TaxAmount: 19.29,
    },
  ],
});
const readback = () =>
  readBackFinancialDraft({
    documentFamily: "customer_invoice",
    documentNumber: "INV-77-EH1",
    expectedXeroDocumentId: "xero-1",
    expectedDocument: expected(),
  });
describe("Extra Hire exact Xero readback before success", () => {
  it("confirms immutable ID, exact DRAFT/AUD/contact/item/rate/account/tax/line totals/source date/reference", async () => {
    data.readback = { Invoices: [row()] };
    expect(await readback()).toMatchObject({
      xeroDocumentId: "xero-1",
      documentNumber: "INV-77-EH1",
      status: "DRAFT",
      subtotal: 192.87,
      total: 212.16,
      lineCount: 1,
    });
    noWrites();
  });
  it.each([
    { InvoiceID: "other" },
    { InvoiceNumber: "INV-77-EH2" },
    { Status: "AUTHORISED" },
    { Type: "ACCPAY" },
    { CurrencyCode: "USD" },
    { Contact: { ContactID: "wrong" } },
    { SubTotal: 200 },
    { TotalTax: 20 },
    { Total: 222 },
    { DateString: "2026-02-01" },
    { DueDateString: "2026-02-01" },
    { Reference: "wrong" },
    { LineAmountTypes: "Inclusive" },
    { LineItems: [] },
  ])("holds readback row mismatch %j", async patch => {
    data.readback = { Invoices: [{ ...row(), ...patch }] };
    await expect(readback()).rejects.toThrow(/read-back|does not match/);
    noWrites();
  });
  it.each([
    { ItemCode: "40' Hire" },
    { Description: "Wrong" },
    { Quantity: 30 },
    { UnitAmount: 70 },
    { AccountCode: "200" },
    { TaxType: "NONE" },
    { LineAmount: 100 },
    { TaxAmount: 0 },
  ])("holds readback line mismatch %j", async patch => {
    const r = row();
    r.LineItems[0] = { ...r.LineItems[0], ...patch };
    data.readback = { Invoices: [r] };
    await expect(readback()).rejects.toThrow(/does not match/);
    noWrites();
  });
});
