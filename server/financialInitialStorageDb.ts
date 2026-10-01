import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { financialInitialStorageEvents, type FinancialInitialStorageEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { storageSuffix, type StorageLocation } from "./financialStorageDrafts";

export type StorageDraftReceipt = { documentType: "customer_invoice" | "jd_transport" | "gd_storage"; number: string; xeroId: string; status: "DRAFT"; readBackAt: string };
export function storedStorageReceipts(row: FinancialInitialStorageEvent): StorageDraftReceipt[] {
  return Array.isArray(row.documentResults) ? row.documentResults.filter((value): value is StorageDraftReceipt => Boolean(value && typeof value === "object" && typeof value.number === "string" && typeof value.xeroId === "string")) : [];
}

export async function reserveInitialStorageEvent(input: {
  dealId: string; dealNumber: string; location: StorageLocation; periodStart: string; periodEnd: string;
  containerNumber: string; containerType: string; sourceHash: string;
}): Promise<{ event: FinancialInitialStorageEvent; existing: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("AP storage ledger is unavailable.");
  const key = and(eq(financialInitialStorageEvents.dealId, input.dealId), eq(financialInitialStorageEvents.location, input.location), eq(financialInitialStorageEvents.periodStart, input.periodStart));
  const existing = (await db.select().from(financialInitialStorageEvents).where(key).limit(1))[0];
  if (existing) return { event: existing, existing: true };
  // A separate DB unique key serializes Deal/suffix reservations, even when two
  // different location webhooks arrive concurrently. A conflict retries only
  // another suffix; the identity unique key keeps a replay on the same event.
  for (let index = 0; index < 25; index += 1) {
    const suffix = storageSuffix(index);
    try {
      await db.insert(financialInitialStorageEvents).values({ ...input, suffix, status: "held" });
      const event = (await db.select().from(financialInitialStorageEvents).where(key).limit(1))[0];
      if (!event) throw new Error("AP storage reservation could not be verified.");
      return { event, existing: false };
    } catch (error: any) {
      if (error?.code !== "ER_DUP_ENTRY" && error?.errno !== 1062 && !/Duplicate entry|unique constraint/i.test(String(error?.message))) throw error;
      const duplicate = (await db.select().from(financialInitialStorageEvents).where(key).limit(1))[0];
      if (duplicate) return { event: duplicate, existing: true };
    }
  }
  throw new Error("All safe storage invoice suffixes for this Deal have been reserved.");
}

export async function updateInitialStorageEvent(input: {
  id: number;
  status: FinancialInitialStorageEvent["status"];
  receipts?: StorageDraftReceipt[];
  errorMessage?: string | null;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP storage ledger is unavailable.");
  await db.update(financialInitialStorageEvents).set({
    status: input.status,
    ...(input.receipts ? { documentResults: input.receipts } : {}),
    errorMessage: input.errorMessage ?? null,
    completedAt: input.status === "drafts_created" ? new Date() : null,
  }).where(eq(financialInitialStorageEvents.id, input.id));
}

/** Only one request may enter the Xero transport for a reserved Deal/location/period. */
export async function claimInitialStorageEvent(id: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("AP storage ledger is unavailable.");
  const result: any = await db.update(financialInitialStorageEvents).set({
    status: "reserved", retryCount: sql`${financialInitialStorageEvents.retryCount} + 1`,
  }).where(and(eq(financialInitialStorageEvents.id, id), inArray(financialInitialStorageEvents.status, ["held", "failed", "partial"])));
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}

/** An internal writer cannot arm itself by supplying a synthetic storage pilot ID. */
export async function verifyInitialStoragePilotWriteAccess(input: {
  eventId: number; approvalReference: string; documentNumber: string; preparedBy: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP storage approval ledger is unavailable.");
  const event = (await db.select().from(financialInitialStorageEvents).where(eq(financialInitialStorageEvents.id, input.eventId)).limit(1))[0];
  if (!event || event.status !== "reserved" || event.pilotApprovalKey !== input.approvalReference ||
    !event.approvedBy || event.approvedBy !== input.preparedBy || !event.legacyHandoffConfirmedAt ||
    !event.approvalExpiresAt || event.approvalExpiresAt.getTime() <= Date.now() ||
    !/^[a-f0-9]{64}$/i.test(event.sourceHash) || !/^[a-f0-9]{64}$/i.test(event.approvedDocumentsHash ?? "") ||
    !/^[a-f0-9]{64}$/i.test(event.approvedPreflightHash ?? "")) {
    throw new Error("Stored exact loaded-storage pilot approval, source and preflight evidence are not valid.");
  }
  const digits = event.dealNumber.match(/^D(\d+)$/)?.[1];
  if (!digits) throw new Error("Stored storage Deal number is invalid.");
  const poSuffix = event.suffix === "A" ? "" : `-${event.suffix}`;
  if (![ `INV-${digits}-${event.suffix}`, `JD${digits}${poSuffix}`, `GD${digits}${poSuffix}` ].includes(input.documentNumber)) {
    throw new Error("Draft document does not match the named storage Deal and reserved suffix.");
  }
}

export async function listInitialStorageEvents(limit = 50): Promise<FinancialInitialStorageEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialInitialStorageEvents).orderBy(desc(financialInitialStorageEvents.receivedAt), desc(financialInitialStorageEvents.id)).limit(Math.max(1, Math.min(limit, 100)));
}

/** GET-only ledger lookup for a single named Deal; does not claim or consume a suffix. */
export async function previewInitialStorageReservation(dealId: string, location: StorageLocation, periodStart: string) {
  const db = await getDb();
  if (!db) throw new Error("AP storage ledger is unavailable.");
  const rows = await db.select().from(financialInitialStorageEvents).where(eq(financialInitialStorageEvents.dealId, dealId)).limit(26);
  const existing = rows.find(row => row.location === location && row.periodStart === periodStart) ?? null;
  if (existing) return { suffix: existing.suffix, existing };
  const used = new Set(rows.map(row => row.suffix));
  for (let index = 0; index < 25; index += 1) {
    const suffix = storageSuffix(index);
    if (!used.has(suffix)) return { suffix, existing: null };
  }
  throw new Error("All safe storage suffixes for this Deal have been reserved.");
}
