import { afterEach, describe, expect, it, vi } from "vitest";
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

// HC1929 is an offline rule example, not a live source lookup.
const hc1929 = (overrides: Record<string, unknown> = {}) => base({
  recordId: "24x1929", controlNumber: "C1929", status: "ON HIRE",
  containerType: "40 Foot Standard", collectionDate: "2026-11-13",
  ...overrides,
});

describe("For Hire Container Control PO drafts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(forHireExtensionReference("C1929", null)).toBe("HC1929-2");
    expect(forHireExtensionReference("C1929", 2)).toBe("HC1929-3");
  });

  it("builds HC1929-2 for 40 Foot Standard from 14 December to 12 January at the current HC 40 E rate", () => {
    const result = buildRecurringForHirePo({
      facts: hc1929({ liftAndBookingFeesInclusive: 55, monthlyCostInclusive: 264 }),
      priorPeriodEnd: "2026-12-13", lastVerifiedExtensionSuffix: null, purchaseRate: 16.5,
      itemNativeDescription: "Generic extension text is not the period description", now: "2026-12-14",
    });
    expect(result).toMatchObject({ eligible: true, holdReason: null, proposedPoNumber: "HC1929-2", periodStart: "2026-12-14", periodEnd: "2027-01-12" });
    expect(result.document).toMatchObject({ proposedDocumentNumber: "HC1929-2", issueDate: new Date("2026-12-14T00:00:00.000Z"), subtotal: 495, taxAmount: 49.5, total: 544.5 });
    expect(result.document?.lineItems).toEqual([expect.objectContaining({
      itemCode: "HC 40 E", quantity: 30, unitAmount: 16.5, lineAmount: 495, accountCode: "312",
      description: "TGHU1234567, 40 Foot Standard Extended Hire @ $16.50 per day from 14/12/26 to 12/01/27",
    })]);
  });

  it("holds HC1929 before 14 December and preserves the same candidate rather than creating daily POs on later checks", () => {
    const input = { facts: hc1929(), priorPeriodEnd: "2026-12-13", lastVerifiedExtensionSuffix: null, purchaseRate: 16.5 };
    const beforeDue = buildRecurringForHirePo({ ...input, now: "2026-12-13" });
    expect(beforeDue).toMatchObject({ eligible: false, holdReason: expect.stringContaining("not due"), proposedPoNumber: null, document: null });
    for (const now of ["2026-12-14", "2026-12-15"]) {
      const result = buildRecurringForHirePo({ ...input, now });
      expect(result).toMatchObject({ eligible: true, proposedPoNumber: "HC1929-2", periodStart: "2026-12-14", periodEnd: "2027-01-12" });
      expect(result.document?.issueDate).toEqual(new Date("2026-12-14T00:00:00.000Z"));
    }
    expect(input.priorPeriodEnd).toBe("2026-12-13");
    expect(input.lastVerifiedExtensionSuffix).toBeNull();
  });

  it("uses verified suffix 2 and its end date to make suffix 3 due on 13 January, not before", () => {
    const input = { facts: hc1929(), priorPeriodEnd: "2027-01-12", lastVerifiedExtensionSuffix: 2, purchaseRate: 17.25 };
    expect(buildRecurringForHirePo({ ...input, now: "2027-01-12" })).toMatchObject({ eligible: false, holdReason: expect.stringContaining("not due"), document: null });
    const due = buildRecurringForHirePo({ ...input, now: "2027-01-13" });
    expect(due).toMatchObject({ eligible: true, proposedPoNumber: "HC1929-3", periodStart: "2027-01-13", periodEnd: "2027-02-11" });
    expect(due.document?.lineItems[0]).toMatchObject({ itemCode: "HC 40 E", quantity: 30, unitAmount: 17.25,
      description: "TGHU1234567, 40 Foot Standard Extended Hire @ $17.25 per day from 13/01/27 to 11/02/27" });
  });

  it("selects HC 20 E for a 20-foot container and retains the exact source type in its description", () => {
    const result = buildRecurringForHirePo({ facts: hc1929({ containerType: "20 FOOT", status: "IDLE" }), priorPeriodEnd: "2026-12-13", lastVerifiedExtensionSuffix: null, purchaseRate: 8.25, now: "2026-12-14" });
    expect(result).toMatchObject({ eligible: true, proposedPoNumber: "HC1929-2", periodStart: "2026-12-14", periodEnd: "2027-01-12" });
    expect(result.document?.lineItems).toEqual([expect.objectContaining({ itemCode: "HC 20 E", quantity: 30, unitAmount: 8.25,
      description: "TGHU1234567, 20 FOOT Extended Hire @ $8.25 per day from 14/12/26 to 12/01/27" })]);
  });

  it.each([
    { status: "DEHIRED", acquisition: "FOR HIRE", reason: "DEHIRED" },
    { status: "REQUEST", acquisition: "FOR HIRE", reason: "ON HIRE or IDLE" },
    { status: "ON HIRE", acquisition: "ASSET", reason: "not FOR HIRE" },
  ])("returns no recurring financial proposal for $acquisition / $status", ({ status, acquisition, reason }) => {
    const result = buildRecurringForHirePo({ facts: hc1929({ containerType: "40 FOOT", status, acquisition }), priorPeriodEnd: "2026-12-13", lastVerifiedExtensionSuffix: null, purchaseRate: 16.5, now: "2026-12-14" });
    expect(result).toMatchObject({ eligible: false, holdReason: expect.stringContaining(reason), proposedPoNumber: null, document: null });
  });

  it("requires a verified predecessor even when HC1929's collection date could suggest an initial period", () => {
    const result = buildRecurringForHirePo({ facts: hc1929({ containerType: "40 FOOT" }), priorPeriodEnd: null, lastVerifiedExtensionSuffix: null, purchaseRate: 16.5, now: "2026-12-14" });
    expect(result).toMatchObject({ eligible: false, holdReason: expect.stringContaining("No verified AP"), proposedPoNumber: null, document: null });
  });

  it("retains the historical-period guard instead of rolling HC1929 forward to today's date", () => {
    const result = buildRecurringForHirePo({ facts: hc1929({ containerType: "40 FOOT" }), priorPeriodEnd: "2026-09-30", lastVerifiedExtensionSuffix: 2, purchaseRate: 16.5, now: "2026-12-14" });
    expect(result).toMatchObject({ eligible: false, holdReason: expect.stringContaining("historical"), periodStart: "2026-10-01", periodEnd: "2026-10-30", proposedPoNumber: null, document: null });
  });

  describe("Sydney calendar date without an explicit now", () => {
    // These are business-date boundaries, not a mandated daily execution hour.
    it.each([
      { label: "AEDT just before midnight", instant: "2026-12-13T12:59:59.999Z", priorPeriodEnd: "2026-12-13", start: "2026-12-14", end: "2027-01-12", eligible: false },
      { label: "AEDT midnight while UTC is still yesterday", instant: "2026-12-13T13:00:00.000Z", priorPeriodEnd: "2026-12-13", start: "2026-12-14", end: "2027-01-12", eligible: true },
      { label: "AEST just before midnight", instant: "2026-07-13T13:59:59.999Z", priorPeriodEnd: "2026-07-13", start: "2026-07-14", end: "2026-08-12", eligible: false },
      { label: "AEST midnight while UTC is still yesterday", instant: "2026-07-13T14:00:00.000Z", priorPeriodEnd: "2026-07-13", start: "2026-07-14", end: "2026-08-12", eligible: true },
      { label: "before midnight on the DST-start date", instant: "2026-10-03T13:59:59.999Z", priorPeriodEnd: "2026-10-03", start: "2026-10-04", end: "2026-11-02", eligible: false },
      { label: "midnight on the DST-start date", instant: "2026-10-03T14:00:00.000Z", priorPeriodEnd: "2026-10-03", start: "2026-10-04", end: "2026-11-02", eligible: true },
      { label: "before midnight on the DST-end date", instant: "2026-04-04T12:59:59.999Z", priorPeriodEnd: "2026-04-04", start: "2026-04-05", end: "2026-05-04", eligible: false },
      { label: "midnight on the DST-end date", instant: "2026-04-04T13:00:00.000Z", priorPeriodEnd: "2026-04-04", start: "2026-04-05", end: "2026-05-04", eligible: true },
    ])("uses $label for the next due period", ({ instant, priorPeriodEnd, start, end, eligible }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(instant));
      const result = buildRecurringForHirePo({ facts: base({ status: "ON HIRE" }), priorPeriodEnd, lastVerifiedExtensionSuffix: null, purchaseRate: 8.25 });
      expect(result).toMatchObject({ eligible, periodStart: start, periodEnd: end });
      if (eligible) {
        expect(result.proposedPoNumber).toBe("HC1860-2");
        expect(result.document?.issueDate).toEqual(new Date(`${start}T00:00:00.000Z`));
        expect(result.document?.lineItems[0].quantity).toBe(30);
      } else {
        expect(result.holdReason).toContain("not due");
        expect(result.document).toBeNull();
      }
    });

    it.each([
      { label: "spring-forward", before: "2026-10-03T15:59:59.999Z", after: "2026-10-03T16:00:00.000Z", priorPeriodEnd: "2026-10-03", start: "2026-10-04", end: "2026-11-02" },
      { label: "fall-back", before: "2026-04-04T15:59:59.999Z", after: "2026-04-04T16:00:00.000Z", priorPeriodEnd: "2026-04-04", start: "2026-04-05", end: "2026-05-04" },
    ])("does not advance the period or suffix at Sydney's $label clock change", ({ before, after, priorPeriodEnd, start, end }) => {
      vi.useFakeTimers();
      for (const instant of [before, after]) {
        vi.setSystemTime(new Date(instant));
        const result = buildRecurringForHirePo({ facts: base({ status: "IDLE" }), priorPeriodEnd, lastVerifiedExtensionSuffix: null, purchaseRate: 8.25 });
        expect(result).toMatchObject({ eligible: true, proposedPoNumber: "HC1860-2", periodStart: start, periodEnd: end });
        expect(result.document?.lineItems[0]).toMatchObject({ itemCode: "HC 20 E", quantity: 30, unitAmount: 8.25 });
      }
    });
  });
});
