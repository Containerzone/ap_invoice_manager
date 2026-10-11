import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { ASSET_PURCHASE_WEBHOOK_PATH, processAutomaticAssetPurchase } from "./financialAssetPurchaseService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

export const ASSET_PURCHASE_WEBHOOK_SECRET_HEADER = "x-financial-webhook-secret" as const;
export const ASSET_PURCHASE_WEBHOOK_EVENT = "container-control.asset-request" as const;

export type AssetPurchaseWebhookEnvelope = { recordId: string; event: string | null };

/** Legacy-compatible envelope parser. Financial values in the POST body are ignored. */
export function parseAssetPurchaseWebhookEnvelope(body: unknown): AssetPurchaseWebhookEnvelope {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const recordId = typeof source.record_id === "string" ? source.record_id.trim()
    : typeof source.id === "string" ? source.id.trim() : "";
  if (!/^\d+x\d+$/i.test(recordId)) throw new Error("Asset purchase webhook requires an exact VTiger Container Control id or record_id.");
  const event = typeof source.event === "string" && source.event.trim() ? source.event.trim() : null;
  return { recordId, event };
}

export function hasAssetPurchaseWebhookSecret(req: Pick<Request, "header">): boolean {
  const expected = process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim() ?? "";
  const supplied = req.header(ASSET_PURCHASE_WEBHOOK_SECRET_HEADER)?.trim() ?? "";
  const a = Buffer.from(expected); const b = Buffer.from(supplied);
  return Boolean(a.length && a.length === b.length && timingSafeEqual(a, b));
}

/** Registered only for the dedicated Asset / REQUEST VTiger branch; default-off before source reads. */
export function registerAssetPurchaseWebhook(app: Express): void {
  app.post(ASSET_PURCHASE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasAssetPurchaseWebhookSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-asset-purchase-webhook" });
    let envelope: AssetPurchaseWebhookEnvelope;
    try {
      envelope = parseAssetPurchaseWebhookEnvelope(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "invalid-asset-purchase-webhook" });
    }
    if (process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED !== "true") {
      return res.status(503).json({ ok: false, status: "held", error: "asset-purchase-release-disabled", xeroWritesAttempted: 0 });
    }
    try {
      const result = await processAutomaticAssetPurchase(envelope.recordId);
      if (!result.ok) reportWorkflowFailureSafely({
        workflowType: "asset_purchase",
        recordKey: `asset-purchase:${envelope.recordId}`,
        title: "Asset purchase PO held",
        errorMessage: ("warning" in result ? result.warning : null) ?? result.status,
        details: { containerControlId: envelope.recordId, status: result.status },
        severity: "error",
      });
      return res.status(result.ok ? 200 : 202).json(result);
    } catch {
      reportWorkflowFailureSafely({
        workflowType: "asset_purchase",
        recordKey: `asset-purchase:${envelope.recordId}`,
        title: "Asset purchase PO held",
        errorMessage: "Asset purchase source, release or Xero preflight could not be completed.",
        details: { containerControlId: envelope.recordId },
        severity: "error",
      });
      return res.status(202).json({ ok: false, status: "held", warning: "Asset purchase PO held; inspect the AP lifecycle ledger.", xeroWritesAttempted: 0 });
    }
  });
}
