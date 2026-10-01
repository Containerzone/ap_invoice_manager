import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { processInitialLoadedStorage } from "./financialInitialStorageService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

export const INITIAL_STORAGE_WEBHOOK_PATH = "/api/webhooks/vtiger/deal-storage";

export function registerInitialLoadedStorageWebhook(app: Express): void {
  app.post(INITIAL_STORAGE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    const configured = process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim();
    if (!configured) return res.status(503).json({ ok: false, status: "held", message: "AP storage webhook authentication is not configured." });
    const supplied = req.header("x-financial-webhook-secret")?.trim() ?? "";
    const a = Buffer.from(configured);
    const b = Buffer.from(supplied);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: "Unauthorized storage webhook." });
    const recordId = req.body?.record_id;
    if (req.body?.event !== "deal.storage-stage-changed" || typeof recordId !== "string" || !/^\d+x\d+$/.test(recordId)) {
      return res.status(400).json({ ok: false, error: "A VTiger Deal record_id and storage-stage event are required." });
    }
    try {
      const result = await processInitialLoadedStorage(recordId);
      if (!result.ok) reportWorkflowFailureSafely({
        workflowType: "initial-loaded-storage", recordKey: `loaded-storage:${recordId}`,
        title: "Initial loaded storage held or failed", errorMessage: result.warning ?? result.status,
        details: { recordId, location: result.location ?? null, status: result.status }, severity: "error",
      });
      return res.status(result.ok ? 200 : 202).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Loaded storage source could not be validated.";
      reportWorkflowFailureSafely({ workflowType: "initial-loaded-storage", recordKey: `loaded-storage:${recordId}`,
        title: "Initial loaded storage validation failed", errorMessage: message,
        details: { recordId, heldBeforeXero: true }, severity: "error" });
      return res.status(202).json({ ok: false, status: "held", warning: message });
    }
  });
}
