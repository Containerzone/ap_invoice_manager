import { describe, expect, it } from "vitest";
import {
  buildInitialForHirePo,
  buildRecurringForHirePo,
  forHireExtensionReference,
} from "./financialForHireDrafts";

const base = (overrides: Record<string, unknown> = {}) => ({
  recordId: "24x901", controlNumber: "C1860", acquisition: "FOR HIRE", status: "REQUEST",
  containerNumber: "TGHU1234567", containerType: "20 FOOT", collectionDate: "2026-10-01",
  supplierVtigerId: "18x44", supplierName: "Hire Supplier", monthlyCostInclusive: null,
  purchasePriceInclusive: null, liftAndBookingFeesInclusive: null, sourceRefreshedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

describe("For Hire Container Control PO drafts", () => {
  it("uses the exact 20-foot $120 and 40-foot $240 ex-GST initial defaults with a literal +30-day end", () => {
    const twenty = buildInitialForHirePo(base());
    const forty = buildInitialForHirePo(base({ containerType: "40 foot", controlNumber: "C1861" }));
    expect(twenty.document).toMatchObject({ proposedDocumentNumber: "HC1860", subtotal: 120, taxAmount: 12, total: 132, issueDate: new Date("2026-10-01T00:00:00.000Z") });
    expect(twenty.periodEnd).toBe("2026-10-31");
    expect(twenty.document?.lineItems[0]).toMatchObject({ itemCode: "HC 20", accountCode: "312", quantity: 1, unitAmount: 120, description: "20' Container Hire from 01/10/26 to 31/10/26" });
    expect(forty.document?.lineItems[0]).toMatchObject({ itemCode: "HC 40", unitAmount: 240, description: "40' Container Hire from 01/10/26 to 31/10/26" });
  });

  it("converts populated monthly cost and lift fee from GST-inclusive to exclusive while leaving purchase-price fallback unused", () => {
    const result = buildInitialForHirePo(base({ monthlyCostInclusive: 132, purchasePriceInclusive: 999, liftAndBookingFeesInclusive: 55 }));
    expect(result.document?.lineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemCode: "HC 20", unitAmount: 120, lineAmount: 120 }),
      expect.objectContaining({ itemCode: "", description: "Lift & Booking Fees", unitAmount: 50, lineAmount: 50, accountCode: "312" }),
    ]));
    expect(result.document).toMatchObject({ subtotal: 170, taxAmount: 17, total: 187 });
  });

  it("permits the Request-event initial PO without requiring ON HIRE or IDLE", () => {
    expect(buildInitialForHirePo(base({ status: "REQUEST" }))).toMatchObject({ eligible: true, holdReason: null });
    expect(buildInitialForHirePo(base({ acquisition: "ASSET" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("not FOR HIRE") });
  });

  it("builds one exact 30-day extension with current purchase rate and no lift/JD line", () => {
    const result = buildRecurringForHirePo({ facts: base({ status: "IDLE", containerType: "20 Foot Standard" }), priorPeriodEnd: "2026-10-31", lastVerifiedExtensionSuffix: null, purchaseRate: 8.25, now: "2026-11-01" });
    expect(result).toMatchObject({ eligible: true, proposedPoNumber: "HC1860-2", periodStart: "2026-11-01", periodEnd: "2026-11-30" });
    expect(result.document?.lineItems).toEqual([expect.objectContaining({ itemCode: "HC 20 E", quantity: 30, unitAmount: 8.25, accountCode: "312", description: "TGHU1234567, 20 Foot Standard Extended Hire @ $8.25 per day from 01/11/26 to 30/11/26" })]);
    expect(result.document?.lineItems.some((line) => line.description.includes("Lift") || line.itemCode.startsWith("JD"))).toBe(false);
  });

  it("supports ON HIRE, blocks DEHIRED, and never fills a gap or a historical period", () => {
    expect(buildRecurringForHirePo({ facts: base({ status: "ON HIRE" }), priorPeriodEnd: "2026-10-31", lastVerifiedExtensionSuffix: 2, purchaseRate: 8, now: "2026-11-01" })).toMatchObject({ eligible: true, proposedPoNumber: "HC1860-3" });
    expect(buildRecurringForHirePo({ facts: base({ status: "DEHIRED" }), priorPeriodEnd: "2026-10-31", lastVerifiedExtensionSuffix: 2, purchaseRate: 8, now: "2026-11-01" })).toMatchObject({ eligible: false, holdReason: expect.stringContaining("DEHIRED") });
    expect(buildRecurringForHirePo({ facts: base({ status: "IDLE" }), priorPeriodEnd: "2026-01-31", lastVerifiedExtensionSuffix: 2, purchaseRate: 8, now: "2026-10-01" })).toMatchObject({ eligible: false, holdReason: expect.stringContaining("historical") });
  });

  it("allocates only the exact next suffix, never a bypass reference", () => {
    expect(forHireExtensionReference("C1860", null)).toBe("HC1860-2");
    expect(forHireExtensionReference("C1860", 2)).toBe("HC1860-3");
  });
});
