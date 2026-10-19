import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost, mockPut, mockPatch, mockDelete, mockRunCached } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockPatch: vi.fn(),
  mockDelete: vi.fn(),
  mockRunCached: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { get: mockGet, post: mockPost, put: mockPut, patch: mockPatch, delete: mockDelete },
}));
vi.mock("./db", () => ({ getXeroToken: vi.fn() }));
vi.mock("./xeroRequestManager", () => ({
  XERO_CACHE_TTL: { invoiceSearch: 1 },
  runCachedXeroGet: mockRunCached,
}));
vi.mock("./xeroService", () => ({
  EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE",
  getXeroReadAuthWithRefresh: vi.fn(),
}));

import { getXeroToken } from "./db";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import {
  preflightFinancialXeroIntents,
  previewHistoricalXeroReferences,
  readBackFinancialDraft,
  readDepositInvoiceXeroItemConfiguration,
  testFinancialXeroConnection,
} from "./financialReadOnlyXeroService";

function noMutationAssertions() {
  expect(mockPost).not.toHaveBeenCalled();
  expect(mockPut).not.toHaveBeenCalled();
  expect(mockPatch).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
}

describe("financial read-only Xero service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getXeroToken).mockResolvedValue({
      tenantId: "tenant-1", tenantName: "ContainerZone Test", accessToken: "secret", refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60 * 60_000), scope: "accounting.invoices accounting.contacts",
    } as any);
    vi.mocked(getXeroReadAuthWithRefresh).mockResolvedValue({ token: "secret", tenantId: "tenant-1" });
    mockRunCached.mockImplementation(async (_auth: unknown, _key: string, _ttl: number, operation: () => Promise<any>) => (await operation()).data);
  });

  it("tests Xero connection using GET-only accounting requests and never mutates financial data", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: [{ tenantName: "ContainerZone Test" }] });
    const result = await testFinancialXeroConnection();
    expect(result).toMatchObject({ outcome: "passed", readOnlyGuard: true, organisationName: "ContainerZone Test" });
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(mockGet).toHaveBeenCalledTimes(2);
    noMutationAssertions();
  });

  it("refreshes only OAuth authentication before the accounting GET checks when the Xero access token has expired", async () => {
    const refreshedExpiry = new Date(Date.now() + 60 * 60_000);
    vi.mocked(getXeroToken)
      .mockResolvedValueOnce({ tenantId: "tenant-1", tenantName: "ContainerZone Test", accessToken: "expired", refreshToken: "refresh", expiresAt: new Date(Date.now() - 1_000), scope: "accounting.invoices accounting.contacts" } as any)
      .mockResolvedValueOnce({ tenantId: "tenant-1", tenantName: "ContainerZone Test", accessToken: "renewed", refreshToken: "rotated", expiresAt: refreshedExpiry, scope: "accounting.invoices accounting.contacts" } as any);
    vi.mocked(getXeroReadAuthWithRefresh).mockResolvedValue({ token: "renewed", tenantId: "tenant-1" });
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: [{ tenantName: "ContainerZone Test" }] });

    const result = await testFinancialXeroConnection();

    expect(result).toMatchObject({ outcome: "passed", tokenState: "valid" });
    expect(result.expiresAt?.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(getXeroReadAuthWithRefresh).toHaveBeenCalledTimes(1);
    noMutationAssertions();
  });

  it("holds a GET-only health check when the connected tenant is not ContainerZone", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "Different Organisation" }] } })
      .mockResolvedValueOnce({ data: [{ tenantName: "Different Organisation" }] });
    const result = await testFinancialXeroConnection();
    expect(result).toMatchObject({ outcome: "failed", organisationName: "Different Organisation", expectedTenantLabel: "CONTAINERZONE" });
    noMutationAssertions();
  });

  it("preflights only GET candidate, contact and item reads and records an existing PO", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: { PurchaseOrders: [{ PurchaseOrderID: "po-1", PurchaseOrderNumber: "H1860", Status: "DRAFT", Contact: { Name: "Hire Supplier" } }] } })
      .mockResolvedValueOnce({ data: { Contacts: [{ ContactID: "contact-hire", Name: "Hire Supplier" }] } })
      .mockResolvedValueOnce({ data: { Items: [{ Description: "Native HC 20 E", IsSold: true, PurchaseDetails: { UnitPrice: 8 }, SalesDetails: { UnitPrice: 0, AccountCode: "312", TaxType: "OUTPUT" } }] } });
    const [result] = await preflightFinancialXeroIntents([{
      documentFamily: "purchase_order", documentType: "recurring_hire", proposedAction: "create_draft", proposedDocumentNumber: "H1860",
      reference: "H1860", partyName: "Hire Supplier", partySourceId: null, accountCode: "312", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
      issueDate: null, dueDate: null, subtotal: 240, taxAmount: 24, total: 264, lineItems: [{ itemCode: "HC 20 E", description: "Native description", quantity: 30, unitAmount: 8, lineAmount: 240, accountCode: "312", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
      validationStatus: "valid", sourceWorkflow: "recurring_for_hire", sourceRecordId: "4x1",
    }]);
    expect(result).toMatchObject({ duplicateState: "found", xeroDocumentId: "po-1", status: "DRAFT", partyName: "Hire Supplier" });
    expect(result?.itemChecks[0]).toMatchObject({ itemCode: "HC 20 E", found: true, purchaseUnitPrice: 8, nativeDescription: "Native HC 20 E", isSold: true, salesAccountCode: "312", salesAccountActive: null, salesTaxType: "OUTPUT" });
    expect(result?.contactCheck).toMatchObject({ found: true, contactId: "contact-hire" });
    expect(mockGet.mock.calls.some(([url]) => String(url).endsWith("/Accounts"))).toBe(false);
    noMutationAssertions();
  });

  it("blocks execution eligibility when the preflight tenant is not ContainerZone", async () => {
    mockGet.mockResolvedValueOnce({ data: { Organisations: [{ Name: "Different Organisation" }] } });
    await expect(preflightFinancialXeroIntents([])).rejects.toThrow(/expected AP tenant/i);
    noMutationAssertions();
  });

  it("holds an immutable Xero ContactID when its current Xero name differs from the intended party", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: { Invoices: [] } })
      .mockResolvedValueOnce({ data: { Contacts: [{ ContactID: "contact-bound", ContactStatus: "ACTIVE", Name: "Original Draft Customer" }] } });
    const [result] = await preflightFinancialXeroIntents([{
      documentFamily: "customer_invoice", documentType: "main_invoice", proposedAction: "create_draft", proposedDocumentNumber: "INV-7000",
      reference: null, partyName: "Changed Deal Name", partySourceId: "contact-bound", accountCode: "200", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
      issueDate: null, dueDate: null, subtotal: 10, taxAmount: 1, total: 11,
      lineItems: [{ itemCode: "", description: "Service", quantity: 1, unitAmount: 10, lineAmount: 10, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
      validationStatus: "valid", sourceWorkflow: "main_customer_invoice", sourceRecordId: "5x1",
    }]);
    expect(result?.contactCheck).toMatchObject({ found: false, contactId: null, partyName: "Changed Deal Name" });
    expect(mockGet.mock.calls[2]![0]).toMatch(/Contacts\/contact-bound$/);
    noMutationAssertions();
  });

  it("keeps an active immutable ContactID valid for a non-Main Draft even when a display name has changed", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: { Invoices: [] } })
      .mockResolvedValueOnce({ data: { Contacts: [{ ContactID: "contact-bound", ContactStatus: "ACTIVE", Name: "Original Draft Customer" }] } });
    const [result] = await preflightFinancialXeroIntents([{
      documentFamily: "customer_invoice", documentType: "storage_activation", proposedAction: "create_draft", proposedDocumentNumber: "INV-7000-A",
      reference: null, partyName: "Changed Deal Name", partySourceId: "contact-bound", accountCode: "200", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
      issueDate: null, dueDate: null, subtotal: 10, taxAmount: 1, total: 11,
      lineItems: [{ itemCode: "", description: "Storage", quantity: 1, unitAmount: 10, lineAmount: 10, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
      validationStatus: "valid", sourceWorkflow: "storage_activation", sourceRecordId: "5x1",
    }]);
    expect(result?.contactCheck).toMatchObject({ found: true, contactId: "contact-bound" });
    noMutationAssertions();
  });

  it("records inactive Main Invoice sales-account evidence rather than treating an item code as sufficient", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: { Invoices: [] } })
      .mockResolvedValueOnce({ data: { Contacts: [{ ContactID: "contact-main", ContactStatus: "ACTIVE", Name: "Customer" }] } })
      .mockResolvedValueOnce({ data: { Items: [{ Code: "SER9", Description: "Loaded Container from <> to <>", IsSold: true, SalesDetails: { AccountCode: "200", TaxType: "OUTPUT" } }] } })
      .mockResolvedValueOnce({ data: { Accounts: [{ Code: "200", Status: "ARCHIVED" }] } });
    const [result] = await preflightFinancialXeroIntents([{
      documentFamily: "customer_invoice", documentType: "main_customer_invoice", proposedAction: "create_draft", proposedDocumentNumber: "INV-7000",
      reference: "Q7000", partyName: "Customer", partySourceId: "contact-main", accountCode: "200", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
      issueDate: new Date("2026-10-11T00:00:00Z"), dueDate: null, subtotal: 10, taxAmount: 1, total: 11,
      lineItems: [{ itemCode: "SER9", description: "Loaded Container from Origin to Destination", quantity: 1, unitAmount: 10, lineAmount: 10, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
      validationStatus: "valid", sourceWorkflow: "main_customer_invoice", sourceRecordId: "5x1",
    }]);
    expect(result).toMatchObject({
      duplicateState: "not_found",
      itemChecks: [expect.objectContaining({ itemCode: "SER9", salesAccountActive: false })],
      accountChecks: [{ accountCode: "200", active: false }],
    });
    noMutationAssertions();
  });

  it("treats an exact DELETED or VOIDED customer invoice as an occupied number", async () => {
    for (const status of ["DELETED", "VOIDED"]) {
      mockGet
        .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
        .mockResolvedValueOnce({ data: { Invoices: [{ InvoiceID: `old-${status}`, InvoiceNumber: "INV-702885-A", Type: "ACCREC", Status: status }] } })
        .mockResolvedValueOnce({ data: { Contacts: [{ ContactID: "wez-1", Name: "Wez Jenkins" }] } });
      const [result] = await preflightFinancialXeroIntents([{
        documentFamily: "customer_invoice", documentType: "storage_activation", proposedAction: "create_draft", proposedDocumentNumber: "INV-702885-A",
        reference: "D702885", partyName: "Wez Jenkins", partySourceId: null, accountCode: "200", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
        issueDate: null, dueDate: null, subtotal: 42.21, taxAmount: 4.22, total: 46.43,
        lineItems: [{ itemCode: "", description: "Storage", quantity: 1, unitAmount: 42.21, lineAmount: 42.21, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
        validationStatus: "valid", sourceWorkflow: "storage_activation", sourceRecordId: "5x484050",
      }]);
      expect(result).toMatchObject({ duplicateState: "found", status, xeroDocumentId: `old-${status}` });
      noMutationAssertions();
    }
  });

  it("holds an exact number shared by deleted history and a newer Draft", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: { Invoices: [
        { InvoiceID: "old-deleted", InvoiceNumber: "INV-702885-A", Type: "ACCREC", Status: "DELETED" },
        { InvoiceID: "new-draft", InvoiceNumber: "INV-702885-A", Type: "ACCREC", Status: "DRAFT" },
      ] } })
      .mockResolvedValueOnce({ data: { Contacts: [{ ContactID: "wez-1", Name: "Wez Jenkins" }] } });
    const [result] = await preflightFinancialXeroIntents([{
      documentFamily: "customer_invoice", documentType: "storage_activation", proposedAction: "create_draft", proposedDocumentNumber: "INV-702885-A",
      reference: "D702885", partyName: "Wez Jenkins", partySourceId: null, accountCode: "200", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
      issueDate: null, dueDate: null, subtotal: 42.21, taxAmount: 4.22, total: 46.43,
      lineItems: [{ itemCode: "", description: "Storage", quantity: 1, unitAmount: 42.21, lineAmount: 42.21, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
      validationStatus: "valid", sourceWorkflow: "storage_activation", sourceRecordId: "5x484050",
    }]);
    expect(result).toMatchObject({ duplicateState: "ambiguous", xeroDocumentId: null });
    expect(result?.error).toMatch(/immutable ID/);
    noMutationAssertions();
  });

  it("provides a bounded historical preview without persisting or guessing unmatched references", async () => {
    mockGet.mockResolvedValueOnce({ data: { PurchaseOrders: [{ PurchaseOrderID: "po-asset", PurchaseOrderNumber: "A1860", Status: "AUTHORISED", Contact: { Name: "Supplier" } }] } });
    const rows = await previewHistoricalXeroReferences(["A1860", "NOT-A-PATTERN"]);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: "A1860", reconciliationState: "matched", xeroDocumentId: "po-asset" }),
      expect.objectContaining({ reference: "NOT-A-PATTERN", reconciliationState: "needs_review" }),
    ]));
    noMutationAssertions();
  });

  it("requires an exact GET-only Draft read-back after a guarded writer response", async () => {
    mockGet.mockResolvedValueOnce({ data: { Organisations: [{ Name: "CONTAINERZONE" }] } });
    mockGet.mockResolvedValueOnce({ data: {
      Invoices: [{
        InvoiceID: "invoice-1", InvoiceNumber: "INV-7001", Status: "DRAFT",
        Contact: { Name: "Customer" }, SubTotal: 100, Total: 110,
        LineItems: [{ Description: "Service" }],
      }],
    } });
    const result = await readBackFinancialDraft({
      documentFamily: "customer_invoice", documentNumber: "INV-7001", expectedXeroDocumentId: "invoice-1",
    });
    expect(result).toMatchObject({ xeroDocumentId: "invoice-1", documentNumber: "INV-7001", status: "DRAFT", total: 110, lineCount: 1 });
    noMutationAssertions();
  });

  it("resolves Deposit Required sales account/tax from the exact current item with GET-only evidence", async () => {
    mockGet.mockResolvedValueOnce({ data: { Organisations: [{ Name: "CONTAINERZONE" }] } })
      .mockResolvedValueOnce({ data: { Items: [{ Code: "Deposit Required", IsSold: true, SalesDetails: { AccountCode: "200", TaxType: "OUTPUT" } }] } })
      .mockResolvedValueOnce({ data: { Accounts: [{ Code: "200", Status: "ACTIVE" }] } });
    await expect(readDepositInvoiceXeroItemConfiguration()).resolves.toEqual({ itemCode: "Deposit Required", accountCode: "200", taxType: "OUTPUT" });
    expect(mockGet.mock.calls[1]![0]).toMatch(/Items\/Deposit%20Required$/);
    noMutationAssertions();
  });

  it("holds Deposit item/account ambiguity rather than inventing account 200", async () => {
    for (const item of [{ Code: "Wrong", IsSold: true, SalesDetails: { AccountCode: "200", TaxType: "OUTPUT" } }, { Code: "Deposit Required", IsSold: true, SalesDetails: { TaxType: "OUTPUT" } }, { Code: "Deposit Required", IsSold: true, SalesDetails: { AccountCode: "201", TaxType: "NONE" } }]) {
      mockGet.mockResolvedValueOnce({ data: { Organisations: [{ Name: "CONTAINERZONE" }] } }).mockResolvedValueOnce({ data: { Items: [item] } });
      await expect(readDepositInvoiceXeroItemConfiguration()).rejects.toThrow(/exact Xero Deposit Required/);
    }
    noMutationAssertions();
  });

  it("verifies Deposit inclusive amounts, AUD, exact item, contact and GST in GET-only Draft read-back", async () => {
    const expected = { documentFamily: "customer_invoice", documentType: "deposit_invoice", sourceWorkflow: "deposit_invoice", proposedAction: "create_draft", proposedDocumentNumber: "INV-123-D", reference: null,
      partyName: "Customer", partySourceId: "contact-1", accountCode: "200", gstTreatment: "GST_INCLUSIVE", currency: "AUD", subtotal: 100, taxAmount: 10, total: 110,
      issueDate: new Date("2026-10-11T00:00:00Z"), dueDate: new Date("2026-10-12T00:00:00Z"), lineItems: [{ itemCode: "Deposit Required", description: "Deposit for Q1 from INV-123", quantity: 1, unitAmount: 110, lineAmount: 110, accountCode: "200", taxRate: 10, gstTreatment: "GST_INCLUSIVE" }], sourceRecordId: "5x77", validationStatus: "valid" } as any;
    const actual = { InvoiceID: "id-deposit", InvoiceNumber: "INV-123-D", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", Contact: { ContactID: "contact-1" }, LineAmountTypes: "Inclusive",
      Date: "2026-10-11", DueDate: "2026-10-12", SubTotal: 100, TotalTax: 10, Total: 110, LineItems: [{ ItemCode: "Deposit Required", Description: "Deposit for Q1 from INV-123", Quantity: 1, UnitAmount: 110, AccountCode: "200", TaxType: "OUTPUT" }] };
    mockGet.mockResolvedValueOnce({ data: { Organisations: [{ Name: "CONTAINERZONE" }] } }).mockResolvedValueOnce({ data: { Invoices: [actual] } });
    await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-123-D", expectedXeroDocumentId: "id-deposit", expectedDocument: expected })).resolves.toMatchObject({ total: 110, subtotal: 100 });
    for (const patch of [{ CurrencyCode: "USD" }, { LineAmountTypes: "Exclusive" }, { TotalTax: 11 }, { LineItems: [{ ...actual.LineItems[0], ItemCode: "Wrong" }] }]) {
      mockGet.mockResolvedValueOnce({ data: { Organisations: [{ Name: "CONTAINERZONE" }] } }).mockResolvedValueOnce({ data: { Invoices: [{ ...actual, ...patch }] } });
      await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-123-D", expectedXeroDocumentId: "id-deposit", expectedDocument: expected })).rejects.toThrow(/does not match/);
    }
    noMutationAssertions();
  });

  it("rejects a storage read-back with mismatched content even when ID and Draft status match", async () => {
    const expected = {
      documentFamily: "customer_invoice", documentType: "storage_activation", proposedAction: "create_draft", proposedDocumentNumber: "INV-123-A",
      partyName: "Customer", partySourceId: "contact-1", accountCode: "200", reference: "D123", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
      subtotal: 100, taxAmount: 10, total: 110, issueDate: new Date("2026-08-10T00:00:00Z"), dueDate: new Date("2026-08-11T00:00:00Z"),
      lineItems: [{ description: "Storage", quantity: 1, unitAmount: 100, lineAmount: 100, itemCode: "", accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
      validationStatus: "valid", sourceWorkflow: "storage_activation", sourceRecordId: "5x123",
    } as any;
    const actual = { InvoiceID: "id-1", InvoiceNumber: "INV-123-A", Status: "DRAFT", Type: "ACCREC", Contact: { ContactID: "contact-1" },
      Date: "2026-08-10", DueDate: "2026-08-11", LineAmountTypes: "Exclusive", SubTotal: 100, Total: 110,
      LineItems: [{ Description: "Storage", Quantity: 1, UnitAmount: 100, AccountCode: "200", TaxType: "OUTPUT" }] };
    for (const patch of [{ Total: 111 }, { Date: "2026-08-09" }, { Contact: { ContactID: "wrong" } }, { LineItems: [{ ...actual.LineItems[0], UnitAmount: undefined }] }]) {
      mockGet.mockResolvedValueOnce({ data: { Organisations: [{ Name: "CONTAINERZONE" }] } })
        .mockResolvedValueOnce({ data: { Invoices: [{ ...actual, ...patch }] } });
      await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-123-A", expectedXeroDocumentId: "id-1", expectedDocument: expected })).rejects.toThrow(/does not match/);
    }
    noMutationAssertions();
  });
});
