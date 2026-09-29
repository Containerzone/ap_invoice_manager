import { desc, eq } from "drizzle-orm";
import { financialWebhookEvents, type FinancialWebhookEvent } from "../drizzle/schema";
import { getDb } from "./db";

export type FinancialWebhookEventStatus = "received" | "proposed" | "held" | "paused" | "duplicate" | "rejected" | "failed";

export type CreateFinancialWebhookEvent = {
  eventId: string;
  routeKey: string;
  workflowType: string;
  sourceSystem: "vtiger";
  sourceEntityType: string;
  sourceRecordId: string;
  sourceRecordNumber?: string | null;
  sourceChangedAt?: Date | null;
  payloadFingerprint: string;
  status: FinancialWebhookEventStatus;
  workflowRunId?: number | null;
  safeSummary?: unknown;
  errorMessage?: string | null;
};

export async function getFinancialWebhookEventByEventId(eventId: string): Promise<FinancialWebhookEvent | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  return (await db.select().from(financialWebhookEvents)
    .where(eq(financialWebhookEvents.eventId, eventId)).limit(1))[0];
}

/**
 * Stores local AP webhook evidence only. Duplicate external event IDs preserve
 * their original result and do not produce a second financial workflow run.
 */
export async function createFinancialWebhookEvent(input: CreateFinancialWebhookEvent): Promise<{
  event: FinancialWebhookEvent;
  duplicate: boolean;
}> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const existing = await getFinancialWebhookEventByEventId(input.eventId);
  if (existing) return { event: existing, duplicate: true };
  let result: any;
  try {
    result = await db.insert(financialWebhookEvents).values({
      eventId: input.eventId,
      routeKey: input.routeKey,
      workflowType: input.workflowType,
      sourceSystem: input.sourceSystem,
      sourceEntityType: input.sourceEntityType,
      sourceRecordId: input.sourceRecordId,
      sourceRecordNumber: input.sourceRecordNumber ?? null,
      sourceChangedAt: input.sourceChangedAt ?? null,
      payloadFingerprint: input.payloadFingerprint,
      status: input.status,
      workflowRunId: input.workflowRunId ?? null,
      safeSummary: (input.safeSummary ?? {}) as any,
      errorMessage: input.errorMessage?.slice(0, 6000) ?? null,
      processedAt: new Date(),
    });
  } catch (error: any) {
    // The initial read is only an optimisation. The unique eventId constraint
    // remains the concurrency-safe authority when two deliveries arrive at once.
    if (error?.code === "ER_DUP_ENTRY" || /duplicate/i.test(error?.message ?? "")) {
      const duplicate = await getFinancialWebhookEventByEventId(input.eventId);
      if (duplicate) return { event: duplicate, duplicate: true };
    }
    throw error;
  }
  const id = Number((result[0] as any).insertId);
  const event = (await db.select().from(financialWebhookEvents).where(eq(financialWebhookEvents.id, id)).limit(1))[0];
  if (!event) throw new Error("Failed to persist AP financial webhook event");
  return { event, duplicate: false };
}

export async function getFinancialWebhookEvents(limit = 100): Promise<FinancialWebhookEvent[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(financialWebhookEvents)
    .orderBy(desc(financialWebhookEvents.receivedAt), desc(financialWebhookEvents.id))
    .limit(Math.max(1, Math.min(limit, 250)));
}
