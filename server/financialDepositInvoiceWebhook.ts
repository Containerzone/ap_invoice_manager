import type { Express, Request, Response } from "express";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import {
  DEPOSIT_INVOICE_WEBHOOK_PATH,
  processAutomaticDepositInvoice,
} from "./financialDepositInvoiceService";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

export const DEPOSIT_INVOICE_WEBHOOK_SECRET_HEADER =
  "x-financial-webhook-secret" as const;
export type DepositInvoiceWebhookEnvelope = {
  recordId: string | null;
  dealNumber: string | null;
};
/**
 * Only one exact Deal webservice ID or legacy D-number is accepted. Financial,
 * customer, date and `dryRun` body values are intentionally ignored.
 */
export function parseDepositInvoiceWebhookEnvelope(
  body: unknown
): DepositInvoiceWebhookEnvelope {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Deposit webhook requires an exact named VTiger Deal ID or D-number.");
  const source = body as Record<string, unknown>;
  const values = [source.deal_id, source.record_id, source.id].filter(
    value => value !== undefined
  );
  if (
    !values.length ||
    values.some(value => typeof value !== "string") ||
    new Set(values.map(value => (value as string).trim())).size !== 1
  )
    throw new Error(
      "Deposit webhook requires one unambiguous exact VTiger Deal ID or D-number (deal_id, record_id or id)."
    );
  const id = (values[0] as string).trim();
  if (/^\d+x\d{1,12}$/i.test(id))
    return { recordId: id, dealNumber: null };
  if (/^D\d{1,12}$/i.test(id))
    return { recordId: null, dealNumber: id.toUpperCase() };
  throw new Error(
    "Deposit webhook requires one exact VTiger Deal ID or D-number; arbitrary values are rejected."
  );
}

/** Resolve a legacy Operations potential number with one bounded exact lookup. */
export async function resolveDepositInvoiceWebhookRecord(
  envelope: DepositInvoiceWebhookEnvelope
): Promise<string> {
  if (envelope.recordId) return envelope.recordId;
  if (!envelope.dealNumber)
    throw new Error("Deposit webhook contains no exact Deal reference.");
  const lookup = await findExactFinancialCandidate({
    sourceCategory: "deal",
    businessNumber: envelope.dealNumber,
  });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1)
    throw new Error(
      `Deposit D-number lookup is ${lookup.outcome}: ${lookup.message}`
    );
  return lookup.candidates[0]!.recordId;
}

export function hasDepositInvoiceWebhookSecret(req: Pick<Request, "header" | "body">): boolean {
  return hasFinancialWebhookSecret(req);
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
        const recordId = await resolveDepositInvoiceWebhookRecord(envelope);
        const result = await processAutomaticDepositInvoice(recordId);
        return res.status(result.ok ? 200 : 202).json(result);
      } catch (error) {
        // Never claim zero attempts after an unknown transport failure; immutable ledger is authoritative.
        return res
          .status(202)
          .json({
            ok: false,
            status: "held",
            recordId: envelope.recordId,
            warning:
              error instanceof Error
                ? error.message
                : "Deposit source, policy or execution is held; inspect the AP immutable ledger before retry. No main-invoice or CRM mutation is permitted.",
          });
      }
    }
  );
}
