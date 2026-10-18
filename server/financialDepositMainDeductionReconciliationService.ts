import { readBackFinancialDraft } from "./financialReadOnlyXeroService";
import type { FinancialDraftPayload } from "./financialProductionWriter";
import { reconcileVerifiedDepositMainDeduction } from "./financialDepositMainDeductionDb";

function exactPayload(value: unknown): FinancialDraftPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Deposit-to-main reconciliation payload is absent.");
  const payload = value as FinancialDraftPayload;
  const invoice = Array.isArray((payload.body as any)?.Invoices) ? (payload.body as any).Invoices[0] : null;
  if (payload.method !== "POST" || payload.documentFamily !== "customer_invoice" || !payload.expectedXeroDocumentId ||
    !/^\/Invoices\/[A-Za-z0-9-]+$/.test(payload.endpoint) || !/^INV-\d{1,12}$/.test(payload.documentNumber) ||
    !/^[a-f0-9]{64}$/i.test(payload.idempotencyKey) || !invoice || invoice.InvoiceID !== payload.expectedXeroDocumentId ||
    invoice.InvoiceNumber !== payload.documentNumber || invoice.Status !== "DRAFT" || invoice.Type !== "ACCREC" ||
    invoice.CurrencyCode !== "AUD" || invoice.LineAmountTypes !== "Exclusive" || !Array.isArray(invoice.LineItems)) {
    throw new Error("Deposit-to-main reconciliation payload is not an exact AUD Draft amendment.");
  }
  return payload;
}

/**
 * Reconciles a prior post-write uncertainty from a fresh exact Xero GET only.
 * It neither prepares nor submits a financial request; the immutable payload
 * must already be bound to the deduction event by the original guarded writer.
 */
export async function reconcileVerifiedDepositMainDeductionReadback(input: {
  eventId: number;
  authorisedPayload: unknown;
}) {
  const envelope = input.authorisedPayload as { payload?: unknown } | null;
  const payload = exactPayload(envelope?.payload);
  const expectedExactDraft = (payload.body.Invoices as Record<string, any>[])[0]!;
  const readBack = await readBackFinancialDraft({
    documentFamily: "customer_invoice",
    documentNumber: payload.documentNumber,
    expectedXeroDocumentId: payload.expectedXeroDocumentId!,
    expectedExactDraft,
  });
  const receipt = await reconcileVerifiedDepositMainDeduction({
    eventId: input.eventId,
    payload,
    xeroDocumentId: readBack.xeroDocumentId,
    documentNumber: readBack.documentNumber,
    status: readBack.status,
  });
  return { ...receipt, readBack, xeroWritesAttempted: 0 as const };
}
