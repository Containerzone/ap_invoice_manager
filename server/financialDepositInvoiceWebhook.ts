import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  DEPOSIT_INVOICE_WEBHOOK_PATH,
  processAutomaticDepositInvoice,
} from "./financialDepositInvoiceService";

export const DEPOSIT_INVOICE_WEBHOOK_SECRET_HEADER =
  "x-financial-webhook-secret" as const;
export type DepositInvoiceWebhookEnvelope = { recordId: string };
/** Only a named exact Deal ID; all finance/status/date/customer payload values are ignored. */
export function parseDepositInvoiceWebhookEnvelope(
  body: unknown
): DepositInvoiceWebhookEnvelope {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Deposit webhook requires an exact named VTiger Deal ID.");
  const source = body as Record<string, unknown>;
  const values = [source.deal_id, source.record_id, source.id].filter(
    value => value !== undefined
  );
  if (
    !values.length ||
    values.some(
      value =>
        typeof value !== "string" || !/^\d+x\d{1,12}$/i.test(value.trim())
    ) ||
    new Set(values.map(value => (value as string).trim())).size !== 1
  )
    throw new Error(
      "Deposit webhook requires one unambiguous exact VTiger Deal ID (deal_id, record_id or id)."
    );
  return { recordId: (values[0] as string).trim() };
}
export function hasDepositInvoiceWebhookSecret(
  req: Pick<Request, "header">
): boolean {
  const expected = Buffer.from(
    process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim() ?? ""
  );
  const supplied = Buffer.from(
    req.header(DEPOSIT_INVOICE_WEBHOOK_SECRET_HEADER)?.trim() ?? ""
  );
  return Boolean(
    expected.length &&
      expected.length === supplied.length &&
      timingSafeEqual(expected, supplied)
  );
}
export function registerDepositInvoiceWebhook(app: Express): void {
  app.post(
    DEPOSIT_INVOICE_WEBHOOK_PATH,
    async (req: Request, res: Response) => {
      if (!hasDepositInvoiceWebhookSecret(req))
        return res
          .status(401)
          .json({
            ok: false,
            error: "unauthenticated-deposit-invoice-webhook",
          });
      let envelope: DepositInvoiceWebhookEnvelope;
      try {
        envelope = parseDepositInvoiceWebhookEnvelope(req.body);
      } catch (error) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "invalid-deposit-invoice-webhook",
          });
      }
      // No source/Xero/local DB calls, alerts, CRM writes or main invoice amendments while disabled.
      if (process.env.FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED !== "true")
        return res
          .status(503)
          .json({
            ok: false,
            status: "held",
            recordId: envelope.recordId,
            error: "deposit-invoice-release-disabled",
            xeroWritesAttempted: 0,
          });
      try {
        const result = await processAutomaticDepositInvoice(envelope.recordId);
        return res.status(result.ok ? 200 : 202).json(result);
      } catch {
        // Never claim zero attempts after an unknown transport failure; immutable ledger is authoritative.
        return res
          .status(202)
          .json({
            ok: false,
            status: "held",
            recordId: envelope.recordId,
            warning:
              "Deposit source, policy or execution is held; inspect the AP immutable ledger before retry. No main-invoice or CRM mutation is permitted.",
          });
      }
    }
  );
}
