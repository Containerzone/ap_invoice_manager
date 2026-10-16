import { inArray } from "drizzle-orm";
import {
  financialAssetPurchasePoEvents,
  financialCustomerSalePurchasePoEvents,
  financialDepositInvoiceEvents,
  financialExtraHireInvoiceEvents,
  financialFinalWeightAdjustmentEvents,
  financialForHirePoEvents,
  financialMainCustomerInvoiceEvents,
  financialWarrantyAvisoEvents,
} from "../drizzle/schema";
import { getDb } from "./db";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";

export type VtigerDisplayReference = {
  recordId: string;
  businessNumber: string | null;
};

const DEAL_RECORD_ID_PATTERN = /^5x\d{1,12}$/i;
const CONTAINER_CONTROL_RECORD_ID_PATTERN = /^79x\d{1,12}$/i;
const DEAL_NUMBER_PATTERN = /^D\d{1,12}$/i;
const CONTAINER_CONTROL_NUMBER_PATTERN = /^C\d{1,12}$/i;
const MAX_RECORD_IDS = 50;
const MAX_CACHE_ENTRIES = 1_000;
const SUCCESS_CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 30_000;

type BusinessNumber = string | null;
type StoredReference = { recordId: string | null; businessNumber: string | null };
type StoredReferenceState = { numbers: Set<string>; invalid: boolean };
type CacheEntry = { businessNumber: BusinessNumber; expiresAt: number };

/**
 * This cache applies only to exact read-only VTiger fallback requests. Persisted
 * ledger mappings are re-read on every request so newly-conflicting local data
 * is never concealed by an in-memory cache entry.
 */
const upstreamCache = new Map<string, CacheEntry>();
const inFlightUpstreamLookups = new Map<string, Promise<BusinessNumber>>();

// Module-wide semaphore: all resolver instances share at most two VTiger GETs.
// A released slot is transferred directly to the next waiter, rather than being
// made generally available between the release and the waiter's continuation.
let activeVtigerReads = 0;
const waitingForVtigerRead: Array<() => void> = [];

function normalizeRecordId(recordId: string): string | null {
  if (!DEAL_RECORD_ID_PATTERN.test(recordId) && !CONTAINER_CONTROL_RECORD_ID_PATTERN.test(recordId)) return null;
  return recordId.replace(/x/i, "x");
}

function expectedBusinessNumberPattern(recordId: string): RegExp {
  return recordId.startsWith("5x") ? DEAL_NUMBER_PATTERN : CONTAINER_CONTROL_NUMBER_PATTERN;
}

function normaliseBusinessNumber(recordId: string, value: unknown): string | null {
  if (typeof value !== "string" || !expectedBusinessNumberPattern(recordId).test(value)) return null;
  return value.toUpperCase();
}

function getCachedUpstreamReference(recordId: string): BusinessNumber | undefined {
  const cached = upstreamCache.get(recordId);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    upstreamCache.delete(recordId);
    return undefined;
  }
  return cached.businessNumber;
}

function cacheUpstreamReference(recordId: string, businessNumber: BusinessNumber): void {
  upstreamCache.delete(recordId);
  while (upstreamCache.size >= MAX_CACHE_ENTRIES) {
    const oldestRecordId = upstreamCache.keys().next().value as string | undefined;
    if (!oldestRecordId) break;
    upstreamCache.delete(oldestRecordId);
  }
  upstreamCache.set(recordId, {
    businessNumber,
    expiresAt: Date.now() + (businessNumber ? SUCCESS_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
  });
}

async function withVtigerReadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeVtigerReads < 2) {
    activeVtigerReads += 1;
  } else {
    await new Promise<void>((resolve) => waitingForVtigerRead.push(resolve));
  }
  try {
    return await work();
  } finally {
    const nextWaiter = waitingForVtigerRead.shift();
    if (nextWaiter) nextWaiter();
    else activeVtigerReads -= 1;
  }
}

async function resolveExactUpstreamReference(recordId: string): Promise<BusinessNumber> {
  const cached = getCachedUpstreamReference(recordId);
  if (cached !== undefined) return cached;

  const existing = inFlightUpstreamLookups.get(recordId);
  if (existing) return existing;

  const lookup = withVtigerReadSlot(async (): Promise<BusinessNumber> => {
    let businessNumber: BusinessNumber = null;
    try {
      const current = await retrieveCurrentVtigerFinancialRecord(recordId);
      const returnedRecordId = typeof current.id === "string" ? normalizeRecordId(current.id) : null;
      if (returnedRecordId === recordId) {
        const fieldName = recordId.startsWith("5x") ? "potential_no" : "vtcmcontainercontrolsnumber";
        businessNumber = normaliseBusinessNumber(recordId, current[fieldName]);
      }
    } catch {
      // A display projection must not leak upstream errors or credentials.
      businessNumber = null;
    }
    cacheUpstreamReference(recordId, businessNumber);
    return businessNumber;
  }).finally(() => {
    inFlightUpstreamLookups.delete(recordId);
  });

  inFlightUpstreamLookups.set(recordId, lookup);
  return lookup;
}

function addStoredReference(
  destination: Map<string, StoredReferenceState>,
  requestedRecordIds: ReadonlySet<string>,
  references: StoredReference[],
): void {
  for (const reference of references) {
    if (typeof reference.recordId !== "string") continue;
    const recordId = normalizeRecordId(reference.recordId);
    if (!recordId || !requestedRecordIds.has(recordId)) continue;
    const state = destination.get(recordId) ?? { numbers: new Set<string>(), invalid: false };
    // Older held rows can legitimately lack a captured business number. That is
    // absence of evidence, not a conflict with another persisted pair.
    if (reference.businessNumber === null || reference.businessNumber === "") continue;
    const businessNumber = normaliseBusinessNumber(recordId, reference.businessNumber);
    if (businessNumber) state.numbers.add(businessNumber);
    else state.invalid = true;
    destination.set(recordId, state);
  }
}

