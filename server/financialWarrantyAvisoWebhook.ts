import type { Express, Request, Response } from "express";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import { assertWarrantyRelease, getWarrantyReleasePolicy } from "./financialWarrantyAvisoRelease";
import { processAutomaticWarrantyAviso, WARRANTY_WEBHOOK_PATH } from "./financialWarrantyAvisoService";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

export function parseWarrantyEnvelope(body: unknown): string {
  const row = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const ids = [row.deal_id, row.record_id, row.id].filter(value => value !== undefined);
  if (!ids.length || ids.some(value => typeof value !== "string" || !/^(?:\d+x\d{1,12}|D\d{1,12})$/i.test(value)) || new Set(ids.map(value => String(value).toUpperCase())).size !== 1) {
    throw new Error("One unambiguous exact Deal webservice ID or D-number is required.");
  }
  return String(ids[0]).trim();
}

async function resolveWarrantyDealId(reference: string): Promise<string> {
  if (/^\d+x\d{1,12}$/.test(reference)) return reference;
  const result = await findExactFinancialCandidate({ sourceCategory: "deal", businessNumber: reference.toUpperCase() });
  if (result.outcome !== "found" || result.candidates.length !== 1 || !/^5x\d{1,12}$/.test(result.candidates[0]!.recordId)) {
    throw new Error("One unambiguous exact Deal webservice ID is required.");
  }
  return result.candidates[0]!.recordId;
}

function safeFailureKey(result: Record<string, unknown>, fallback: string) {
  const recordId = typeof result.recordId === "string" ? result.recordId : fallback;
  return `warranty-aviso:${recordId}:${String(result.status ?? "held")}`;
}

export function registerWarrantyAvisoWebhook(app: Express): void {
  app.post(WARRANTY_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasFinancialWebhookSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-warranty-aviso-webhook" });
    const disabled = () => res.status(503).json({ ok: false, status: "held", error: "warranty-aviso-release-disabled", xeroWritesAttempted: 0 });
    if (process.env.FINANCIAL_WARRANTY_AUTOMATIC_ENABLED !== "true") return disabled();
    try { assertWarrantyRelease(await getWarrantyReleasePolicy()); } catch { return disabled(); }
    let dealId: string;
    try { dealId = await resolveWarrantyDealId(parseWarrantyEnvelope(req.body)); }
    catch (error) { return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Invalid Warranty Deal envelope.", xeroWritesAttempted: 0 }); }
    try {
      const result = await processAutomaticWarrantyAviso(dealId);
      if (!result.ok && result.status === "held") {
        reportWorkflowFailureSafely({
          workflowType: "warranty-aviso",
          recordKey: safeFailureKey(result as Record<string, unknown>, dealId),
          title: "Warranty & Aviso held",
          errorMessage: typeof result.warning === "string" ? result.warning : "Warranty/Aviso source or reference validation held.",
          details: { dealId, status: result.status },
          severity: "error",
        });
      }
      return res.status(result.ok ? 200 : 202).json(result);
    } catch {
      reportWorkflowFailureSafely({ workflowType: "warranty-aviso", recordKey: `warranty-aviso:${dealId}:reconciliation`, title: "Warranty & Aviso reconciliation required", errorMessage: "Warranty source, ledger or Draft execution is unavailable; reconciliation is required.", details: { dealId }, severity: "error" });
      return res.status(202).json({ ok: false, status: "reconciliation_required", warning: "Warranty source/ledger/execution unavailable; inspect immutable AP claim/receipts before any further action. No blind retry." });
    }
  });
}
