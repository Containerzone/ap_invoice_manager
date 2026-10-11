import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { MAIN_CUSTOMER_INVOICE_WEBHOOK_PATH, processAutomaticMainCustomerInvoice } from "./financialMainCustomerInvoiceService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

export const MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET_HEADER = "x-financial-webhook-secret" as const;
export const MAIN_CUSTOMER_INVOICE_WEBHOOK_EVENT = "customer-invoice.main-create" as const;
export type MainCustomerInvoiceWebhookEnvelope = { recordId: string; event: string | null };

/** Accepts the legacy ID-only envelope; body customer, Quote and price values are ignored. */
export function parseMainCustomerInvoiceWebhookEnvelope(body: unknown): MainCustomerInvoiceWebhookEnvelope {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const recordId = typeof source.record_id === "string" ? source.record_id.trim()
    : typeof source.deal_id === "string" ? source.deal_id.trim()
      : typeof source.id === "string" ? source.id.trim() : "";
  if (!/^\d+x\d+$/i.test(recordId)) throw new Error("Main Customer Invoice webhook requires an exact VTiger Deal id or record_id.");
  return { recordId, event: typeof source.event === "string" && source.event.trim() ? source.event.trim() : null };
}
export function hasMainCustomerInvoiceWebhookSecret(req: Pick<Request, "header">): boolean {
  const expected = process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim() ?? "";
  const supplied = req.header(MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET_HEADER)?.trim() ?? "";
  const a = Buffer.from(expected); const b = Buffer.from(supplied);
  return Boolean(a.length && a.length === b.length && timingSafeEqual(a, b));
}

/** Registered for the dedicated main-invoice action; it is held before any source read until the family gate is enabled. */
export function registerMainCustomerInvoiceWebhook(app: Express): void {
  app.post(MAIN_CUSTOMER_INVOICE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasMainCustomerInvoiceWebhookSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-main-customer-invoice-webhook" });
    let envelope: MainCustomerInvoiceWebhookEnvelope;
    try { envelope = parseMainCustomerInvoiceWebhookEnvelope(req.body); }
    catch (error) { return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "invalid-main-customer-invoice-webhook" }); }
    if (process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED !== "true") {
      return res.status(503).json({ ok: false, status: "held", error: "main-customer-invoice-release-disabled", xeroWritesAttempted: 0 });
    }
    try {
      const result = await processAutomaticMainCustomerInvoice(envelope.recordId);
      if (!result.ok) reportWorkflowFailureSafely({ workflowType: "main_customer_invoice", recordKey: `main-customer-invoice:${envelope.recordId}`,
        title: "Main Customer Invoice held", errorMessage: ("warning" in result ? result.warning : null) ?? result.status,
        details: { dealId: envelope.recordId, status: result.status }, severity: "error" });
      return res.status(result.ok ? 200 : 202).json(result);
    } catch {
      reportWorkflowFailureSafely({ workflowType: "main_customer_invoice", recordKey: `main-customer-invoice:${envelope.recordId}`,
        title: "Main Customer Invoice held", errorMessage: "Main Customer Invoice source, release or Xero preflight could not be completed.",
        details: { dealId: envelope.recordId }, severity: "error" });
      return res.status(202).json({ ok: false, status: "held", warning: "Main Customer Invoice held; inspect the AP lifecycle ledger.", xeroWritesAttempted: 0 });
    }
  });
}
