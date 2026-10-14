import type { Express, Request, Response } from "express";
import { ASSET_PURCHASE_WEBHOOK_PATH, processAutomaticAssetPurchase } from "./financialAssetPurchaseService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

export const ASSET_PURCHASE_WEBHOOK_SECRET_HEADER = "x-financial-webhook-secret" as const;
export const ASSET_PURCHASE_WEBHOOK_EVENT = "container-control.asset-request" as const;

export type AssetPurchaseWebhookEnvelope = { recordId: string; event: string | null };

/** Legacy-compatible envelope parser. Financial values in the POST body are ignored. */
export function parseAssetPurchaseWebhookEnvelope(body: unknown): AssetPurchaseWebhookEnvelope {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const recordId = typeof source.record_id === "string" ? source.record_id.trim()
    : typeof source.id === "string" ? source.id.trim() : "";
  if (!/^\d+x\d+$/i.test(recordId) && !/^C\d+$/i.test(recordId)) {
    throw new Error("Asset purchase webhook requires an exact VTiger Container Control id, record_id or C-number.");
  }
  const event = typeof source.event === "string" && source.event.trim() ? source.event.trim() : null;
  return { recordId, event };
}

/** Resolves VTiger's `id -> vtcmcontainercontrolsnumber` mapping by one exact, read-only query. */
export async function resolveAssetPurchaseRecordId(reference: string): Promise<string> {
  if (/^\d+x\d+$/i.test(reference)) return reference;
  const lookup = await findExactFinancialCandidate({ sourceCategory: "container_control", businessNumber: reference });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1) {
    throw new Error(lookup.message || "Asset Container Control business reference is missing or ambiguous.");
  }
  return lookup.candidates[0].recordId;
}

export function hasAssetPurchaseWebhookSecret(req: Pick<Request, "header" | "body">): boolean {
  return hasFinancialWebhookSecret(req);
}

function safeAssetPurchaseHoldWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "Automatic Asset purchase release is disabled or lacks an approved current policy.") {
    return "Asset PO release policy needs refresh after the approved item-mapping change; no Xero write was attempted.";
  }
  return "Asset purchase PO held; inspect the AP lifecycle ledger.";
}

/** Registered only for the dedicated Asset / REQUEST VTiger branch; default-off before source reads. */
export function registerAssetPurchaseWebhook(app: Express): void {
  app.post(ASSET_PURCHASE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasAssetPurchaseWebhookSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-asset-purchase-webhook" });
    let envelope: AssetPurchaseWebhookEnvelope;
    try {
      envelope = parseAssetPurchaseWebhookEnvelope(req.body);
    } catch (error) {
      reportWorkflowFailureSafely({
        workflowType: "asset_purchase",
        recordKey: "asset-purchase:webhook-envelope",
        title: "Asset purchase webhook rejected",
        errorMessage: error instanceof Error ? error.message : "Invalid Asset purchase webhook envelope.",
        details: { route: ASSET_PURCHASE_WEBHOOK_PATH },
        severity: "error",
      });
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "invalid-asset-purchase-webhook" });
    }
    if (process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED !== "true") {
      return res.status(503).json({ ok: false, status: "held", error: "asset-purchase-release-disabled", xeroWritesAttempted: 0 });
    }
    try {
      const resolvedRecordId = await resolveAssetPurchaseRecordId(envelope.recordId);
      const result = await processAutomaticAssetPurchase(resolvedRecordId);
      if (!result.ok) reportWorkflowFailureSafely({
        workflowType: "asset_purchase",
        recordKey: `asset-purchase:${resolvedRecordId}`,
        title: "Asset purchase PO held",
        errorMessage: ("warning" in result ? result.warning : null) ?? result.status,
        details: { containerControlId: resolvedRecordId, webhookReference: envelope.recordId, status: result.status },
        severity: "error",
      });
      return res.status(result.ok ? 200 : 202).json(result);
    } catch (error) {
      reportWorkflowFailureSafely({
        workflowType: "asset_purchase",
        recordKey: `asset-purchase:${envelope.recordId}`,
        title: "Asset purchase PO held",
        errorMessage: error instanceof Error ? error.message : "Asset purchase source, release or Xero preflight could not be completed.",
        details: { containerControlReference: envelope.recordId },
        severity: "error",
      });
      return res.status(202).json({ ok: false, status: "held", warning: safeAssetPurchaseHoldWarning(error), xeroWritesAttempted: 0 });
    }
  });
}
