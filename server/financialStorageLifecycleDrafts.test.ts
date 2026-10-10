import { describe, expect, it } from "vitest";
import {
  buildFinalStorageDrafts,
  buildRecurringStorageDrafts,
  recurringStoragePeriod,
  validateStorageLifecycleFacts,
  type StorageDeal,
} from "./financialStorageLifecycleDrafts";

const deal: StorageDeal = {
  dealId: "5x484050",
  dealNumber: "D702885",
  location: "origin",
  containerNumber: "CONT-702885",
  containerType: "20 Foot Standard",
  dateIn: "2026-10-01",
  deliveryDate: null,
  customer: { name: "Example Customer", vtigerId: "3x10", email: null },
  driver: { name: "Origin Driver", vtigerId: "6x30", email: null },
  storageSupplier: { name: "Containerzone", vtigerId: "xero-containerzone", email: null },
};

const finalisationRecord = {
  id: "5x484050",
  potential_no: "D702885",
  // A finalisation-stage value is deliberately not a loaded-storage stage.
  sales_stage: "11 DELIVER From STORAGE",
  cf_potentials_storagerequired: "Yes at Origin",
  potentialname: "CONT-702885",
  cf_potentials_containertype: "20 Foot Standard",
  cf_potentials_datein: "2026-10-01",
  cf_potentials_actualdateout: "2026-10-09",
  cf_potentials_fullcontainerdeliverydate: "2026-10-10",
  related_to: "3x10",
  contact_id: "4x20",
  cf_potentials_contractorc2: "6x30",
  cf_potentials_fullcontainerdeliveryv: "6x40",
};

describe("recurring storage periods", () => {
  it("uses next-day through month-end calendar periods, including leap years and delivery caps", () => {
    expect(recurringStoragePeriod("2028-01-31", null)).toEqual({ start: "2028-02-01", end: "2028-02-29", days: 29 });
    expect(recurringStoragePeriod("2028-02-28", null)).toEqual({ start: "2028-02-29", end: "2028-02-29", days: 1 });
    expect(recurringStoragePeriod("2026-09-30", "2026-10-05")).toEqual({ start: "2026-10-01", end: "2026-10-05", days: 5 });
  });

  it("counts inclusive Sydney calendar days across DST, not elapsed 24-hour periods", () => {
    // Sydney daylight saving starts on 4 October 2026; the date-only period is
    // still 4–31 October, inclusively 28 chargeable calendar days.
    expect(recurringStoragePeriod("2026-10-03", null)).toEqual({ start: "2026-10-04", end: "2026-10-31", days: 28 });
  });

  it("rejects invalid dates and delivery caps before the next billing day", () => {
    expect(() => recurringStoragePeriod("2026-02-29", null)).toThrow(/invalid/);
    expect(() => recurringStoragePeriod("2026-09-30", "2026-09-30")).toThrow(/precedes/);
  });
});

