import { describe, expect, it } from "vitest";
import { buildInitialStorageDrafts, firstStoragePeriod, storageSuffix, validateLoadedStorageDeal, type StorageDeal } from "./financialStorageDrafts";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";

const raw = {
  id: "5x123456", potential_no: "D123456", sales_stage: "4 STORAGE at ORIGIN",
  cf_potentials_storagerequired: "Yes at Origin", potentialname: "CONT-1234567",
  cf_potentials_containertype: "20 Foot Standard", cf_potentials_datein: "2026-08-10",
  related_to: "3x10", contact_id: "4x20", cf_potentials_contractorc2: "6x30",
  cf_potentials_fullcontainerdeliveryv: "6x40", cf_potentials_fullcontainerdeliverydate: "",
};
const deal: StorageDeal = {
  dealId: raw.id, dealNumber: raw.potential_no, location: "origin", containerNumber: raw.potentialname,
  containerType: "20 Foot Standard", dateIn: "2026-08-10", deliveryDate: null,
  customer: { name: "Business", vtigerId: "3x10", email: null },
  driver: { name: "Driver", vtigerId: "6x30", email: null },
  storageSupplier: { name: "Containerzone", vtigerId: "xero-contact", email: null },
};

describe("verified VTiger initial loaded storage", () => {
  it("accepts only the exact Origin API stage and matching storage selection", () => {
    expect(validateLoadedStorageDeal(raw, raw.id)).toMatchObject({ location: "origin", customerId: "3x10", driverId: "6x30" });
    expect(() => validateLoadedStorageDeal({ ...raw, sales_stage: "11 DELIVER From STORAGE" }, raw.id)).toThrow(/exact loaded-storage/);
    expect(() => validateLoadedStorageDeal({ ...raw, cf_potentials_storagerequired: "No" }, raw.id)).toThrow(/does not match/);
  });
  it("selects destination delivery driver and contact fallback", () => {
    expect(validateLoadedStorageDeal({ ...raw, sales_stage: "11 STORAGE at DEST", cf_potentials_storagerequired: "Yes at Destination", related_to: "" }, raw.id))
      .toMatchObject({ location: "destination", customerId: "4x20", driverId: "6x40" });
  });
  it.each([
    [{ ...raw, potential_no: "" }, /Deal ID/],
    [{ ...raw, cf_potentials_datein: "" }, /date/],
    [{ ...raw, cf_potentials_containertype: "45 Foot High Cube" }, /unsupported/],
    [{ ...raw, cf_potentials_contractorc2: "" }, /driver/],
    [{ ...raw, related_to: "", contact_id: "" }, /bill-to/],
    [{ ...raw, cf_potentials_fullcontainerdeliverydate: "2026-08-09" }, /precedes/],
  ])("holds invalid Deal source without a financial proposal", (source, message) => {
    expect(() => validateLoadedStorageDeal(source, raw.id)).toThrow(message);
  });
  it("uses inclusive Sydney calendar days, including same-day minimum", () => {
    expect(firstStoragePeriod("2026-08-10", null)).toEqual({ start: "2026-08-10", end: "2026-08-31", days: 22 });
    expect(firstStoragePeriod("2026-08-29", null)).toEqual({ start: "2026-08-29", end: "2026-09-30", days: 33 });
    expect(firstStoragePeriod("2026-08-29", "2026-08-29")).toEqual({ start: "2026-08-29", end: "2026-08-29", days: 1 });
    expect(firstStoragePeriod("2026-08-10", "2026-08-15").days).toBe(6);
  });
  it("is stable across Sydney daylight-saving boundaries", () => {
    expect(firstStoragePeriod("2026-10-02", "2026-10-05").days).toBe(4);
    expect(firstStoragePeriod("2027-04-02", "2027-04-05").days).toBe(4);
    expect(() => firstStoragePeriod("2026-02-29", null)).toThrow(/invalid/);
  });
  it.each([
    ["20 Foot Standard", 59.09, 250], ["20 Foot High Cube", 59.09, 250],
    ["40 Foot Standard", 86.36, 340.91], ["40 Foot High Cube", 86.36, 340.91],
  ] as const)("uses exact ex-GST weekly storage/transport rates for %s", (containerType, weekly, transport) => {
    const { documents, period } = buildInitialStorageDrafts({ ...deal, containerType }, "A", true);
    expect(documents).toHaveLength(3);
    expect(documents[0].subtotal).toBe(Math.round(weekly * period.days / 7 * 100) / 100);
    expect(documents[2].subtotal).toBe(documents[0].subtotal);
    expect(documents[1].subtotal).toBe(transport);
    expect(documents[1].lineItems[0].itemCode).toBe(containerType.startsWith("20") ? "JD 20" : "JD 40");
  });
  it("builds one ACCREC and two POs with correct codes/numbering/tax/date", () => {
    const { documents: [invoice, transport, storage] } = buildInitialStorageDrafts(deal, "A", true);
    expect(invoice).toMatchObject({ proposedDocumentNumber: "INV-123456-A", documentFamily: "customer_invoice", accountCode: "200", gstTreatment: "GST_EXCLUSIVE", partyName: "Business" });
    expect(invoice.issueDate?.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(invoice.dueDate?.toISOString()).toBe("2026-08-11T00:00:00.000Z");
    expect(invoice.lineItems[0].description).toContain("Origin");
    expect(transport).toMatchObject({ proposedDocumentNumber: "JD123456", accountCode: "310", partyName: "Driver" });
    expect(transport.lineItems[0].itemCode).toBe("JD 20");
    expect(storage).toMatchObject({ proposedDocumentNumber: "GD123456", accountCode: "311", partyName: "Containerzone" });
    expect(storage.lineItems[0].accountCode).not.toBe("312");
    const payloads = [invoice, transport, storage].map((doc, index) => prepareFinancialDraftPayload({ ...doc, partySourceId: `xero-contact-${index}` }, "storage-event-123"));
    expect(payloads[0].body).toMatchObject({ Invoices: [{ Type: "ACCREC", Status: "DRAFT", InvoiceNumber: "INV-123456-A", LineAmountTypes: "Exclusive", DueDate: "2026-08-11", LineItems: [{ AccountCode: "200" }] }] });
    expect(payloads[1].body).toMatchObject({ PurchaseOrders: [{ Status: "DRAFT", PurchaseOrderNumber: "JD123456", LineAmountTypes: "Exclusive", LineItems: [{ ItemCode: "JD 20", AccountCode: "310" }] }] });
    expect(payloads[2].body).toMatchObject({ PurchaseOrders: [{ Status: "DRAFT", PurchaseOrderNumber: "GD123456", LineItems: [{ AccountCode: "311" }] }] });
  });
  it("shares a Deal-wide suffix, skips deposit D, and matches second-location POs", () => {
    expect([0, 1, 2, 3, 4].map(storageSuffix)).toEqual(["A", "B", "C", "E", "F"]);
    expect(() => storageSuffix(25)).toThrow(/safe/);
    const { documents: [invoice, transport, storage] } = buildInitialStorageDrafts({ ...deal, location: "destination", driver: { name: "Delivery Driver", vtigerId: "6x40", email: null } }, "B", false);
    expect([invoice.proposedDocumentNumber, transport.proposedDocumentNumber, storage.proposedDocumentNumber]).toEqual(["INV-123456-B", "JD123456-B", "GD123456-B"]);
    expect(transport.partyName).toBe("Delivery Driver");
    expect(invoice.lineItems[0].description).toContain("Destination");
    expect(() => buildInitialStorageDrafts(deal, "D", true)).toThrow(/reserved/);
  });
});
