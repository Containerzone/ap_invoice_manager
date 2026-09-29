import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import {
  getFinancialWorkflowScheduleByTaskUid,
  recordFinancialWorkflowScheduleOutcome,
} from "./financialWorkflowDb";
import { isFinancialGlobalShadowModeEnabled } from "./financialLiveExecutionService";
import { isFinancialLiveWriteEnvironmentEnabled } from "./financialProductionWriter";
import { retryFinancialPostSuccessActions } from "./vtigerFinancialWriteService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

async function verifyFinancialSchedule(req: Request, expectedWorkflowType: string) {
  const user = await sdk.authenticateRequest(req);
  if (!user.isCron || !user.taskUid) return { error: "cron-only" as const };
  const schedule = await getFinancialWorkflowScheduleByTaskUid(user.taskUid);
  if (!schedule || schedule.workflowType !== expectedWorkflowType) {
    return { error: "unexpected-or-disabled-financial-schedule" as const, taskUid: user.taskUid };
  }
  return { taskUid: user.taskUid, schedule };
}

/** Uses an Australia/Sydney calendar day, never the server's UTC calendar. */
export function isFirstSydneyCalendarDay(now: Date = new Date()): boolean {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    day: "2-digit",
  }).format(now) === "01";
}

/**
 * A future Heartbeat may call this only after the AP-owned schedule row has
 * separately been enabled. It retries VTiger-only post-success work; it never
 * replays or invokes a Xero Draft writer.
 */
export async function financialPostSuccessRetryHandler(req: Request, res: Response) {
  const workflowType = "financial_post_success_retry";
  let taskUid: string | null = null;
  try {
    const verified = await verifyFinancialSchedule(req, workflowType);
    if ("error" in verified) return res.status(403).json({ error: verified.error });
    taskUid = verified.taskUid;
    if (!isFinancialLiveWriteEnvironmentEnabled() || isFinancialGlobalShadowModeEnabled()) {
      await recordFinancialWorkflowScheduleOutcome({ workflowType, taskUid, outcome: "blocked_by_execution_lock" });
      return res.status(409).json({ error: "financial-execution-lock-active" });
    }
    const result = await retryFinancialPostSuccessActions(20);
    await recordFinancialWorkflowScheduleOutcome({ workflowType, taskUid, outcome: result.failed ? "completed_with_failures" : "completed" });
    return res.json({ ok: true, ...result, xeroWritesAttempted: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (taskUid) await recordFinancialWorkflowScheduleOutcome({ workflowType, taskUid, outcome: "failed" }).catch(() => undefined);
    reportWorkflowFailureSafely({
      workflowType,
      recordKey: `financial-schedule:${workflowType}:${taskUid ?? "unknown"}`,
      title: "Financial post-success retry task failed",
      errorMessage: message,
      details: { path: req.path, taskUid },
      severity: "error",
    });
    return res.status(500).json({ error: "Financial post-success retry failed." });
  }
}

/**
 * Placeholder for a future explicitly scoped recurring source selector. The
 * route is cron-authenticated but remains unavailable unless an AP-owned
 * schedule, exact candidate selection logic and all live writer gates are
 * separately configured. It deliberately does not evaluate or write anything.
 */
export async function financialRecurringProposalHandler(req: Request, res: Response) {
  const workflowType = String(req.params.workflowType ?? "").trim();
  let taskUid: string | null = null;
  try {
    const verified = await verifyFinancialSchedule(req, workflowType);
    if ("error" in verified) return res.status(403).json({ error: verified.error });
    taskUid = verified.taskUid;
    if (!verified.schedule.enabled) {
      await recordFinancialWorkflowScheduleOutcome({ workflowType, taskUid, outcome: "disabled_no_write_audit" });
      return res.json({
        ok: true,
        status: "disabled_no_write_audit",
        workflowType,
        selectorAvailable: true,
        xeroWritesAttempted: 0,
        vtigerWritesAttempted: 0,
        message: "Recognised AP financial schedule is disabled. No selector, source update or financial write was run.",
      });
    }
    if (workflowType === "recurring_storage" && !isFirstSydneyCalendarDay()) {
      await recordFinancialWorkflowScheduleOutcome({ workflowType, taskUid, outcome: "skipped_not_first_sydney_calendar_day" });
      return res.json({ ok: true, skipped: "not_first_sydney_calendar_day", xeroWritesAttempted: 0 });
    }
    await recordFinancialWorkflowScheduleOutcome({ workflowType, taskUid, outcome: "enabled_selector_proposal_only" });
    return res.status(409).json({
      error: "financial-recurring-execution-not-approved",
      message: "Recurring selectors are readiness-only. An enabled schedule still cannot execute until the full family handover and named-document approval gates are approved.",
      xeroWritesAttempted: 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (taskUid && workflowType) await recordFinancialWorkflowScheduleOutcome({ workflowType, taskUid, outcome: "failed" }).catch(() => undefined);
    reportWorkflowFailureSafely({
      workflowType: workflowType || "financial-recurring-proposal",
      recordKey: `financial-schedule:${workflowType || "unknown"}:${taskUid ?? "unknown"}`,
      title: "Financial recurring proposal task failed",
      errorMessage: message,
      details: { path: req.path, taskUid },
      severity: "error",
    });
    return res.status(500).json({ error: "Financial recurring proposal task failed." });
  }
}
