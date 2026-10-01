import type { ProposedFinancialDocument, FinancialLineItem } from "./financialWorkflowEngine";
import { Temporal } from "@js-temporal/polyfill";

export type StorageLocation = "origin" | "destination";
export type StorageParty = { name: string; vtigerId: string; email: string | null };
export type StorageDeal = {
  dealId: string;
  dealNumber: string;
  location: StorageLocation;
  containerNumber: string;
  containerType: "20 Foot Standard" | "20 Foot High Cube" | "40 Foot Standard" | "40 Foot High Cube";
  dateIn: string;
  deliveryDate: string | null;
  customer: StorageParty;
  driver: StorageParty;
  storageSupplier: StorageParty;
};
export type StoragePeriod = { start: string; end: string; days: number };

const STAGES: Record<string, StorageLocation> = {
  "4 STORAGE at ORIGIN": "origin",
  "11 STORAGE at DEST": "destination",
};
const STORAGE_TYPES = ["20 Foot Standard", "20 Foot High Cube", "40 Foot Standard", "40 Foot High Cube"] as const;
const SUFFIXES = "ABCEFGHIJKLMNOPQRSTUVWXYZ";
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function validId(value: string): boolean { return /^\d+x\d+$/.test(value); }
function businessDate(value: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Storage date must be a valid YYYY-MM-DD business date.");
  try { return Temporal.PlainDate.from(value, { overflow: "reject" }); }
  catch { throw new Error("Storage date is invalid."); }
}
function xeroBusinessDate(value: string): Date { return new Date(`${businessDate(value).toString()}T00:00:00.000Z`); }
function money(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }

/** Inclusive Sydney calendar-day convention: Date In and final day are both chargeable. */
export function firstStoragePeriod(dateIn: string, deliveryDate: string | null): StoragePeriod {
  // VTiger Date In is a Sydney business date, not a UTC instant. PlainDate
  // preserves its calendar day through daylight-saving transitions.
  const start = businessDate(dateIn);
  const monthEnd = start.with({ day: 1 }).add({ months: 1 }).subtract({ days: 1 });
  let end = monthEnd.since(start, { largestUnit: "days" }).days + 1 < 7
    ? monthEnd.add({ days: 1, months: 1 }).subtract({ days: 1 })
    : monthEnd;
  if (deliveryDate) {
    const delivery = businessDate(deliveryDate);
    if (Temporal.PlainDate.compare(delivery, end) < 0) end = delivery;
  }
  if (Temporal.PlainDate.compare(end, start) < 0) throw new Error("Storage delivery date precedes Date In.");
  return { start: start.toString(), end: end.toString(), days: start.until(end, { largestUnit: "days" }).days + 1 };
}

/** Deal fields were verified against authenticated VTiger `describe Potentials` on 1 October 2026. */
export function validateLoadedStorageDeal(raw: Record<string, unknown>, requestedRecordId: string): {
  location: StorageLocation;
  dealNumber: string;
  containerNumber: string;
  containerType: StorageDeal["containerType"];
  dateIn: string;
  deliveryDate: string | null;
  customerId: string;
  driverId: string;
} {
  if (!validId(requestedRecordId) || text(raw.id) !== requestedRecordId || !requestedRecordId.startsWith("5x")) throw new Error("Storage webhook must identify one retrieved Potentials Deal.");
  const stage = text(raw.sales_stage);
  const location = STAGES[stage];
  if (!location) throw new Error("Deal is not in an exact loaded-storage stage.");
  const storageRequired = text(raw.cf_potentials_storagerequired);
  if (storageRequired !== (location === "origin" ? "Yes at Origin" : "Yes at Destination")) throw new Error("Deal Storage Required does not match the exact storage stage.");
  const dealNumber = text(raw.potential_no);
  if (!/^D\d+$/.test(dealNumber)) throw new Error("Deal has no valid D-prefixed Deal ID.");
  const containerNumber = text(raw.potentialname);
  if (!containerNumber) throw new Error("Deal container number is missing.");
  const containerType = text(raw.cf_potentials_containertype);
  if (!STORAGE_TYPES.includes(containerType as StorageDeal["containerType"])) throw new Error("Storage container type is unsupported.");
  const dateIn = text(raw.cf_potentials_datein);
  businessDate(dateIn);
  const deliveryDate = text(raw.cf_potentials_fullcontainerdeliverydate) || null;
  firstStoragePeriod(dateIn, deliveryDate);
  const organisationId = text(raw.related_to);
  const contactId = text(raw.contact_id);
  const customerId = organisationId || contactId;
  if (!validId(customerId)) throw new Error("Deal has no bill-to organisation or contact.");
  const driverId = text(raw[location === "origin" ? "cf_potentials_contractorc2" : "cf_potentials_fullcontainerdeliveryv"]);
  if (!validId(driverId)) throw new Error("Deal is missing the driver for this storage location.");
  return { location, dealNumber, containerNumber, containerType: containerType as StorageDeal["containerType"], dateIn, deliveryDate, customerId, driverId };
}

