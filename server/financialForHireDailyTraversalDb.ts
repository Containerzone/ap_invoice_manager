import { and, eq, sql } from "drizzle-orm";
import { workflowSchedules } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * AP-only progress metadata for an already authenticated/approved daily task.
 * It never changes a For Hire receipt, billing date, policy or task enablement.
 * The cursor advances monotonically within a Sydney business date; a later
 * date supersedes an earlier one. Concurrent callbacks cannot rewind it.
 */
export async function recordForHireDailyTraversal(taskUid: string, businessDate: string, afterEventId: number, complete: boolean): Promise<void> {
  if (!taskUid.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !Number.isSafeInteger(afterEventId) || afterEventId <= 0) {
    throw new Error("Invalid AP-owned For Hire daily traversal metadata.");
  }
  const db = await getDb();
  if (!db) throw new Error("AP For Hire daily traversal ledger is unavailable.");
  const priorDay = sql`JSON_UNQUOTE(JSON_EXTRACT(${workflowSchedules.auditData}, '$.forHireDailyTraversal.businessDate'))`;
  const priorId = sql`COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(${workflowSchedules.auditData}, '$.forHireDailyTraversal.afterEventId')) AS UNSIGNED), 0)`;
  await db.update(workflowSchedules).set({
    auditData: sql`JSON_SET(COALESCE(${workflowSchedules.auditData}, JSON_OBJECT()), '$.forHireDailyTraversal', JSON_EXTRACT(${JSON.stringify({ businessDate, afterEventId, complete })}, '$'))`,
    updatedAt: new Date(),
  }).where(and(
    eq(workflowSchedules.taskUid, taskUid),
    eq(workflowSchedules.workflowType, "recurring_for_hire"),
    eq(workflowSchedules.enabled, true),
    sql`(${priorDay} IS NULL OR ${priorDay} < ${businessDate} OR (${priorDay} = ${businessDate} AND (${priorId} < ${afterEventId} OR (${priorId} = ${afterEventId} AND ${complete}))))`,
  ));
}
