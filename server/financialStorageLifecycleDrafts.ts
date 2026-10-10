import { Temporal } from "@js-temporal/polyfill";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import {
  buildInitialStorageDrafts,
  validateLoadedStorageDeal,
} from "./financialStorageDrafts";
import type {
  StorageDeal,
  StorageLocation,
  StoragePeriod,
} from "./financialStorageDrafts";

export type { StorageDeal, StorageLocation, StoragePeriod } from "./financialStorageDrafts";

/**
 * Facts shared by a loaded-storage event and its later recurring/finalisation
 * lifecycle. `dateOut` is intentionally separate from `deliveryDate`: the
 * latter is the verified Full Container Delivery Date; the former is read only
 * from the explicitly supplied, verified final-date field (with that delivery
 * date as the documented fallback).
 */
export type StorageLifecycleFacts = {
  location: StorageLocation;
  dealNumber: string;
  containerNumber: string;
  containerType: StorageDeal["containerType"];
  dateIn: string;
  deliveryDate: string | null;
  customerId: string;
  driverId: string;
  dateOut: string | null;
};

const STORAGE_STAGE_BY_LOCATION: Record<StorageLocation, string> = {
  origin: "4 STORAGE at ORIGIN",
  destination: "11 STORAGE at DEST",
};
const STORAGE_TYPES: readonly StorageDeal["containerType"][] = [
  "20 Foot Standard",
  "20 Foot High Cube",
  "40 Foot Standard",
  "40 Foot High Cube",
];

function businessDate(value: string): Temporal.PlainDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Storage date must be a valid YYYY-MM-DD business date.");
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    throw new Error("Storage date is invalid.");
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inclusivePeriod(start: Temporal.PlainDate, end: Temporal.PlainDate): StoragePeriod {
  if (Temporal.PlainDate.compare(end, start) < 0) {
    throw new Error("Storage end date precedes period start.");
  }
  return {
    start: start.toString(),
    end: end.toString(),
    days: start.until(end, { largestUnit: "days" }).days + 1,
  };
}

/**
 * The next monthly storage period after an already-billed Sydney business day.
 * Unlike the initial storage period, this never applies the initial <7-day
 * extension rule: it runs from the next day through that calendar month's end.
 */
export function recurringStoragePeriod(billedThrough: string, deliveryDate: string | null): StoragePeriod {
  const start = businessDate(billedThrough).add({ days: 1 });
  let end = start.with({ day: 1 }).add({ months: 1 }).subtract({ days: 1 });

  if (deliveryDate) {
    const delivery = businessDate(deliveryDate);
    if (Temporal.PlainDate.compare(delivery, end) < 0) end = delivery;
  }

  return inclusivePeriod(start, end);
}

type LifecycleAction = "create_draft" | "update_draft";
type LifecycleWorkflow = "recurring_storage" | "storage_finalisation";

/**
 * Reuses the established initial-storage builder for validated numbering,
 * rates, tax and line descriptions, then deliberately excludes the one-time
 * JD transport PO. `firstLocation` controls the established GD number shape.
 */
function buildPeriodStorageDrafts(
  deal: StorageDeal,
  suffix: string,
  firstLocation: boolean,
  period: StoragePeriod,
  proposedAction: LifecycleAction,
  sourceWorkflow: LifecycleWorkflow,
): ProposedFinancialDocument[] {
  // A lifecycle builder must not accept a malformed source deal simply because
  // its period dates are valid. The initial builder validates the remaining
  // deal number, suffix and container-type rules below.
  businessDate(deal.dateIn);
  if (!STORAGE_TYPES.includes(deal.containerType)) {
    throw new Error("Storage container type is unsupported.");
  }

  const { documents } = buildInitialStorageDrafts(
    {
      ...deal,
      // Feeding the precise billed period through the initial builder preserves
      // its tested inclusive pro-rata and financial-line conventions. Its
      // initial short-period extension is harmless because this end date caps
      // the generated period exactly at `period.end`.
      dateIn: period.start,
      deliveryDate: period.end,
    },
    suffix,
    firstLocation,
  );
  const [customer, , storage] = documents;

  return [
    {
      ...customer,
      documentType: sourceWorkflow === "recurring_storage" ? "recurring_storage" : "storage_finalisation",
      proposedAction,
      sourceWorkflow,
    },
    {
      ...storage,
      documentType: "gd_storage",
      proposedAction,
      sourceWorkflow,
    },
  ];
}

/**
 * Proposes the next monthly customer invoice and storage-supplier PO only.
 * Recurring GD POs always carry the location suffix, including suffix A, so
 * they cannot collide with an initial first-location GD PO.
 */
export function buildRecurringStorageDrafts(
  deal: StorageDeal,
  suffix: string,
  billedThrough: string,
): { documents: ProposedFinancialDocument[]; period: StoragePeriod } {
  const period = recurringStoragePeriod(billedThrough, deal.deliveryDate);
  return {
    period,
    documents: buildPeriodStorageDrafts(deal, suffix, false, period, "create_draft", "recurring_storage"),
  };
}

/**
 * Proposes Draft-only amendments for the current storage period. It makes no
 * JD amendment: transport is a one-time activation cost. Callers bind this
 * pure result to the current/latest event for `periodStart`; this function does
 * not recover, recreate or alter prior periods.
 */
export function buildFinalStorageDrafts(
  deal: StorageDeal,
  suffix: string,
  firstLocation: boolean,
  periodStart: string,
  dateOut: string,
): { documents: ProposedFinancialDocument[]; period: StoragePeriod } {
  const period = inclusivePeriod(businessDate(periodStart), businessDate(dateOut));
  return {
    period,
    documents: buildPeriodStorageDrafts(deal, suffix, firstLocation, period, "update_draft", "storage_finalisation"),
  };
}

/**
 * Validates lifecycle facts against the same verified VTiger loaded-storage
 * mapping as activation, without treating a later finalisation sales stage as
 * an active-storage-stage failure. `dateOutField` is required from the caller's
 * verified field map; this function never guesses a field name. An empty value
 * in that supplied field falls back only to the verified Full Container
 * Delivery Date mapping.
 */
export function validateStorageLifecycleFacts(
  raw: Record<string, unknown>,
  recordId: string,
  location: "origin" | "destination",
  dateOutField: string,
): StorageLifecycleFacts {
  if (location !== "origin" && location !== "destination") {
    throw new Error("Storage lifecycle location must be origin or destination.");
  }
  const verifiedDateOutField = text(dateOutField);
  if (!verifiedDateOutField) {
    throw new Error("A verified dateOutField must be supplied for storage finalisation.");
  }

  // Only the stage is reconstructed. The underlying validator still checks the
  // original storage-required value, deal identity, container, Date In,
  // customer and location-specific driver mappings exactly as for activation.
  const loaded = validateLoadedStorageDeal(
    { ...raw, sales_stage: STORAGE_STAGE_BY_LOCATION[location] },
    recordId,
  );

  const dateOut = text(raw[verifiedDateOutField]) || text(raw.cf_potentials_fullcontainerdeliverydate) || null;
  if (dateOut) {
    const finalDate = businessDate(dateOut);
    if (Temporal.PlainDate.compare(finalDate, businessDate(loaded.dateIn)) < 0) {
      throw new Error("Storage final date precedes Date In.");
    }
  }

  return { ...loaded, dateOut };
}
