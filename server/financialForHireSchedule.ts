import { Temporal } from "@js-temporal/polyfill";

/**
 * Prepared application-native Heartbeat contract only. Importing this module
 * never creates a task, enables a policy, or calls a financial writer.
 *
 * The platform uses UTC six-field cron. 20:05 UTC is always the following
 * Australia/Sydney business morning: 06:05 AEST / 07:05 AEDT. This produces
 * exactly one check per Sydney calendar day without a DST midnight ambiguity.
 */
export const FOR_HIRE_RECURRING_CRON = "0 5 20 * * *" as const;
export const FOR_HIRE_RECURRING_CADENCE = "DAILY_CONTAINER_DUE_DATE" as const;
export const FOR_HIRE_RECURRING_TIMEZONE = "Australia/Sydney" as const;
export const FOR_HIRE_RECURRING_CHECK_TIME = "Daily 06:05 AEST / 07:05 AEDT (20:05 UTC)" as const;

export function forHireSydneyToday(): string {
  return Temporal.Now.zonedDateTimeISO(FOR_HIRE_RECURRING_TIMEZONE).toPlainDate().toString();
}

/** Cursor comes only from authenticated task-owned AP metadata, never req.body. */
export function forHireDailyTraversalCursor(auditData: unknown, businessDate: string): number {
  const raw = auditData && typeof auditData === "object" ? auditData as Record<string, unknown> : {};
  const traversal = raw.forHireDailyTraversal as { businessDate?: unknown; afterEventId?: unknown; complete?: unknown } | undefined;
  const continues = traversal?.businessDate === businessDate ||
    (typeof traversal?.businessDate === "string" && traversal.businessDate < businessDate && traversal.complete === false);
  return continues && Number.isSafeInteger(traversal?.afterEventId) && Number(traversal?.afterEventId) >= 0
    ? Number(traversal.afterEventId) : 0;
}

export function forHireDailyManualTraversalCursor(auditData: unknown, businessDate: string): number {
  const raw = auditData && typeof auditData === "object" ? auditData as Record<string, unknown> : {};
  const traversal = raw.forHireDailyTraversal as { businessDate?: unknown; afterManualHandoverId?: unknown; complete?: unknown } | undefined;
  const continues = traversal?.businessDate === businessDate || (typeof traversal?.businessDate === "string" && traversal.businessDate < businessDate && traversal.complete === false);
  return continues && Number.isSafeInteger(traversal?.afterManualHandoverId) && Number(traversal?.afterManualHandoverId) >= 0 ? Number(traversal!.afterManualHandoverId) : 0;
}

export function isForHireDailySchedule(schedule: {
  enabled?: boolean;
  taskUid?: string | null;
  cronExpression?: string | null;
} | null | undefined): boolean {
  return Boolean(schedule?.enabled && schedule.taskUid?.trim() &&
    schedule.cronExpression === FOR_HIRE_RECURRING_CRON);
}
