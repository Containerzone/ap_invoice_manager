import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  financialBillingPartySyncAudits,
  financialBillingPartySyncEvents,
  financialBillingPartySyncLocks,
  financialD702946DepositMainDeductionRecoveryEvents,
  financialDepositMainDeductionEvents,
  financialFinalWeightAdjustmentEvents,
  financialMainCustomerInvoiceEvents,
  financialWarrantyAvisoEvents,
  financialWriterExecutions,
  type FinancialBillingPartySyncEvent,
  type FinancialBillingPartySyncLock,
} from "../drizzle/schema";
import { getDb } from "./db";

export type BillingPartySyncEventView = FinancialBillingPartySyncEvent & {
  /** Derived only from immutable evidence; the event row itself is never updated. */
  latestAuditOutcome: "updated" | "unchanged" | "not_found" | "held" | "reconciliation_required" | "disabled" | null;
  latestAuditWarning: string | null;
  /** Compatibility fields for generic event UIs. */
  status: "updated" | "unchanged" | "not_found" | "held" | "reconciliation_required" | "disabled" | null;
  holdReason: string | null;
  dealNumber: string | null;
};

async function database() {
  const db = await getDb();
  if (!db) throw new Error("Billing-party sync immutable ledger is unavailable; migration requires separate review/application.");
  return db;
}

export async function getBillingPartySyncEvents(limit = 100): Promise<BillingPartySyncEventView[]> {
  const db = await database();
  const events = await db.select().from(financialBillingPartySyncEvents)
    .orderBy(desc(financialBillingPartySyncEvents.createdAt), desc(financialBillingPartySyncEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)));
  return Promise.all(events.map(async event => {
    const audit = (await db.select().from(financialBillingPartySyncAudits)
      .where(eq(financialBillingPartySyncAudits.eventFingerprint, event.eventFingerprint))
      .orderBy(desc(financialBillingPartySyncAudits.createdAt), desc(financialBillingPartySyncAudits.id)).limit(1))[0] ?? null;
    const details = audit?.details && typeof audit.details === "object" && !Array.isArray(audit.details)
      ? audit.details as Record<string, unknown> : {};
    const snapshot = event.sourceSnapshot && typeof event.sourceSnapshot === "object" && !Array.isArray(event.sourceSnapshot)
      ? event.sourceSnapshot as Record<string, unknown> : {};
    const warning = typeof details.warning === "string" ? details.warning : null;
    return {
      ...event,
      latestAuditOutcome: audit?.outcome ?? null,
      latestAuditWarning: warning,
      status: audit?.outcome ?? null,
      holdReason: warning,
      dealNumber: typeof snapshot.dealNumber === "string" ? snapshot.dealNumber : null,
    };
  }));
}

/** Read-only guard for collaborating writers; an explicit own event can be excluded. */
export async function getBillingPartySyncPendingInvoiceLock(xeroInvoiceId: string, excludeEventFingerprint?: string): Promise<FinancialBillingPartySyncLock | null> {
  const conditions = [
    eq(financialBillingPartySyncLocks.xeroInvoiceId, xeroInvoiceId),
    inArray(financialBillingPartySyncLocks.state, ["reserved", "submitted", "reconciliation_required"]),
  ];
  if (excludeEventFingerprint) conditions.push(ne(financialBillingPartySyncLocks.eventFingerprint, excludeEventFingerprint));
  return (await (await database()).select().from(financialBillingPartySyncLocks).where(and(...conditions)).limit(1))[0] ?? null;
}

export async function getBillingPartySyncMainReceipt(dealId: string) {
  return (await (await database()).select().from(financialMainCustomerInvoiceEvents)
    .where(eq(financialMainCustomerInvoiceEvents.dealId, dealId)).limit(1))[0] ?? null;
}