/**
 * Reads only requested IDs from the event tables that actually persist an
 * authoritative D/C business-number pair. `storageBillingEvents` is excluded:
 * its schema has raw record IDs but no D/C business-number column, so it cannot
 * safely contribute a display mapping.
 */
async function findPersistedReferences(recordIds: readonly string[]): Promise<Map<string, StoredReferenceState>> {
  const db = await getDb();
  const stored = new Map<string, StoredReferenceState>();
  if (!db) return stored;

  const requestedRecordIds = new Set(recordIds);
  const dealIds = recordIds.filter((recordId) => recordId.startsWith("5x"));
  const containerControlIds = recordIds.filter((recordId) => recordId.startsWith("79x"));
  const queries: Array<Promise<StoredReference[]>> = [];

  if (dealIds.length > 0) {
    queries.push(
      db.select({ recordId: financialMainCustomerInvoiceEvents.dealId, businessNumber: financialMainCustomerInvoiceEvents.dealNumber })
        .from(financialMainCustomerInvoiceEvents)
        .where(inArray(financialMainCustomerInvoiceEvents.dealId, dealIds)),
      db.select({ recordId: financialDepositInvoiceEvents.dealId, businessNumber: financialDepositInvoiceEvents.dealNumber })
        .from(financialDepositInvoiceEvents)
        .where(inArray(financialDepositInvoiceEvents.dealId, dealIds)),
      db.select({ recordId: financialFinalWeightAdjustmentEvents.dealId, businessNumber: financialFinalWeightAdjustmentEvents.dealNumber })
        .from(financialFinalWeightAdjustmentEvents)
        .where(inArray(financialFinalWeightAdjustmentEvents.dealId, dealIds)),
      db.select({ recordId: financialExtraHireInvoiceEvents.dealId, businessNumber: financialExtraHireInvoiceEvents.dealNumber })
        .from(financialExtraHireInvoiceEvents)
        .where(inArray(financialExtraHireInvoiceEvents.dealId, dealIds)),
      db.select({ recordId: financialWarrantyAvisoEvents.dealId, businessNumber: financialWarrantyAvisoEvents.dealNumber })
        .from(financialWarrantyAvisoEvents)
        .where(inArray(financialWarrantyAvisoEvents.dealId, dealIds)),
    );
  }

  if (containerControlIds.length > 0) {
    queries.push(
      db.select({ recordId: financialForHirePoEvents.containerControlId, businessNumber: financialForHirePoEvents.containerControlNumber })
        .from(financialForHirePoEvents)
        .where(inArray(financialForHirePoEvents.containerControlId, containerControlIds)),
      db.select({ recordId: financialAssetPurchasePoEvents.containerControlId, businessNumber: financialAssetPurchasePoEvents.containerControlNumber })
        .from(financialAssetPurchasePoEvents)
        .where(inArray(financialAssetPurchasePoEvents.containerControlId, containerControlIds)),
      db.select({ recordId: financialCustomerSalePurchasePoEvents.containerControlId, businessNumber: financialCustomerSalePurchasePoEvents.containerControlNumber })
        .from(financialCustomerSalePurchasePoEvents)
        .where(inArray(financialCustomerSalePurchasePoEvents.containerControlId, containerControlIds)),
    );
  }

  const queryResults = await Promise.allSettled(queries);
  for (const queryResult of queryResults) {
    if (queryResult.status === "fulfilled") {
      addStoredReference(stored, requestedRecordIds, queryResult.value);
    }
  }
  return stored;
}

/**
 * Resolves only VTiger Deal (5x…) and Container Control (79x…) technical IDs to
 * their authoritative D/C business numbers. It is read-only and intentionally
 * never derives a number from the numeric suffix of a record ID.
 */
export async function resolveVtigerDisplayReferences(recordIds: string[]): Promise<VtigerDisplayReference[]> {
  if (recordIds.length > MAX_RECORD_IDS) throw new Error(`At most ${MAX_RECORD_IDS} VTiger record IDs may be resolved at once.`);

  const normalizedRecordIds: string[] = [];
  const seen = new Set<string>();
  for (const suppliedRecordId of recordIds) {
    const recordId = typeof suppliedRecordId === "string" ? normalizeRecordId(suppliedRecordId) : null;
    if (!recordId) throw new Error("VTiger display references accept only 5x… or 79x… record IDs.");
    if (!seen.has(recordId)) {
      seen.add(recordId);
      normalizedRecordIds.push(recordId);
    }
  }

  if (normalizedRecordIds.length === 0) return [];

  const persisted = await findPersistedReferences(normalizedRecordIds);
  const results = new Map<string, BusinessNumber>();
  const unresolved: string[] = [];

  for (const recordId of normalizedRecordIds) {
    const storedReference = persisted.get(recordId);
    if (!storedReference) {
      unresolved.push(recordId);
    } else if (!storedReference.invalid && storedReference.numbers.size === 1) {
      results.set(recordId, storedReference.numbers.values().next().value as string);
    } else {
      // Local ledgers disagree or have an invalid pair. Do not choose a value or
      // conceal an authoritative-data problem with a CRM fallback.
      results.set(recordId, null);
    }
  }

  const upstreamResults = await Promise.all(unresolved.map(async (recordId) => [recordId, await resolveExactUpstreamReference(recordId)] as const));
  for (const [recordId, businessNumber] of upstreamResults) results.set(recordId, businessNumber);

  return normalizedRecordIds.map((recordId) => ({ recordId, businessNumber: results.get(recordId) ?? null }));
}
