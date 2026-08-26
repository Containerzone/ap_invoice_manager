/**
 * Converts the invoice line total stored by the app (always GST-exclusive) to
 * the GST-exclusive per-unit amount required by Xero PO updates.
 */
export function getGstExclusiveUnitAmount(lineAmount: unknown, quantity: unknown): number {
  const parsedQuantity = Number.parseFloat(String(quantity ?? "1"));
  const safeQuantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;
  const parsedAmount = Number.parseFloat(String(lineAmount ?? "0"));
  const safeAmount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
  return Math.round((safeAmount / safeQuantity) * 100) / 100;
}
