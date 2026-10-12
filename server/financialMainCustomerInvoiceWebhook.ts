import type { Express, Request, Response } from "express";
import {
  MAIN_CUSTOMER_INVOICE_WEBHOOK_PATH,
  processAutomaticMainCustomerInvoice,
} from "./financialMainCustomerInvoiceService";
import {
  assertMainCustomerInvoiceRelease,
  getMainCustomerInvoiceReleasePolicy,
} from "./financialMainCustomerInvoiceRelease";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";

export const MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET_HEADER = "x-financial-webhook-secret" as const;
export const MAIN_CUSTOMER_INVOICE_WEBHOOK_EVENT = "customer-invoice.main-create" as const;
export const MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET_ENV =
  "FINANCIAL_MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET" as const;

export type MainCustomerInvoiceWebhookEnvelope = {
  recordId: string | null;
  dealNumber: string | null;
  event: string | null;
};

/**
 * Accepts the existing VTiger JSON envelope: `id` and `secret`, optionally
 * `dryRun`. Financial/body fields are intentionally ignored. `id` may be the
 * current Deal webservice ID or the legacy D-number, which is resolved only
 * through one exact bounded VTiger lookup after the AP release is valid.
 */
export function parseMainCustomerInvoiceWebhookEnvelope(
  body: unknown
): MainCustomerInvoiceWebhookEnvelope {
  const source =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const values = [source.record_id, source.deal_id, source.id].filter(
    value => value !== undefined
  );
  if (!values.length || values.some(value => typeof value !== "string")) {
    throw new Error(
      "Main Customer Invoice webhook requires one exact VTiger Deal webservice ID or D-number."
    );
  }
  const id = (values[0] as string).trim();
  if (new Set(values.map(value => (value as string).trim())).size !== 1) {
    throw new Error(
      "Main Customer Invoice webhook requires one unambiguous named Deal reference; conflicting IDs are rejected."
    );
  }
  const event =
    typeof source.event === "string" && source.event.trim()
      ? source.event.trim()
      : null;
  if (/^\d+x\d{1,12}$/i.test(id)) {
    return { recordId: id, dealNumber: null, event };
  }
  if (/^D\d{1,12}$/i.test(id)) {
    return { recordId: null, dealNumber: id.toUpperCase(), event };
  }
  throw new Error(
    "Main Customer Invoice webhook requires one exact VTiger Deal webservice ID or D-number."
  );
}

/** Resolves only an exact legacy potential number; ambiguity always holds. */
export async function resolveMainCustomerInvoiceWebhookRecord(
  envelope: MainCustomerInvoiceWebhookEnvelope
): Promise<string> {
  if (envelope.recordId) return envelope.recordId;
  if (!envelope.dealNumber) {
    throw new Error("Main Customer Invoice contains no exact Deal reference.");
  }
  const lookup = await findExactFinancialCandidate({
    sourceCategory: "deal",
    businessNumber: envelope.dealNumber,
  });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1) {
    throw new Error(
      `Main Customer Invoice D-number lookup is ${lookup.outcome}: ${lookup.message}`
    );
  }
  return lookup.candidates[0]!.recordId;
}

/**
 * Keep header authentication for new callers and accept the established VTiger
 * body-secret envelope in constant time. The secret is never returned, logged
 * or persisted by this receiver.
 */
export function hasMainCustomerInvoiceWebhookSecret(
  req: Pick<Request, "header" | "body">
): boolean {
  return hasFinancialWebhookSecret(req, [
    MAIN_CUSTOMER_INVOICE_WEBHOOK_SECRET_ENV,
  ]);
}

/** Registered for the dedicated Main Invoice action; held before any source read until its family release is valid. */
export function registerMainCustomerInvoiceWebhook(app: Express): void {
  app.post(MAIN_CUSTOMER_INVOICE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasMainCustomerInvoiceWebhookSecret(req)) {
      return res
        .status(401)
        .json({ ok: false, error: "unauthenticated-main-customer-invoice-webhook" });
    }

    const disabled = () =>
      res.status(503).json({
        ok: false,
        status: "held",
        error: "main-customer-invoice-release-disabled",
        xeroWritesAttempted: 0,
      });

    // The release-policy read is the only permitted operation before it is valid.
    if (process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED !== "true") {
      return disabled();
    }
    try {
      assertMainCustomerInvoiceRelease(await getMainCustomerInvoiceReleasePolicy());
    } catch {
      return disabled();
    }

    let envelope: MainCustomerInvoiceWebhookEnvelope;
    try {
      envelope = parseMainCustomerInvoiceWebhookEnvelope(req.body);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "invalid-main-customer-invoice-webhook",
      });
    }

    let recordId: string;
    try {
      recordId = await resolveMainCustomerInvoiceWebhookRecord(envelope);
    } catch (error) {
      return res.status(202).json({
        ok: false,
        status: "held",
        warning:
          error instanceof Error
            ? error.message
            : "Main Customer Invoice exact Deal lookup is held.",
        xeroWritesAttempted: 0,
      });
    }

    try {
      const result = await processAutomaticMainCustomerInvoice(recordId);
      if (!result.ok) {
        reportWorkflowFailureSafely({
          workflowType: "main_customer_invoice",
          recordKey: `main-customer-invoice:${recordId}`,
          title: "Main Customer Invoice held",
          errorMessage: ("warning" in result ? result.warning : null) ?? result.status,
          details: { dealId: recordId, status: result.status },
          severity: "error",
        });
      }
      const deduction = "mainDeduction" in result ? result.mainDeduction : null;
      if (deduction && (deduction.status === "held" || deduction.status === "reconciliation_required")) {
        reportWorkflowFailureSafely({
          workflowType: "deposit_main_deduction",
          recordKey: `deposit-main-deduction:${recordId}`,
          title: "Deposit-to-main Draft deduction held",
          errorMessage: deduction.reason,
          details: { dealId: recordId, status: deduction.status },
          severity: "error",
        });
      }
      return res.status(result.ok ? 200 : 202).json(result);
    } catch {
      reportWorkflowFailureSafely({
        workflowType: "main_customer_invoice",
        recordKey: `main-customer-invoice:${recordId}`,
        title: "Main Customer Invoice held",
        errorMessage:
          "Main Customer Invoice source, release or Xero preflight could not be completed.",
        details: { dealId: recordId },
        severity: "error",
      });
      return res.status(202).json({
        ok: false,
        status: "held",
        warning: "Main Customer Invoice held; inspect the AP lifecycle ledger.",
        xeroWritesAttempted: 0,
      });
    }
  });
}
