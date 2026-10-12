import type { Express, Request, Response } from "express";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import { assertWarrantyRelease, getWarrantyReleasePolicy } from "./financialWarrantyAvisoRelease";
import { processAutomaticWarrantyAviso, WARRANTY_WEBHOOK_PATH } from "./financialWarrantyAvisoService";
export function parseWarrantyEnvelope(body: unknown): string {
  const r = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const ids = [r.deal_id, r.record_id, r.id].filter(v => v !== undefined);
  if (!ids.length || ids.some(v => typeof v !== "string" || !/^\d+x\d{1,12}$/.test(v)) || new Set(ids).size !== 1 || r.event !== "warranty.aviso-requested") throw new Error("Warranty-only event and one exact named Deal ID required; conflicting IDs held.");
  return ids[0] as string;
}
export function registerWarrantyAvisoWebhook(app: Express): void {
  app.post(WARRANTY_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasFinancialWebhookSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-warranty-aviso-webhook" });
    const disabled = () => res.status(503).json({ ok: false, status: "held", error: "warranty-aviso-release-disabled", xeroWritesAttempted: 0 });
    if (process.env.FINANCIAL_WARRANTY_AUTOMATIC_ENABLED !== "true") return disabled();
    try { assertWarrantyRelease(await getWarrantyReleasePolicy()); } catch { return disabled(); }
    let dealId: string;
    try { dealId = parseWarrantyEnvelope(req.body); } catch (e) { return res.status(400).json({ ok: false, error: e instanceof Error ? e.message : "Invalid warranty-only Deal envelope.", xeroWritesAttempted: 0 }); }
    try { const result = await processAutomaticWarrantyAviso(dealId); return res.status(result.ok ? 200 : 202).json(result); }
    catch { return res.status(202).json({ ok: false, status: "reconciliation_required", warning: "Warranty source/ledger/execution unavailable; inspect immutable AP claim/receipts before any further action. No blind retry." }); }
  });
}
