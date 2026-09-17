export type InvoiceLineForTotals = {
  amount?: unknown;
  taxRate?: unknown;
};

export type CalculatedInvoiceLineTotals = {
  /** GST-exclusive sum of valid displayed line amounts. */
  subtotal: number;
  /** Tax calculated per line using its stored rate or the explicit 10% fallback. */
  tax: number;
  /** GST-inclusive subtotal plus tax. */
  total: number;
  validAmountLineCount: number;
  invalidAmountLineCount: number;
  defaultTaxRateLineCount: number;
};

const DEFAULT_AU_GST_RATE = 10;

function asFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates the Invoice Lines footer from the actual line amounts rather than
 * invoice-header extraction fields. Line amounts are stored GST-exclusive.
 * When a historic line has no tax rate, the application-wide Australian 10%
 * GST default is used and surfaced to the UI via defaultTaxRateLineCount.
 */
export function calculateInvoiceLineTotals(lines: InvoiceLineForTotals[]): CalculatedInvoiceLineTotals {
  let subtotal = 0;
  let tax = 0;
  let validAmountLineCount = 0;
  let invalidAmountLineCount = 0;
  let defaultTaxRateLineCount = 0;

  for (const line of lines) {
    const amount = asFiniteNumber(line.amount);
    if (amount === null) {
      invalidAmountLineCount += 1;
      continue;
    }

    const suppliedRate = asFiniteNumber(line.taxRate);
    const taxRate = suppliedRate !== null && suppliedRate >= 0
      ? suppliedRate
      : DEFAULT_AU_GST_RATE;
    if (suppliedRate === null || suppliedRate < 0) defaultTaxRateLineCount += 1;

    subtotal += amount;
    tax += amount * (taxRate / 100);
    validAmountLineCount += 1;
  }

  const roundedSubtotal = roundToCents(subtotal);
  const roundedTax = roundToCents(tax);
  return {
    subtotal: roundedSubtotal,
    tax: roundedTax,
    total: roundToCents(roundedSubtotal + roundedTax),
    validAmountLineCount,
    invalidAmountLineCount,
    defaultTaxRateLineCount,
  };
}
