import type { Express, Request, Response } from "express";
import { processInitialLoadedStorage } from "./financialInitialStorageService";
import { processAutomaticInitialStorage, processStorageFinalisation } from "./financialStorageLifecycleService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

export const INITIAL_STORAGE_WEBHOOK_PATH = "/api/webhooks/vtiger/deal-storage";

/** The pre-existing VTiger action sends `id` and `dryRun`; the AP route owns the
 * event meaning and never trusts any supplied financial values or dry-run flag. */
function storageRecordReference(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).record_id ?? (body as Record<string, unknown>).id;
  return typeof value === "string" && /^(?:\d+x\d+|D\d{1,12})$/i.test(value.trim()) ? value.trim() : null;
}

/** Resolves VTiger's potential_no mapping through one exact, bounded Deal lookup. */
export async function resolveStorageDealId(reference: string): Promise<string> {
  if (/^\d+x\d+$/i.test(reference)) return reference;
  const result = await findExactFinancialCandidate({ sourceCategory: "deal", businessNumber: reference.toUpperCase() });
  if (result.outcome !== "found" || result.candidates.length !== 1 || !/^\d+x\d+$/i.test(result.candidates[0]!.recordId)) {
    throw new Error("One unambiguous exact Storage Deal webservice ID is required.");
  }
  return result.candidates[0]!.recordId;
}

export function registerInitialLoadedStorageWebhook(app: Express): void {
  app.post(INITIAL_STORAGE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasFinancialWebhookSecret(req)) return res.status(401).json({ ok: false, error: "Unauthorized storage webhook." });
    const reference = storageRecordReference(req.body);
    if ((req.body?.event !== undefined && req.body.event !== "deal.storage-stage-changed") || !reference) {
      return res.status(400).json({ ok: false, error: "A VTiger Deal record ID is required for storage activation." });
    }
    try {
      const recordId = await resolveStorageDealId(reference);
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
      reportWorkflowFailureSafely({ workflowType: "initial-loaded-storage", recordKey: `loaded-storage:${reference}`,
        title: "Initial loaded storage validation failed", errorMessage: message,
        details: { recordReference: reference, heldBeforeXero: true }, severity: "error" });
      return res.status(202).json({ ok: false, status: "held", warning: message });
    }
  });
  app.post("/api/webhooks/vtiger/deal-storage-finalise", async (req: Request, res: Response) => {
    if (!hasFinancialWebhookSecret(req)) return res.status(401).json({ ok: false, error: "Unauthorized storage webhook." });
    const reference = storageRecordReference(req.body); const location = req.body?.storageLocation;
    if ((req.body?.event !== undefined && req.body.event !== "deal.storage-finalised") || !reference || !["origin", "destination"].includes(location)) return res.status(400).json({ ok: false, error: "Exact Deal ID/D-number and origin/destination storageLocation are required for storage finalisation." });
    try { const id = await resolveStorageDealId(reference); return res.json(await processStorageFinalisation(id, location)); }
    catch {
      reportWorkflowFailureSafely({ workflowType: "storage-finalisation", recordKey: `storage-finalisation:${reference}:${location}`, title: "Storage finalisation held", errorMessage: "Storage finalisation requires source/release or document reconciliation.", details: { recordReference: reference, location }, severity: "error" });
      return res.status(202).json({ ok: false, status: "held", warning: "Storage finalisation held; review source, release policy and AP execution ledger." });
    }
  });
}
