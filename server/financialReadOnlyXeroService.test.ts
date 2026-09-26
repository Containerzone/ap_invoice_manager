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

import { getXeroToken } from "./db";
import {
  preflightFinancialXeroIntents,
  previewHistoricalXeroReferences,
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
    mockRunCached.mockImplementation(async (_auth: unknown, _key: string, _ttl: number, operation: () => Promise<any>) => (await operation()).data);
  });

  it("tests Xero connection using GET-only requests and never refreshes or mutates", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { Organisations: [{ Name: "ContainerZone Test" }] } })
      .mockResolvedValueOnce({ data: [{ tenantName: "ContainerZone Test" }] });
    const result = await testFinancialXeroConnection();
    expect(result).toMatchObject({ outcome: "passed", readOnlyGuard: true, organisationName: "ContainerZone Test" });
    expect(mockGet).toHaveBeenCalledTimes(2);
    noMutationAssertions();
  });

  it("preflights only GET candidate, contact and item reads and records an existing PO", async () => {
    mockGet
      .mockResolvedValueOnce({ data: { PurchaseOrders: [{ PurchaseOrderID: "po-1", PurchaseOrderNumber: "H1860", Status: "DRAFT", Contact: { Name: "Hire Supplier" } }] } })
      .mockResolvedValueOnce({ data: { Contacts: [{ Name: "Hire Supplier" }] } })
      .mockResolvedValueOnce({ data: { Items: [{ Description: "Native HC 20 E", PurchaseDetails: { UnitPrice: 8 }, SalesDetails: { UnitPrice: 0 } }] } });
    const [result] = await preflightFinancialXeroIntents([{
      documentFamily: "purchase_order", documentType: "recurring_hire", proposedAction: "create_draft", proposedDocumentNumber: "H1860",
      reference: "H1860", partyName: "Hire Supplier", partySourceId: null, accountCode: "312", gstTreatment: "GST_EXCLUSIVE", currency: "AUD",
      issueDate: null, dueDate: null, subtotal: 240, taxAmount: 24, total: 264, lineItems: [{ itemCode: "HC 20 E", description: "Native description", quantity: 30, unitAmount: 8, lineAmount: 240, accountCode: "312", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
      validationStatus: "valid", sourceWorkflow: "recurring_for_hire", sourceRecordId: "4x1",
    }]);
    expect(result).toMatchObject({ duplicateState: "found", xeroDocumentId: "po-1", status: "DRAFT", partyName: "Hire Supplier" });
    expect(result?.itemChecks[0]).toMatchObject({ itemCode: "HC 20 E", found: true, purchaseUnitPrice: 8, nativeDescription: "Native HC 20 E" });
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
});
