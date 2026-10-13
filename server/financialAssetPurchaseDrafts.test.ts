import { describe, expect, it, afterEach } from "vitest";
import { buildAssetPurchasePo } from "./financialAssetPurchaseDrafts";
import { assertAssetPurchaseRelease, resolveAssetPurchaseRelease } from "./financialAssetPurchaseRelease";

const base = (overrides: Record<string, unknown> = {}) => ({
  recordId: "24x901", controlNumber: "C1860", acquisition: "ASSET", status: "REQUEST",
  containerNumber: "TGHU1234567", containerType: "20 FOOT", grade: "A Grade", collectionDepot: "PORT BOTANY",
  supplierVtigerId: "18x44", supplierName: "Asset Supplier", purchasePriceInclusive: 1100,
  purchaseDate: "2026-10-11", sourceRefreshedAt: "2026-10-11T00:00:00.000Z", ...overrides,
});

afterEach(() => { delete process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED; });

describe("Asset Container Control purchase-order rules", () => {
  it("builds the Operations-aligned Asset Draft PO with a new A reference and GST-exclusive account 322 line", () => {
    const result = buildAssetPurchasePo(base());
    expect(result).toMatchObject({ eligible: true, proposedPoNumber: "AC1860" });
    expect(result.document).toMatchObject({
      proposedDocumentNumber: "AC1860", documentFamily: "purchase_order", documentType: "asset_purchase",
      partyName: "Asset Supplier", accountCode: "322", gstTreatment: "GST_EXCLUSIVE",
      subtotal: 1000, taxAmount: 100, total: 1100, issueDate: new Date("2026-10-11T00:00:00.000Z"),
    });
    expect(result.document?.lineItems).toEqual([expect.objectContaining({
      itemCode: "Container Asset", accountCode: "322", quantity: 1, unitAmount: 1000,
      description: "TGHU1234567 — (24x901) — Asset — 20 FOOT — A Grade — PORT BOTANY — Purchase Date: 2026-10-11",
    })]);
  });

  it("accepts VTiger's current ASSETT picklist serialization as Asset", () => {
    const result = buildAssetPurchasePo(base({ acquisition: "ASSETT" }));
    expect(result).toMatchObject({ eligible: true, proposedPoNumber: "AC1860" });
  });

  it("holds the proposal when the dedicated Asset / REQUEST source facts are incomplete or belong to another branch", () => {
    expect(buildAssetPurchasePo(base({ acquisition: "FOR HIRE" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("not ASSET") });
    expect(buildAssetPurchasePo(base({ status: "ON HIRE" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("REQUEST") });
    expect(buildAssetPurchasePo(base({ purchasePriceInclusive: 0 }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("positive") });
    expect(buildAssetPurchasePo(base({ supplierVtigerId: "", supplierName: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Supplier") });
  });
});

describe("Asset purchase release policy", () => {
  it("is default-off and requires the independent release flag plus both handovers", () => {
    const defaultPolicy = resolveAssetPurchaseRelease({});
    expect(defaultPolicy).toMatchObject({ enabled: false, migrationScope: "new_events_only" });
    expect(() => assertAssetPurchaseRelease(defaultPolicy)).toThrow(/disabled/);

    process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED = "true";
    const active = resolveAssetPurchaseRelease({
      releaseKey: "ASSET-PO-test", enabled: true, approvedBy: 7,
      approvedAt: "2026-10-11T00:00:00.000Z", effectiveFrom: "2026-10-11T00:00:00.000Z",
      assetOnlyVtigerBranch: true, operationsAssetHandoff: true,
    });
    expect(() => assertAssetPurchaseRelease(active)).not.toThrow();
    expect(() => assertAssetPurchaseRelease({ ...active, operationsAssetHandoff: false })).toThrow(/handover/);
  });
});
