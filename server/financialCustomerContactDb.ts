import { and, desc, eq } from "drizzle-orm";
import { financialCustomerContactEvents, type FinancialCustomerContactEvent } from "../drizzle/schema";
import { getDb } from "./db";
import type { CustomerContactSource } from "./financialCustomerContactService";

function affected(result: any): boolean {
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}

export async function requireFinancialCustomerContactLedger(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("AP customer-contact audit ledger is unavailable.");
}

async function database() {
  const db = await getDb();
  if (!db) throw new Error("AP customer-contact audit ledger is unavailable.");
  return db;
}

export async function getFinancialCustomerContactEvent(eventId: number): Promise<FinancialCustomerContactEvent | null> {
  return (await (await database()).select().from(financialCustomerContactEvents)
    .where(eq(financialCustomerContactEvents.id, eventId)).limit(1))[0] ?? null;
}

/** Administrator-facing, non-secret contact resolution audit list. */
export async function getFinancialCustomerContactEvents(limit = 100): Promise<FinancialCustomerContactEvent[]> {
  return (await database()).select().from(financialCustomerContactEvents)
    .orderBy(desc(financialCustomerContactEvents.updatedAt), desc(financialCustomerContactEvents.id)).limit(limit);
}

export async function reserveFinancialCustomerContactEvent(input: {
  customerKey: string;
  source: CustomerContactSource;
  tenantIdHash: string;
  idempotencyKey: string;
  workflowFamily?: string;
  sourceSummary?: Record<string, unknown>;
  lookupSummary?: Record<string, unknown>;
  outcome?: string;
}): Promise<{ kind: "reserved" | "existing"; event: FinancialCustomerContactEvent }> {
  const db = await database();
  const existing = (await db.select().from(financialCustomerContactEvents)
    .where(eq(financialCustomerContactEvents.customerKey, input.customerKey)).limit(1))[0];
  if (existing) return { kind: "existing", event: existing };
  try {
    const result = await db.insert(financialCustomerContactEvents).values({
      customerKey: input.customerKey,
      workflowFamily: input.workflowFamily ?? null,
      customerVtigerId: input.source.customerVtigerId,
      sourceSummary: input.sourceSummary ?? null,
      sourceSnapshotHash: input.source.sourceSnapshotHash,
      tenantIdHash: input.tenantIdHash,
      idempotencyKey: input.idempotencyKey,
      lookupSummary: input.lookupSummary ?? null,
      outcome: input.outcome ?? null,
      status: "reserved",
    });
    const id = Number((result[0] as any)?.insertId ?? 0);
    const event = id ? await getFinancialCustomerContactEvent(id) : null;
    if (!event) throw new Error("Customer-contact reservation could not be read back.");
    return { kind: "reserved", event };
  } catch (error: any) {
    if (error?.code !== "ER_DUP_ENTRY") throw error;
    const raced = (await db.select().from(financialCustomerContactEvents)
      .where(eq(financialCustomerContactEvents.customerKey, input.customerKey)).limit(1))[0];
    if (!raced) throw new Error("Customer-contact reservation conflict could not be read back.");
    return { kind: "existing", event: raced };
  }
}

export async function completeFinancialCustomerContactEvent(eventId: number, input: {
  status: "matched" | "created";
  xeroContactId: string;
  evidence: Record<string, string>;
  outcome?: string;
}): Promise<void> {
  const db = await database();
  if (!affected(await db.update(financialCustomerContactEvents).set({
    status: input.status,
    xeroContactId: input.xeroContactId,
    evidence: input.evidence,
    outcome: input.outcome ?? null,
    holdReason: null,
    updatedAt: new Date(),
  }).where(and(eq(financialCustomerContactEvents.id, eventId), eq(financialCustomerContactEvents.status, "reserved"))))) {
    throw new Error("Customer-contact result could not be bound to its exclusive reservation.");
  }
}

export async function holdFinancialCustomerContactEvent(eventId: number, reason: string, uncertain = false, outcome?: string): Promise<void> {
  const db = await database();
  await db.update(financialCustomerContactEvents).set({
    status: uncertain ? "reconciliation_required" : "held",
    holdReason: reason.slice(0, 2000),
    outcome: outcome ?? null,
    updatedAt: new Date(),
  }).where(and(eq(financialCustomerContactEvents.id, eventId), eq(financialCustomerContactEvents.status, "reserved")));
}
