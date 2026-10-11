import { and, desc, eq } from "drizzle-orm";
import { financialForHirePoEvents, type FinancialForHirePoEvent } from "../drizzle/schema";
import { getDb } from "./db";

export type ForHireEventKind = "initial" | "recurring";
export type ForHireEventStatus = "previewed" | "held" | "reserved" | "drafts_created" | "reconciliation_required" | "dehired";

export async function getForHirePoEvents(limit = 100): Promise<FinancialForHirePoEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialForHirePoEvents)
    .orderBy(desc(financialForHirePoEvents.updatedAt), desc(financialForHirePoEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}

export async function getForHireEventsForControl(containerControlId: string): Promise<FinancialForHirePoEvent[]> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  return db.select().from(financialForHirePoEvents)
    .where(eq(financialForHirePoEvents.containerControlId, containerControlId))
    .orderBy(desc(financialForHirePoEvents.billingPeriodEnd), desc(financialForHirePoEvents.id));
}

/** Exact AP-local lookup only; historical Operations POs are never imported. */
export async function getForHireEventForPeriod(input: {
  containerControlId: string;
  eventKind: ForHireEventKind;
  billingPeriodStart: string;
}): Promise<FinancialForHirePoEvent | null> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  return (await db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.containerControlId, input.containerControlId),
    eq(financialForHirePoEvents.eventKind, input.eventKind),
    eq(financialForHirePoEvents.billingPeriodStart, input.billingPeriodStart),
  )).limit(1))[0] ?? null;
}

/**
 * Persists a non-writing preview or hold. Its unique identity makes repeated
 * manual previews and a future repeated webhook/schedule callback idempotent.
 */
export async function recordForHirePreview(input: {
  containerControlId: string;
  containerControlNumber: string;
  eventKind: ForHireEventKind;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  proposedPoNumber: string;
  containerNumber: string;
  containerType: string;
  supplierVtigerId: string | null;
  supplierName: string | null;
  sourceRefreshedAt: Date | null;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  proposal: unknown;
  xeroPreflight: unknown;
  status: Extract<ForHireEventStatus, "previewed" | "held" | "dehired">;
  holdReason: string | null;
}): Promise<FinancialForHirePoEvent> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const existing = await getForHireEventForPeriod({
    containerControlId: input.containerControlId,
    eventKind: input.eventKind,
    billingPeriodStart: input.billingPeriodStart,
  });
  if (existing && ["reserved", "drafts_created", "reconciliation_required"].includes(existing.status)) return existing;
  const values = {
    ...input,
    supplierVtigerId: input.supplierVtigerId,
    supplierName: input.supplierName,
    sourceRefreshedAt: input.sourceRefreshedAt,
    proposal: input.proposal as any,
    xeroPreflight: input.xeroPreflight as any,
  };
  await db.insert(financialForHirePoEvents).values(values).onDuplicateKeyUpdate({
    set: { ...values, updatedAt: new Date() },
  });
  const row = await getForHireEventForPeriod({
    containerControlId: input.containerControlId,
    eventKind: input.eventKind,
    billingPeriodStart: input.billingPeriodStart,
  });
  if (!row) throw new Error("AP For Hire preview receipt could not be read back from the local ledger.");
  return row;
}

/** Returns the last exact AP receipt period; it deliberately ignores Operations history. */
export async function lastVerifiedForHirePeriod(containerControlId: string): Promise<{ periodEnd: string; suffix: number | null } | null> {
  const db = await getDb();
  if (!db) throw new Error("AP For Hire lifecycle ledger is unavailable.");
  const rows = await db.select().from(financialForHirePoEvents).where(and(
    eq(financialForHirePoEvents.containerControlId, containerControlId),
    eq(financialForHirePoEvents.status, "drafts_created"),
  )).orderBy(desc(financialForHirePoEvents.billingPeriodEnd), desc(financialForHirePoEvents.id)).limit(30);
  const latest = rows[0];
  if (!latest) return null;
  const match = latest.proposedPoNumber.match(/-(\d+)$/);
  return { periodEnd: latest.billingPeriodEnd, suffix: match ? Number(match[1]) : null };
}
