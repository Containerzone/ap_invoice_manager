import { describe, expect, it, afterEach } from "vitest";
import { buildCustomerSalePurchasePo } from "./financialCustomerSalePurchaseDrafts";
import { assertCustomerSalePurchaseRelease, resolveCustomerSalePurchaseRelease } from "./financialCustomerSalePurchaseRelease";

const base = (overrides: Record<string, unknown> = {}) => ({
  recordId: "24x901", controlNumber: "C1860", acquisition: "CUSTOMER SALE", status: "REQUEST",
  containerNumber: "TGHU1234567", containerType: "20 FOOT", grade: "A Grade", collectionDepot: "PORT BOTANY",
  supplierVtigerId: "18x44", supplierName: "Customer Sale Supplier", purchasePriceInclusive: 1100,
  purchaseDate: "2026-10-11", sourceRefreshedAt: "2026-10-11T00:00:00.000Z", ...overrides,
});

afterEach(() => { delete process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED; });

describe("Customer Sale Container Control purchase-order rules", () => {
  it("builds the Operations-aligned Customer Sale Draft PO with a new S reference and GST-exclusive account 322 line", () => {
    const result = buildCustomerSalePurchasePo(base());
    expect(result).toMatchObject({ eligible: true, proposedPoNumber: "SC1860" });
    expect(result.document).toMatchObject({
      proposedDocumentNumber: "SC1860", documentFamily: "purchase_order", documentType: "customer_sale_purchase",
      partyName: "Customer Sale Supplier", accountCode: "322", gstTreatment: "GST_EXCLUSIVE",
      subtotal: 1000, taxAmount: 100, total: 1100, issueDate: new Date("2026-10-11T00:00:00.000Z"),
    });
    expect(result.document?.lineItems).toEqual([expect.objectContaining({
      itemCode: "20' Sale", accountCode: "322", quantity: 1, unitAmount: 1000,
      description: "20 FOOT A Grade",
    })]);
  });

  it("holds the proposal when the dedicated Customer Sale / REQUEST source facts are incomplete or belong to another branch", () => {
    expect(buildCustomerSalePurchasePo(base({ acquisition: "FOR HIRE" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("not CUSTOMER SALE") });
    expect(buildCustomerSalePurchasePo(base({ status: "ON HIRE" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("REQUEST") });
    expect(buildCustomerSalePurchasePo(base({ purchasePriceInclusive: 0 }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("positive") });
    expect(buildCustomerSalePurchasePo(base({ supplierVtigerId: "", supplierName: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Supplier") });
  });
});

describe("Customer Sale purchase release policy", () => {
  it("is default-off and requires the independent release flag plus both handovers", () => {
    const defaultPolicy = resolveCustomerSalePurchaseRelease({});
    expect(defaultPolicy).toMatchObject({ enabled: false, migrationScope: "new_events_only" });
    expect(() => assertCustomerSalePurchaseRelease(defaultPolicy)).toThrow(/disabled/);

    process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED = "true";
    const active = resolveCustomerSalePurchaseRelease({
      releaseKey: "CUSTOMER SALE-PO-test", enabled: true, approvedBy: 7,
      approvedAt: "2026-10-11T00:00:00.000Z", effectiveFrom: "2026-10-11T00:00:00.000Z",
      customerSaleOnlyVtigerBranch: true, operationsCustomerSaleHandoff: true,
    });
    expect(() => assertCustomerSalePurchaseRelease(active)).not.toThrow();
    expect(() => assertCustomerSalePurchaseRelease({ ...active, operationsCustomerSaleHandoff: false })).toThrow(/handover/);
  });
});
