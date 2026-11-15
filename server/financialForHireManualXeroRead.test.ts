import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  runCached: vi.fn(), runCachedBounded: vi.fn(), token: vi.fn(), auth: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { get: mocks.get, post: mocks.post, put: mocks.put, patch: mocks.patch, delete: mocks.delete },
}));
vi.mock("./db", () => ({ getXeroToken: mocks.token }));
vi.mock("./xeroRequestManager", () => ({
  XERO_CACHE_TTL: { invoiceSearch: 1 },
  runCachedXeroGet: mocks.runCached,
  runCachedBoundedXeroGet: mocks.runCachedBounded,
}));
vi.mock("./xeroService", () => ({
  EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE",
  getXeroReadAuthWithRefresh: mocks.auth,
}));

import { readManualForHireHandoverXeroEvidence } from "./financialReadOnlyXeroService";

const base = "https://api.xero.com/api.xro/2.0";
const input = { manualPoNumber: "HC123-2", controlNumber: "C123", supplierName: "Hire Supplier" };
const po = (overrides: Record<string, any> = {}) => ({
  PurchaseOrderID: "manual-po-id", PurchaseOrderNumber: input.manualPoNumber,
  Reference: "C123", Status: "AUTHORISED", CurrencyCode: "AUD",
  Contact: { ContactID: "supplier-id", Name: "Hire Supplier" },
  DateString: "2026-11-01T00:00:00", LineAmountTypes: "Exclusive",
  LineItems: [{ Description: "Hire from 01/11/26 to 30/11/26", Quantity: 30, UnitAmount: 8, ItemCode: "HC 20 E", AccountCode: "312", LineAmount: 240, TaxAmount: 24, TaxType: "INPUT" }],
  SubTotal: 240, TotalTax: 24, Total: 264, ...overrides,
});
const contact = (overrides: Record<string, any> = {}) => ({
  ContactID: "supplier-id", Name: "Hire Supplier", ContactStatus: "ACTIVE", ...overrides,
});

/** Only these exact mocked endpoints are available; no real DB/Xero/VTiger imports execute. */
function fixtures(overrides: Record<string, any> = {}, wantedNumber = input.manualPoNumber) {
  const responses: Record<string, any> = {
    [`${base}/Organisation`]: { Organisations: [{ Name: "ContainerZone Test" }] },
    [`${base}/PurchaseOrders/${wantedNumber}`]: { PurchaseOrders: [po({ PurchaseOrderNumber: wantedNumber })] },
    [`${base}/PurchaseOrders/manual-po-id`]: { PurchaseOrders: [po({ PurchaseOrderNumber: wantedNumber })] },
    [`${base}/Contacts`]: { Contacts: [contact()] },
    [`${base}/Contacts/supplier-id`]: { Contacts: [contact()] },
    ...overrides,
  };
  mocks.get.mockImplementation(async (url: string) => {
    if (!Object.prototype.hasOwnProperty.call(responses, url)) throw new Error(`Unexpected mocked GET: ${url}`);
    const response = responses[url];
    if (response instanceof Error || response?.response?.status) throw response;
    return { data: response };
  });
}

function noAuthenticationOrReads() {
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.runCachedBounded).not.toHaveBeenCalled();
  expect(mocks.get).not.toHaveBeenCalled();
}

