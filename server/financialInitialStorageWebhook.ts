import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { processInitialLoadedStorage } from "./financialInitialStorageService";
import { processAutomaticInitialStorage, processStorageFinalisation } from "./financialStorageLifecycleService";
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
      const result = process.env.FINANCIAL_STORAGE_AUTOMATIC_ENABLED === "true"
        ? await processAutomaticInitialStorage(recordId) : await processInitialLoadedStorage(recordId);
      if (!result.ok) reportWorkflowFailureSafely({
        workflowType: "initial-loaded-storage", recordKey: `loaded-storage:${recordId}`,
        title: "Initial loaded storage held or failed", errorMessage: ("warning" in result ? result.warning : null) ?? result.status,
        details: { recordId, status: result.status }, severity: "error",
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
  app.post("/api/webhooks/vtiger/deal-storage-finalise", async (req: Request, res: Response) => {
    const configured = process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim();
    if (!configured) return res.status(503).json({ ok: false, status: "held", message: "AP storage authentication is not configured." });
    const supplied = req.header("x-financial-webhook-secret")?.trim() ?? "";
    const a = Buffer.from(configured); const b = Buffer.from(supplied);
    if (a.length !== b.length || !timingSafeEqual(a,b)) return res.status(401).json({ ok: false, error: "Unauthorized storage webhook." });
    const id = req.body?.record_id; const location = req.body?.storageLocation;
    if (req.body?.event !== "deal.storage-finalised" || typeof id !== "string" || !/^5x\d+$/.test(id) || !["origin", "destination"].includes(location)) return res.status(400).json({ ok: false, error: "Exact Deal ID, finalisation event and origin/destination storageLocation are required." });
    try { return res.json(await processStorageFinalisation(id, location)); }
    catch {
      reportWorkflowFailureSafely({ workflowType: "storage-finalisation", recordKey: `storage-finalisation:${id}:${location}`, title: "Storage finalisation held", errorMessage: "Storage finalisation requires source/release or document reconciliation.", details: { recordId: id, location }, severity: "error" });
      return res.status(202).json({ ok: false, status: "held", warning: "Storage finalisation held; review source, release policy and AP execution ledger." });
    }
  });
}
