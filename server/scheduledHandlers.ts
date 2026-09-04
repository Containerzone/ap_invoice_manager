import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import {
  deleteOldArchivedInvoices,
  getMicrosoftGraphState,
  getOpenWorkflowFailures,
  getWorkflowMonitoringSettings,
  updateMicrosoftGraphState,
  updateWorkflowMonitoringSettings,
} from "./db";
import { getMicrosoftGraphConfig } from "./microsoftGraphConfig";
import { renewGraphMessageSubscription } from "./microsoftGraphService";
import { getWorkflowAlertRecipients, reportWorkflowFailureSafely } from "./workflowAlertService";
import { sendOperationalAlertEmail } from "./emailService";

/**
 * Heartbeat handler: /api/scheduled/archive-cleanup
 * Runs daily. Deletes invoices that were archived more than 90 days ago.
 */
export async function archiveCleanupHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) {
      return res.status(403).json({ error: "cron-only" });
    }

    const deletedCount = await deleteOldArchivedInvoices(90);
    console.log(`[archive-cleanup] Deleted ${deletedCount} invoices archived > 90 days ago`);

    return res.json({ ok: true, deletedCount });
  } catch (err: any) {
    console.error(`[archive-cleanup] Error:`, err.message);
    reportWorkflowFailureSafely({
      workflowType: "archive-cleanup",
      recordKey: `archive-cleanup:${(err as any).taskUid ?? "unknown"}`,
      title: "Archived invoice cleanup failed",
      errorMessage: err.message ?? "Archive cleanup failed",
      details: { path: req.path },
      severity: "error",
    });
    return res.status(500).json({
      error: err.message,
      stack: err.stack,
      context: { url: req.url, taskUid: (err as any).taskUid },
      timestamp: new Date().toISOString(),
    });
  }
}

/** Renews the short-lived Microsoft Graph mailbox subscription twice each day. */
export async function microsoftSubscriptionRenewalHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
    const config = getMicrosoftGraphConfig();
    const state = await getMicrosoftGraphState(config.mailbox);
    if (state?.scheduleCronTaskUid && state.scheduleCronTaskUid !== user.taskUid) {
      return res.status(403).json({ error: "unexpected-renewal-task" });
    }
    if (!state?.subscriptionId) return res.json({ ok: true, skipped: "no-subscription" });
    const subscription = await renewGraphMessageSubscription(state.subscriptionId);
    await updateMicrosoftGraphState(state.mailbox, {
      subscriptionExpiresAt: new Date(subscription.expirationDateTime),
      lastRenewedAt: new Date(),
      lastSubscriptionError: null,
    });
    return res.json({ ok: true, subscriptionExpiresAt: subscription.expirationDateTime });
  } catch (err: any) {
    console.error("[microsoft-graph-renewal] Error:", err.message);
    reportWorkflowFailureSafely({
      workflowType: "microsoft-graph-renewal",
      recordKey: `microsoft-graph-renewal:${getMicrosoftGraphConfig().mailbox}`,
      title: "Microsoft invoice mailbox subscription renewal failed",
      errorMessage: err.message ?? "Microsoft Graph renewal failed",
      details: { mailbox: getMicrosoftGraphConfig().mailbox },
      severity: "error",
    });
    return res.status(500).json({ error: err.message, timestamp: new Date().toISOString() });
  }
}

/** Sends a daily email reconciliation of all unresolved operational failures. */
export async function workflowFailureReconciliationHandler(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron-only" });
    const settings = await getWorkflowMonitoringSettings();
    if (!settings?.dailySummaryCronTaskUid || settings.dailySummaryCronTaskUid !== user.taskUid) {
      return res.status(403).json({ error: "unexpected-reconciliation-task" });
    }
    const failures = await getOpenWorkflowFailures();
    const listedFailures = failures.slice(0, 25).map((failure, index) => (
      `${index + 1}. ${failure.title}\n   Workflow: ${failure.workflowType} | Record: ${failure.recordKey}\n   Last occurrence: ${failure.lastOccurredAt.toISOString()} | Occurrences: ${failure.occurrenceCount}\n   Error: ${failure.errorMessage}`
    ));
    const remaining = failures.length > listedFailures.length
      ? `\n\n${failures.length - listedFailures.length} further open failure(s) are available in the Operational Failures page.`
      : "";
    const body = failures.length
      ? `ContainerZone AP Invoice Manager daily operational reconciliation\n\nThere are ${failures.length} open workflow failure(s):\n\n${listedFailures.join("\n\n")}${remaining}\n\nReview and resolve these records in the Operational Failures page.`
      : "ContainerZone AP Invoice Manager daily operational reconciliation\n\nNo open workflow failures were recorded. All monitored workflows are currently clear.";
    const delivery = await sendOperationalAlertEmail({
      recipients: getWorkflowAlertRecipients(),
      subject: `AP daily reconciliation — ${failures.length} open workflow failure${failures.length === 1 ? "" : "s"}`,
      body,
    });
    if (!delivery.success) throw new Error(delivery.error ?? "Daily reconciliation email could not be delivered");
    await updateWorkflowMonitoringSettings({ lastDailySummaryAt: new Date() });
    return res.json({ ok: true, openFailureCount: failures.length });
  } catch (err: any) {
    console.error("[workflow-failure-reconciliation] Error:", err.message);
    reportWorkflowFailureSafely({
      workflowType: "workflow-failure-reconciliation",
      recordKey: "daily-summary",
      title: "Daily workflow failure reconciliation could not be sent",
      errorMessage: err.message ?? "Daily workflow failure reconciliation failed",
      details: { path: req.path },
      severity: "error",
    });
    return res.status(500).json({ error: err.message, timestamp: new Date().toISOString() });
  }
}
