import type { Express, Request, Response } from "express";
import { CUSTOMER_SALE_PURCHASE_WEBHOOK_PATH, processAutomaticCustomerSalePurchase } from "./financialCustomerSalePurchaseService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

export const CUSTOMER_SALE_PURCHASE_WEBHOOK_SECRET_HEADER = "x-financial-webhook-secret" as const;
export const CUSTOMER_SALE_PURCHASE_WEBHOOK_EVENT = "container-control.customer-sale-request" as const;

export type CustomerSalePurchaseWebhookEnvelope = { recordId: string; event: string | null };

/** Legacy-compatible envelope parser. Financial values in the POST body are ignored. */
export function parseCustomerSalePurchaseWebhookEnvelope(body: unknown): CustomerSalePurchaseWebhookEnvelope {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const recordId = typeof source.record_id === "string" ? source.record_id.trim()
    : typeof source.id === "string" ? source.id.trim() : "";
  if (!/^\d+x\d+$/i.test(recordId) && !/^C\d+$/i.test(recordId)) throw new Error("Customer Sale purchase webhook requires an exact VTiger Container Control id, record_id or C-number.");
  const event = typeof source.event === "string" && source.event.trim() ? source.event.trim() : null;
  return { recordId, event };
}

/** Resolves VTiger's id-to-C-number mapping with one exact, read-only lookup. */
export async function resolveCustomerSalePurchaseRecordId(reference: string): Promise<string> {
  if (/^\d+x\d+$/i.test(reference)) return reference;
  const lookup = await findExactFinancialCandidate({ sourceCategory: "container_control", businessNumber: reference });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1) throw new Error(lookup.message || "Customer Sale Container Control business reference is missing or ambiguous.");
  return lookup.candidates[0].recordId;
}

export function hasCustomerSalePurchaseWebhookSecret(req: Pick<Request, "header" | "body">): boolean {
  return hasFinancialWebhookSecret(req);
}

/** Registered only for the dedicated Customer Sale / REQUEST VTiger branch; default-off before source reads. */
export function registerCustomerSalePurchaseWebhook(app: Express): void {
  app.post(CUSTOMER_SALE_PURCHASE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasCustomerSalePurchaseWebhookSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-customer-sale-purchase-webhook" });
    let envelope: CustomerSalePurchaseWebhookEnvelope;
    try {
      envelope = parseCustomerSalePurchaseWebhookEnvelope(req.body);
    } catch (error) {
      reportWorkflowFailureSafely({
        workflowType: "customer_sale_purchase",
        recordKey: "customer-sale-purchase:webhook-envelope",
        title: "Customer Sale purchase webhook rejected",
        errorMessage: error instanceof Error ? error.message : "Invalid Customer Sale purchase webhook envelope.",
        details: { route: CUSTOMER_SALE_PURCHASE_WEBHOOK_PATH },
        severity: "error",
      });
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "invalid-customer-sale-purchase-webhook" });
    }
    if (process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED !== "true") {
      return res.status(503).json({ ok: false, status: "held", error: "customer-sale-purchase-release-disabled", xeroWritesAttempted: 0 });
    }
    try {
      const resolvedRecordId = await resolveCustomerSalePurchaseRecordId(envelope.recordId);
      const result = await processAutomaticCustomerSalePurchase(resolvedRecordId);
      if (!result.ok) reportWorkflowFailureSafely({
        workflowType: "customer_sale_purchase",
        recordKey: `customer-sale-purchase:${resolvedRecordId}`,
        title: "Customer Sale purchase PO held",
        errorMessage: ("warning" in result ? result.warning : null) ?? result.status,
        details: { containerControlId: resolvedRecordId, webhookReference: envelope.recordId, status: result.status },
        severity: "error",
      });
      return res.status(result.ok ? 200 : 202).json(result);
    } catch (error) {
      reportWorkflowFailureSafely({
        workflowType: "customer_sale_purchase",
        recordKey: `customer-sale-purchase:${envelope.recordId}`,
        title: "Customer Sale purchase PO held",
        errorMessage: error instanceof Error ? error.message : "Customer Sale purchase source, release or Xero preflight could not be completed.",
        details: { containerControlReference: envelope.recordId },
        severity: "error",
      });
      return res.status(202).json({ ok: false, status: "held", warning: "Customer Sale purchase PO held; inspect the AP lifecycle ledger.", xeroWritesAttempted: 0 });
    }
  });
}