/** No arbitrary suffix or deposit suffix D; the DB serializes reservations per deal/suffix. */
export function storageSuffix(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= SUFFIXES.length) throw new Error("No safe storage invoice suffix is available.");
  return SUFFIXES[index];
}

export function buildInitialStorageDrafts(deal: StorageDeal, suffix: string, firstLocation: boolean): {
  documents: [ProposedFinancialDocument, ProposedFinancialDocument, ProposedFinancialDocument];
  period: StoragePeriod;
} {
  if (!SUFFIXES.includes(suffix) || suffix.length !== 1) throw new Error("Storage suffix is invalid or reserved.");
  const period = firstStoragePeriod(deal.dateIn, deal.deliveryDate);
  const digits = deal.dealNumber.slice(1);
  if (!/^\d+$/.test(digits)) throw new Error("Storage Deal number is invalid.");
  const feet = deal.containerType.startsWith("20") ? 20 : 40;
  const weekly = feet === 20 ? 59.09 : 86.36;
  const transportCost = feet === 20 ? 250 : 340.91;
  const prorated = money(weekly * period.days / 7);
  const location = deal.location === "origin" ? "Origin" : "Destination";
  const periodLabel = `${period.start}–${period.end}`;
  const description = `container storage — ${deal.containerNumber} — ${location} — ${periodLabel}`;
  const issueDate = xeroBusinessDate(period.start);
  const dueDate = xeroBusinessDate(businessDate(period.start).add({ days: 1 }).toString());
  const reference = `${deal.dealNumber} · ${location} Storage`;
  const poSuffix = firstLocation ? "" : `-${suffix}`;
  const line = (input: { itemCode: string; description: string; quantity: number; unitAmount: number; accountCode: string }): FinancialLineItem => ({
    ...input, lineAmount: money(input.quantity * input.unitAmount), taxRate: 10, gstTreatment: "GST_EXCLUSIVE",
  });
  const common = { proposedAction: "create_draft" as const, currency: "AUD" as const, gstTreatment: "GST_EXCLUSIVE" as const, issueDate, sourceWorkflow: "storage_activation" as const, sourceRecordId: deal.dealId, validationStatus: "valid" as const };
  const customer: ProposedFinancialDocument = {
    ...common, documentFamily: "customer_invoice", documentType: "storage_activation", proposedDocumentNumber: `INV-${digits}-${suffix}`,
    reference, partyName: deal.customer.name, partySourceId: null, accountCode: "200", dueDate,
    subtotal: prorated, taxAmount: money(prorated * 0.1), total: money(prorated * 1.1),
    lineItems: [line({ itemCode: "", description, quantity: 1, unitAmount: prorated, accountCode: "200" })],
  };
  const transport: ProposedFinancialDocument = {
    ...common, documentFamily: "purchase_order", documentType: "jd_transport", proposedDocumentNumber: `JD${digits}${poSuffix}`,
    reference, partyName: deal.driver.name, partySourceId: null, accountCode: "310", dueDate: null,
    subtotal: transportCost, taxAmount: money(transportCost * 0.1), total: money(transportCost * 1.1),
    // Replaced with the exact current Xero JD item description after GET-only preflight.
    lineItems: [line({ itemCode: "JD", description: "", quantity: 1, unitAmount: transportCost, accountCode: "310" })],
  };
  const storage: ProposedFinancialDocument = {
    ...common, documentFamily: "purchase_order", documentType: "gd_storage", proposedDocumentNumber: `GD${digits}${poSuffix}`,
    reference, partyName: deal.storageSupplier.name, partySourceId: null, accountCode: "311", dueDate: null,
    subtotal: prorated, taxAmount: money(prorated * 0.1), total: money(prorated * 1.1),
    lineItems: [line({ itemCode: "", description, quantity: 1, unitAmount: prorated, accountCode: "311" })],
  };
  return { period, documents: [customer, transport, storage] };
}