describe("manual For Hire handover Xero evidence (offline GET-only)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.token.mockResolvedValue({
      tenantId: "tenant-1", tenantName: "ContainerZone Test", accessToken: "secret", refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60 * 60_000), scope: "accounting.transactions.read accounting.contacts.read",
    });
    mocks.auth.mockResolvedValue({ token: "secret", tenantId: "tenant-1" });
    mocks.runCachedBounded.mockImplementation(async (
      _auth: unknown, _key: string, _ttl: number, _operation: string, url: string, config: object,
    ) => (await mocks.get(url, config)).data);
    fixtures();
  });

  afterEach(() => {
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.runCached).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(mocks.runCachedBounded.mock.calls.length);
    for (const call of mocks.runCachedBounded.mock.calls) {
      expect(call[3]).toMatch(/^GET financial-read:/);
      expect(call[5]).not.toHaveProperty("method");
      expect(call[5]).not.toHaveProperty("data");
      expect(call[6]).toEqual({ forceRefresh: true });
    }
  });

  it.each(["", "123", "c123", "HC123", "C12x", " C123", "C123 ", "C123\n", 'C123\" OR true', "C123/other"])(
    "rejects noncanonical control %j before authentication", async (controlNumber) => {
      await expect(readManualForHireHandoverXeroEvidence({ ...input, controlNumber })).rejects.toThrow(/C-digits/);
      noAuthenticationOrReads();
    },
  );

  it.each(["", "HC124", "H123", "hc123-2", "HC123-", "HC123-0", "HC123-02", "HC123--2", "HC123-2.0", "HC123-X", "HC123-2/other", " HC123-2", "HC123-2 ", "HC123-2\n", 'HC123-2\" OR true'])(
    "rejects noncanonical or wrong-control manual number %j before authentication", async (manualPoNumber) => {
      await expect(readManualForHireHandoverXeroEvidence({ ...input, manualPoNumber })).rejects.toThrow(/canonical/);
      noAuthenticationOrReads();
    },
  );

  it.each([null, undefined, {}, { ...input, controlNumber: 123 }, { ...input, manualPoNumber: 123 }, { ...input, supplierName: " " }, { ...input, supplierName: null }])(
    "rejects malformed runtime input before authentication: %j", async (invalid) => {
      await expect(readManualForHireHandoverXeroEvidence(invalid as any)).rejects.toThrow();
      noAuthenticationOrReads();
    },
  );

  it.each(["HC123", "HC123-1", "HC123-2", "HC123-25"])("accepts canonical %s but holds completeness", async (manualPoNumber) => {
    fixtures({}, manualPoNumber);
    const evidence = await readManualForHireHandoverXeroEvidence({ ...input, manualPoNumber });
    expect(evidence).toMatchObject({ manualPo: { PurchaseOrderNumber: manualPoNumber }, supplierContactId: "supplier-id", tenantId: "tenant-1", complete: false });
  });

  it("checks the tenant first, then exact number, immutable ID full record and current active supplier", async () => {
    const rawPo = po({ AdditionalManualField: { retained: true } });
    fixtures({ [`${base}/PurchaseOrders/manual-po-id`]: { PurchaseOrders: [rawPo] } });
    const result = await readManualForHireHandoverXeroEvidence(input);
    expect(result).toEqual({ manualPo: rawPo, relatedPurchaseOrders: [], supplierContactId: "supplier-id", tenantId: "tenant-1", complete: false });
    expect(result.manualPo).toBe(rawPo);
    expect(mocks.get.mock.calls.map(([url]) => url)).toEqual([
      `${base}/Organisation`, `${base}/PurchaseOrders/HC123-2`, `${base}/PurchaseOrders/manual-po-id`,
      `${base}/Contacts`, `${base}/Contacts/supplier-id`,
    ]);
    expect(mocks.runCachedBounded).toHaveBeenCalledWith(
      { token: "secret", tenantId: "tenant-1", tenantName: "ContainerZone Test" },
      "financial-read:manual-for-hire-number:HC123-2", 1, "GET financial-read:manual-for-hire-number:HC123-2",
      `${base}/PurchaseOrders/HC123-2`,
      { headers: { Authorization: "Bearer secret", "Xero-tenant-id": "tenant-1", Accept: "application/json" }, params: undefined },
      { forceRefresh: true },
    );
    expect(mocks.get.mock.calls[3]?.[1]).toMatchObject({ params: { searchTerm: "Hire Supplier" } });
  });

  it("holds missing authentication without accounting reads", async () => {
    mocks.token.mockResolvedValue(null);
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/not connected/);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("holds tenant mismatch before PO or contact reads", async () => {
    fixtures({ [`${base}/Organisation`]: { Organisations: [{ Name: "Other Organisation" }] } });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/expected AP tenant/);
    expect(mocks.get.mock.calls.map(([url]) => url)).toEqual([`${base}/Organisation`]);
  });

  it("holds missing tenant ID before PO reads", async () => {
    mocks.auth.mockResolvedValue({ token: "secret", tenantId: "" });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/tenant ID/);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { PurchaseOrders: [] }, { PurchaseOrders: "bad" },
    { PurchaseOrders: [po({ PurchaseOrderNumber: "HC124-2" })] },
    { PurchaseOrders: [po({ PurchaseOrderNumber: "hc123-2" })] },
    { PurchaseOrders: [po({ PurchaseOrderNumber: "HC123-2 " })] },
    { PurchaseOrders: [po({ PurchaseOrderID: null })] },
    { PurchaseOrders: [po({ PurchaseOrderID: " " })] },
    { PurchaseOrders: [po({ PurchaseOrderID: 123 })] },
    { PurchaseOrders: [po({ PurchaseOrderID: " manual-po-id" })] },
    { PurchaseOrders: [po(), po()] },
    { PurchaseOrders: [po(), po({ PurchaseOrderID: "different-id", Status: "DELETED" })] },
    { PurchaseOrders: [po(), po({ PurchaseOrderNumber: "HC999" })] },
  ])("holds number response ambiguity/mismatch/missing ID: %j", async (response) => {
    fixtures({ [`${base}/PurchaseOrders/HC123-2`]: response });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/exact-number GET/);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    {}, { PurchaseOrders: [] }, { PurchaseOrders: [po(), po()] },
    { PurchaseOrders: [po({ PurchaseOrderID: "wrong-id" })] },
    { PurchaseOrders: [po({ PurchaseOrderNumber: "HC123-3" })] },
    { PurchaseOrders: [po({ PurchaseOrderNumber: "hc123-2" })] },
    { PurchaseOrders: [po({ LineItems: undefined })] },
    { PurchaseOrders: [po({ LineItems: [null] })] },
    { PurchaseOrders: [po({ LineItems: ["partial"] })] },
    { PurchaseOrders: [po({ Status: "" })] },
  ])("holds ID/number/full-record mismatch: %j", async (response) => {
    fixtures({ [`${base}/PurchaseOrders/manual-po-id`]: response });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/ID read/);
    expect(mocks.get).toHaveBeenCalledTimes(3);
  });

  it.each(["DRAFT", "SUBMITTED", "AUTHORISED", "BILLED", "DELETED", "VOIDED"])(
    "retains status %s as evidence rather than treating its number as absent", async (Status) => {
      fixtures({
        [`${base}/PurchaseOrders/HC123-2`]: { PurchaseOrders: [po({ Status })] },
        [`${base}/PurchaseOrders/manual-po-id`]: { PurchaseOrders: [po({ Status })] },
      });
      const result = await readManualForHireHandoverXeroEvidence(input);
      expect(result.manualPo.Status).toBe(Status);
      expect(result.complete).toBe(false);
    },
  );

  it.each([
    [], [contact({ Name: "Hire Supplier Holdings" })], [contact({ ContactID: null })],
    [contact(), contact({ ContactID: "other-id" })], [contact(), contact()],
  ])("holds missing/ambiguous exact supplier name lookup: %j", async (Contacts) => {
    fixtures({ [`${base}/Contacts`]: { Contacts } });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/one exact current Xero contact/);
    expect(mocks.get).toHaveBeenCalledTimes(4);
  });

  it.each([
    {}, { Contacts: [] }, { Contacts: [contact({ ContactStatus: "ARCHIVED" })] },
    { Contacts: [contact({ ContactStatus: undefined })] }, { Contacts: [contact({ ContactID: "other-id" })] },
    { Contacts: [contact({ Name: "Changed Supplier" })] },
  ])("requires active ID read and exact current name: %j", async (response) => {
    fixtures({ [`${base}/Contacts/supplier-id`]: response });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/exact active current Xero contact/);
  });

  it.each([
    { ContactID: "wrong-id", Name: "Hire Supplier" }, { ContactID: "supplier-id", Name: "Wrong Supplier" },
    { ContactID: "supplier-id" }, undefined,
  ])("holds PO contact name/ID mismatch even if lookup is active: %j", async (Contact) => {
    fixtures({ [`${base}/PurchaseOrders/manual-po-id`]: { PurchaseOrders: [po({ Contact })] } });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/PO supplier name\/ID/);
  });

  it("reuses existing exact-name normalization without substituting a substring supplier", async () => {
    fixtures({
      [`${base}/Contacts`]: { Contacts: [contact({ Name: "HIRE   SUPPLIER" }), contact({ Name: "Hire Supplier Holdings", ContactID: "different" })] },
      [`${base}/Contacts/supplier-id`]: { Contacts: [contact({ Name: "hire supplier" })] },
    });
    await expect(readManualForHireHandoverXeroEvidence({ ...input, supplierName: " Hire  Supplier " })).resolves.toMatchObject({ supplierContactId: "supplier-id", complete: false });
  });

  it.each([400, 401, 403, 404, 429, 500])("does not treat HTTP %s as successful/complete evidence", async (status) => {
    fixtures({ [`${base}/PurchaseOrders/HC123-2`]: { response: { status } } });
    await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toMatchObject({ response: { status } });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it.each([`${base}/Organisation`, `${base}/PurchaseOrders/manual-po-id`, `${base}/Contacts`, `${base}/Contacts/supplier-id`])(
    "propagates read failure at %s instead of asserting completeness", async (url) => {
      fixtures({ [url]: new Error("Mocked read unavailable") });
      await expect(readManualForHireHandoverXeroEvidence(input)).rejects.toThrow(/Mocked read unavailable/);
    },
  );

  it.each([
    { PurchaseOrders: [] },
    { PurchaseOrders: [], pagination: { page: 1, pageSize: 25, pageCount: 1, itemCount: 0 } },
    { PurchaseOrders: Array.from({ length: 25 }, (_, i) => po({ PurchaseOrderNumber: `HC123-${i + 3}`, PurchaseOrderID: `related-${i}` })), pagination: { page: 1, pageSize: 25, pageCount: 3, itemCount: 75 } },
    { response: { status: 404 } },
  ])("does not issue unsupported scoped/list/page queries even for empty/full/truncated/404 list fixtures", async (listResponse) => {
    fixtures({ [`${base}/PurchaseOrders`]: listResponse });
    const evidence = await readManualForHireHandoverXeroEvidence(input);
    expect(evidence.complete).toBe(false);
    expect(evidence.relatedPurchaseOrders).toEqual([]); // Unknown; caller MUST hold.
    expect(mocks.get.mock.calls.some(([url]) => url === `${base}/PurchaseOrders`)).toBe(false);
    expect(mocks.get.mock.calls.some(([, config]) => config?.params?.page || config?.params?.where || config?.params?.Status || config?.params?.DateFrom)).toBe(false);
    expect(mocks.get.mock.calls.filter(([url]) => String(url).includes("/PurchaseOrders/"))).toHaveLength(2);
    expect(mocks.get).toHaveBeenCalledTimes(5);
  });
});