describe("pure recurring storage proposals", () => {
  it("builds only an AUD Exclusive ACCREC and suffix-qualified GD PO with inclusive pro-rata", () => {
    const { documents, period } = buildRecurringStorageDrafts(deal, "A", "2026-09-30");

    expect(period).toEqual({ start: "2026-10-01", end: "2026-10-31", days: 31 });
    expect(documents).toHaveLength(2);
    expect(documents).toEqual(expect.not.arrayContaining([expect.objectContaining({ documentType: "jd_transport" })]));
    expect(documents.map((document) => document.proposedDocumentNumber)).toEqual(["INV-702885-A", "GD702885-A"]);
    expect(documents.map((document) => document.documentFamily)).toEqual(["customer_invoice", "purchase_order"]);
    expect(documents.map((document) => document.accountCode)).toEqual(["200", "311"]);
    expect(documents.map((document) => document.sourceWorkflow)).toEqual(["recurring_storage", "recurring_storage"]);
    expect(documents.map((document) => document.proposedAction)).toEqual(["create_draft", "create_draft"]);
    expect(documents.map((document) => document.gstTreatment)).toEqual(["GST_EXCLUSIVE", "GST_EXCLUSIVE"]);
    expect(documents[0]?.subtotal).toBe(261.68); // 59.09 × 31 / 7, rounded ex-GST
    expect(documents[1]?.subtotal).toBe(261.68);
    expect(documents[0]?.dueDate?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });

  it("uses the 40-foot weekly rate for a seven-day recurring period", () => {
    const { documents, period } = buildRecurringStorageDrafts(
      { ...deal, containerType: "40 Foot High Cube", deliveryDate: "2026-10-31" },
      "B",
      "2026-10-24",
    );
    expect(period.days).toBe(7);
    expect(documents.map((document) => document.subtotal)).toEqual([86.36, 86.36]);
  });

  it("excludes the reserved deposit suffix D and unsupported container types", () => {
    expect(() => buildRecurringStorageDrafts(deal, "D", "2026-09-30")).toThrow(/reserved/);
    expect(() => buildRecurringStorageDrafts(
      { ...deal, containerType: "45 Foot High Cube" as StorageDeal["containerType"] },
      "A",
      "2026-09-30",
    )).toThrow(/unsupported/);
  });
});

describe("pure current-period storage finalisation proposals", () => {
  it("updates the current billed period only, retaining customer/GD numbers and never amending JD", () => {
    // D702885 is a fixture reference only; this test performs no live CRM/Xero call.
    const { documents, period } = buildFinalStorageDrafts(deal, "A", true, "2026-10-05", "2026-10-09");

    expect(period).toEqual({ start: "2026-10-05", end: "2026-10-09", days: 5 });
    expect(documents).toHaveLength(2);
    expect(documents.map((document) => document.proposedDocumentNumber)).toEqual(["INV-702885-A", "GD702885"]);
    expect(documents.map((document) => document.proposedAction)).toEqual(["update_draft", "update_draft"]);
    expect(documents.map((document) => document.sourceWorkflow)).toEqual(["storage_finalisation", "storage_finalisation"]);
    expect(documents.map((document) => document.accountCode)).toEqual(["200", "311"]);
    expect(documents.map((document) => document.subtotal)).toEqual([42.21, 42.21]); // 59.09 × 5 / 7
    expect(documents).toEqual(expect.not.arrayContaining([expect.objectContaining({ documentType: "jd_transport" })]));
    expect(documents[0]?.issueDate?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(documents[0]?.dueDate?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("charges a same-day finalisation as one inclusive day and preserves second-location GD suffixes", () => {
    const { documents, period } = buildFinalStorageDrafts(deal, "B", false, "2026-10-09", "2026-10-09");
    expect(period).toEqual({ start: "2026-10-09", end: "2026-10-09", days: 1 });
    expect(documents.map((document) => document.proposedDocumentNumber)).toEqual(["INV-702885-B", "GD702885-B"]);
    expect(documents.map((document) => document.subtotal)).toEqual([8.44, 8.44]);
  });

  it("rejects reverse or invalid final periods", () => {
    expect(() => buildFinalStorageDrafts(deal, "A", true, "2026-10-10", "2026-10-09")).toThrow(/precedes/);
    expect(() => buildFinalStorageDrafts(deal, "A", true, "not-a-date", "2026-10-09")).toThrow(/valid/);
  });
});

describe("verified lifecycle facts", () => {
  it("validates the existing mappings even when finalisation is no longer at an active loaded stage", () => {
    const facts = validateStorageLifecycleFacts(
      finalisationRecord,
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    );

    expect(facts).toMatchObject({
      location: "origin",
      dealNumber: "D702885",
      containerType: "20 Foot Standard",
      dateIn: "2026-10-01",
      deliveryDate: "2026-10-10",
      dateOut: "2026-10-09",
      customerId: "3x10",
      driverId: "6x30",
    });
  });

  it("uses only the explicitly supplied final-date field, with Full Container Delivery Date as its fallback", () => {
    expect(validateStorageLifecycleFacts(
      { ...finalisationRecord, cf_potentials_actualdateout: "" },
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    ).dateOut).toBe("2026-10-10");
    expect(() => validateStorageLifecycleFacts(finalisationRecord, "5x484050", "origin", "")).toThrow(/dateOutField/);
  });

  it("holds malformed identities, types, locations, dates and location-specific IDs", () => {
    expect(() => validateStorageLifecycleFacts(
      { ...finalisationRecord, id: "5xnot-the-request" },
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    )).toThrow(/identify/);
    expect(() => validateStorageLifecycleFacts(
      { ...finalisationRecord, potential_no: "702885" },
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    )).toThrow(/D-prefixed/);
    expect(() => validateStorageLifecycleFacts(
      { ...finalisationRecord, cf_potentials_containertype: "45 Foot High Cube" },
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    )).toThrow(/unsupported/);
    expect(() => validateStorageLifecycleFacts(
      { ...finalisationRecord, cf_potentials_contractorc2: "" },
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    )).toThrow(/driver/);
    expect(() => validateStorageLifecycleFacts(
      { ...finalisationRecord, cf_potentials_actualdateout: "2026-09-30" },
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    )).toThrow(/precedes Date In/);
    expect(() => validateStorageLifecycleFacts(
      { ...finalisationRecord, cf_potentials_storagerequired: "Yes at Destination" },
      "5x484050",
      "origin",
      "cf_potentials_actualdateout",
    )).toThrow(/does not match/);
  });
});