/** The event row is evidence-only. Duplicate exact evidence is intentionally a factual no-op. */
export async function recordBillingPartySyncEvent(input: Omit<
  typeof financialBillingPartySyncEvents.$inferInsert,
  "id" | "createdAt"
>): Promise<FinancialBillingPartySyncEvent> {
  const db = await database();
  try {
    await db.insert(financialBillingPartySyncEvents).values(input);
  } catch (error: any) {
    // Exact duplicate evidence is a read-only factual no-op. Do not UPDATE an
    // immutable ledger row merely to satisfy an upsert convenience API.
    if (error?.code !== "ER_DUP_ENTRY") throw error;
  }
  const event = (await db.select().from(financialBillingPartySyncEvents)
    .where(eq(financialBillingPartySyncEvents.eventFingerprint, input.eventFingerprint)).limit(1))[0];
  if (!event) throw new Error("Billing-party sync immutable event could not be read back.");
  return event;
}

/**
 * Claims the Xero invoice. Only an updated verified claim can atomically become
 * a new reservation, and only when current A is that claim's verified target B.
 * Reserved/submitted/held/reconciliation evidence is never reopened.
 */
export async function reserveBillingPartySyncInvoiceLock(input: {
  xeroInvoiceId: string;
  eventFingerprint: string;
  dealId: string;
  targetContactId: string;
  originalContactId: string;
}): Promise<{ kind: "reserved" | "existing"; lock: FinancialBillingPartySyncLock }> {
  const db = await database();
  let inserted = false;
  let transitioned = false;
  try {
    await db.insert(financialBillingPartySyncLocks).values({
      xeroInvoiceId: input.xeroInvoiceId,
      eventFingerprint: input.eventFingerprint,
      dealId: input.dealId,
      targetContactId: input.targetContactId,
      state: "reserved",
    });
    inserted = true;
  } catch (error: any) {
    if (error?.code !== "ER_DUP_ENTRY") throw error;
  }
  let lock = (await db.select().from(financialBillingPartySyncLocks)
    .where(eq(financialBillingPartySyncLocks.xeroInvoiceId, input.xeroInvoiceId)).limit(1))[0];
  if (!lock) throw new Error("Billing-party sync invoice lock could not be read back.");
  if (lock.eventFingerprint !== input.eventFingerprint && lock.state === "updated" &&
    lock.dealId === input.dealId && lock.targetContactId === input.originalContactId) {
    const changed: any = await db.update(financialBillingPartySyncLocks).set({
      eventFingerprint: input.eventFingerprint,
      dealId: input.dealId,
      targetContactId: input.targetContactId,
      state: "reserved",
      updatedAt: new Date(),
    }).where(and(
      eq(financialBillingPartySyncLocks.id, lock.id),
      eq(financialBillingPartySyncLocks.state, "updated"),
      eq(financialBillingPartySyncLocks.dealId, input.dealId),
      eq(financialBillingPartySyncLocks.eventFingerprint, lock.eventFingerprint),
      eq(financialBillingPartySyncLocks.targetContactId, input.originalContactId),
      ne(financialBillingPartySyncLocks.eventFingerprint, input.eventFingerprint),
    ));
    if (Number(changed?.[0]?.affectedRows ?? changed?.rowsAffected ?? 0) === 1) {
      transitioned = true;
      lock = (await db.select().from(financialBillingPartySyncLocks)
        .where(eq(financialBillingPartySyncLocks.xeroInvoiceId, input.xeroInvoiceId)).limit(1))[0];
      if (!lock) throw new Error("Billing-party sync transitioned lock could not be read back.");
    }
  }
  return {
    kind: inserted || transitioned ? "reserved" : "existing",
    lock,
  };
}

/** Lock transitions are one-way operational state, with facts retained in append-only audits. */
export async function setBillingPartySyncInvoiceLockState(input: {
  lockId: number;
  eventFingerprint: string;
  from: Array<"reserved" | "submitted" | "updated" | "held" | "reconciliation_required">;
  to: "submitted" | "updated" | "held" | "reconciliation_required";
}): Promise<boolean> {
  const result: any = await (await database()).update(financialBillingPartySyncLocks).set({
    state: input.to,
    updatedAt: new Date(),
  }).where(and(
    eq(financialBillingPartySyncLocks.id, input.lockId),
    eq(financialBillingPartySyncLocks.eventFingerprint, input.eventFingerprint),
    inArray(financialBillingPartySyncLocks.state, input.from),
  ));
  return Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
}

