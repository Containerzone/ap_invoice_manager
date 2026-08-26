import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { deleteOldArchivedInvoices } from "./db";
import { getMicrosoftGraphStateByScheduleTaskUid, updateMicrosoftGraphState } from "./db";
import { renewGraphMessageSubscription } from "./microsoftGraphService";

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
    const state = await getMicrosoftGraphStateByScheduleTaskUid(user.taskUid);
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
    return res.status(500).json({ error: err.message, timestamp: new Date().toISOString() });
  }
}
