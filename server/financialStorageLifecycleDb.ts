import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { financialInitialStorageEvents, financialWriterExecutions, workflowSchedules, type FinancialInitialStorageEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { reserveInitialStorageEvent } from "./financialInitialStorageDb";
import { assertStorageRelease, getStorageReleasePolicy } from "./financialStorageRelease";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { createHash } from "node:crypto";

export function storagePayloadHash(payload: FinancialDraftPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
export async function storagePriorExecution(payload: FinancialDraftPayload) {
  const db = await getDb(); if (!db) throw new Error("AP storage execution ledger unavailable.");
  return (await db.select().from(financialWriterExecutions).where(eq(financialWriterExecutions.idempotencyKey, payload.idempotencyKey)).limit(1))[0] ?? null;
}
/** After publish and explicit cutover only. Does not create, run or alter a Heartbeat job itself. */
export async function bindApprovedStorageSchedule(taskUid: string, approvedBy: number) {
  const policy = await getStorageReleasePolicy(); assertStorageRelease(policy, "recurring");
  if (!taskUid.trim() || policy.approvedBy !== approvedBy) throw new Error("Approved storage schedule must be bound to its exact returned task UID and approver.");
  const db = await getDb(); if (!db) throw new Error("AP schedule ledger unavailable.");
  const values = { workflowType: "recurring_storage", taskUid, enabled: true, cronExpression: "0 5 13 * * *", lastOutcome: "approved_storage_release", auditData: { releaseKey: policy.releaseKey, approvedBy } };
  await db.insert(workflowSchedules).values(values).onDuplicateKeyUpdate({ set: { ...values, updatedAt: new Date() } });
}
export async function storagePeriods(dealId: string, location?: "origin" | "destination") {
  const db = await getDb(); if (!db) throw new Error("AP storage ledger unavailable.");
  return db.select().from(financialInitialStorageEvents).where(location ? and(eq(financialInitialStorageEvents.dealId, dealId), eq(financialInitialStorageEvents.location, location)) : eq(financialInitialStorageEvents.dealId, dealId)).orderBy(asc(financialInitialStorageEvents.periodStart)).limit(100);
}
export async function activeStorageRoots(limit = 10, dueDate?: string) {
  const db = await getDb(); if (!db) throw new Error("AP storage ledger unavailable.");
  return db.select().from(financialInitialStorageEvents).where(and(isNull(financialInitialStorageEvents.parentEventId), isNull(financialInitialStorageEvents.finalisedAt),
    dueDate ? eq(financialInitialStorageEvents.nextBillingDate, dueDate) : undefined,
    sql`${financialInitialStorageEvents.status} in ('drafts_created', 'writeback_pending')`)).orderBy(asc(financialInitialStorageEvents.nextBillingDate), asc(financialInitialStorageEvents.id)).limit(Math.min(limit, 50));
}
export async function patchStoragePeriod(id: number, patch: Partial<typeof financialInitialStorageEvents.$inferInsert>) {
  const db = await getDb(); if (!db) throw new Error("AP storage ledger unavailable.");
  await db.update(financialInitialStorageEvents).set(patch).where(eq(financialInitialStorageEvents.id, id));
}
export async function reserveStoragePeriod(input: Parameters<typeof reserveInitialStorageEvent>[0], kind: "initial" | "recurring" | "recovery", parentEventId?: number) {
  const result = await reserveInitialStorageEvent(input);
  if (!result.existing) { await patchStoragePeriod(result.event.id, { eventKind: kind, parentEventId: parentEventId ?? null }); result.event.eventKind = kind; result.event.parentEventId = parentEventId ?? null; }
  if (result.event.eventKind !== kind) throw new Error("Existing storage period belongs to a different lifecycle operation.");
  return result.event;
}
export async function claimStorageRoot(id: number, token: string) {
  const db = await getDb(); if (!db) throw new Error("AP storage ledger unavailable.");
  const result: any = await db.update(financialInitialStorageEvents).set({ processingToken: token }).where(and(eq(financialInitialStorageEvents.id, id), isNull(financialInitialStorageEvents.processingToken), isNull(financialInitialStorageEvents.finalisedAt)));
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}
export async function releaseStorageRoot(id: number, token: string) {
  const db = await getDb(); if (!db) throw new Error("AP storage ledger unavailable.");
  await db.update(financialInitialStorageEvents).set({ processingToken: null }).where(and(eq(financialInitialStorageEvents.id, id), eq(financialInitialStorageEvents.processingToken, token)));
}
export async function bindStoragePayloads(eventId: number, releaseKey: string, payloads: FinancialDraftPayload[], mode: string) {
  await patchStoragePeriod(eventId, { releaseKey, authorisedPayloads: payloads.map(payload => ({ hash: storagePayloadHash(payload), number: payload.documentNumber, mode })) });
}
/** Transport rechecks persisted exact payload hashes and current release at every request. */
export async function verifyStorageAutomaticWriteAccess(input: { eventId: number; releaseKey: string; payload: FinancialDraftPayload; workflowType: string; preparedBy: number }) {
  if (!["storage_activation", "recurring_storage", "storage_finalisation"].includes(input.workflowType)) throw new Error("Unrelated workflow cannot use storage payload authorisation.");
  const db = await getDb(); if (!db) throw new Error("AP storage ledger unavailable.");
  const event = (await db.select().from(financialInitialStorageEvents).where(eq(financialInitialStorageEvents.id, input.eventId)).limit(1))[0];
  const kind = input.workflowType === "storage_finalisation" ? "finalisation" : event?.eventKind ?? "initial";
  const policy = await getStorageReleasePolicy(); assertStorageRelease(policy, kind);
  if (!event || event.status !== "reserved" || input.releaseKey !== policy.releaseKey || event.releaseKey !== policy.releaseKey || input.preparedBy !== policy.approvedBy) throw new Error("Storage event has no current release-backed exclusive claim.");
  const allowed = Array.isArray(event.authorisedPayloads) ? event.authorisedPayloads as Array<{hash:string;number:string;mode:string}> : [];
  if (!allowed.some(v => v.hash === storagePayloadHash(input.payload) && v.number === input.payload.documentNumber && v.mode === input.workflowType)) throw new Error("Storage payload differs from the exact persisted preflight.");
  if (input.payload.method === "PUT" && (kind !== "finalisation" || !input.payload.expectedXeroDocumentId)) throw new Error("Only finalisation can amend an exact existing storage Draft.");
}