/** Never update or delete an audit row; each outcome gets a separately keyed fact. */
export async function recordBillingPartySyncAudit(input: {
  eventFingerprint?: string | null;
  dealId: string;
  xeroInvoiceId?: string | null;
  action: "preview" | "reserved" | "submitted" | "outcome";
  outcome: "updated" | "unchanged" | "not_found" | "held" | "reconciliation_required" | "disabled";
  details?: unknown;
}): Promise<void> {
  await (await database()).insert(financialBillingPartySyncAudits).values({
    auditKey: `bps-${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    eventFingerprint: input.eventFingerprint ?? null,
    dealId: input.dealId,
    xeroInvoiceId: input.xeroInvoiceId ?? null,
    action: input.action,
    outcome: input.outcome,
    details: (input.details ?? {}) as any,
  });
}

/**
 * Refuses to alter a target concurrently owned by another Draft amendment or a
 * writer that may have submitted an uncertain request. Warranty events lack a
 * stable main-invoice ID, so an active same-Deal warranty main path blocks.
 */
export async function billingPartySyncConflictReason(dealId: string, xeroInvoiceId: string): Promise<string | null> {
  const db = await database();
  const [writers, finalWeight, deductions, d702946Recovery, warranties] = await Promise.all([
    db.select().from(financialWriterExecutions).where(and(
      eq(financialWriterExecutions.targetXeroDocumentId, xeroInvoiceId),
      inArray(financialWriterExecutions.status, ["prepared", "submitted", "reconciliation_required"]),
    )).limit(1),
    db.select().from(financialFinalWeightAdjustmentEvents).where(and(
      eq(financialFinalWeightAdjustmentEvents.xeroInvoiceId, xeroInvoiceId),
      inArray(financialFinalWeightAdjustmentEvents.status, ["reserved", "submitted", "reconciliation_required"]),
    )).limit(1),
    db.select().from(financialDepositMainDeductionEvents).where(and(
      eq(financialDepositMainDeductionEvents.mainXeroInvoiceId, xeroInvoiceId),
      inArray(financialDepositMainDeductionEvents.status, ["reserved", "reconciliation_required"]),
    )).limit(1),
    db.select().from(financialD702946DepositMainDeductionRecoveryEvents).where(and(
      eq(financialD702946DepositMainDeductionRecoveryEvents.mainXeroInvoiceId, xeroInvoiceId),
      inArray(financialD702946DepositMainDeductionRecoveryEvents.status, ["reserved", "submitted", "reconciliation_required"]),
    )).limit(1),
    db.select().from(financialWarrantyAvisoEvents).where(and(
      eq(financialWarrantyAvisoEvents.dealId, dealId),
      inArray(financialWarrantyAvisoEvents.status, ["reserved", "main_submitted", "po_submitted", "reconciliation_required"]),
    )).limit(1),
  ]);
  if (writers[0]) return "An in-flight or uncertain AP writer execution already owns this exact Xero invoice; reconcile before any billing-party change.";
  if (finalWeight[0]) return "An active or uncertain Final Weight amendment already owns this exact Xero invoice; reconcile before any billing-party change.";
  if (deductions[0]) return "An active or uncertain Deposit-to-main deduction already owns this exact Xero invoice; reconcile before any billing-party change.";
  if (d702946Recovery[0]) return "The dedicated D702946 Deposit-to-main recovery owns this exact Xero invoice; reconcile before any billing-party change.";
  if (warranties[0]) return "An active or uncertain Warranty/Aviso main path exists for this Deal; reconcile before any billing-party change.";
  return null;
}
