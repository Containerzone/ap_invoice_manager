import { describe, expect, it } from "vitest";
import { calculateInvoiceLineTotals } from "../shared/invoiceLineTotals";

describe("calculateInvoiceLineTotals", () => {
  it("derives subtotal, GST and total from GST-exclusive line amounts", () => {
    const totals = calculateInvoiceLineTotals([
      { amount: "60.00", taxRate: "10" },
      { amount: "400.00", taxRate: "10" },
      { amount: "40.00", taxRate: "10" },
      { amount: "60.00", taxRate: "10" },
      { amount: "400.00", taxRate: "10" },
      { amount: "40.00", taxRate: "10" },
    ]);

    expect(totals).toMatchObject({
      subtotal: 1000,
      tax: 100,
      total: 1100,
      validAmountLineCount: 6,
      invalidAmountLineCount: 0,
      defaultTaxRateLineCount: 0,
    });
  });

  it("supports different tax rates and preserves zero-rated lines", () => {
    const totals = calculateInvoiceLineTotals([
      { amount: "100.00", taxRate: "10" },
      { amount: "50.00", taxRate: "0" },
      { amount: "20.00", taxRate: "5" },
    ]);

    expect(totals).toMatchObject({ subtotal: 170, tax: 11, total: 181 });
  });

  it("uses the disclosed 10% GST fallback for historic lines without a tax rate", () => {
    const totals = calculateInvoiceLineTotals([
      { amount: "230.00", taxRate: null },
      { amount: "20.00", taxRate: "invalid" },
    ]);

    expect(totals).toMatchObject({
      subtotal: 250,
      tax: 25,
      total: 275,
      defaultTaxRateLineCount: 2,
    });
  });

  it("does not silently substitute header values for missing or invalid line amounts", () => {
    const totals = calculateInvoiceLineTotals([
      { amount: "100.00", taxRate: "10" },
      { amount: null, taxRate: "10" },
      { amount: "not a number", taxRate: "10" },
    ]);

    expect(totals).toMatchObject({
      subtotal: 100,
      tax: 10,
      total: 110,
      validAmountLineCount: 1,
      invalidAmountLineCount: 2,
    });
  });

  it("rounds each GST-exclusive line before summing the footer", () => {
    const totals = calculateInvoiceLineTotals([
      { amount: "33.333", taxRate: "10" },
      { amount: "33.333", taxRate: "10" },
      { amount: "33.334", taxRate: "10" },
    ]);

    expect(totals).toMatchObject({ subtotal: 99.99, tax: 9.99, total: 109.98 });
  });

  it("matches Xero per-line GST cents where invoice-level rounding differs", () => {
    const totals = calculateInvoiceLineTotals([
      { amount: "224.75", taxRate: "10" },
      { amount: "3596.57", taxRate: "10" },
    ]);

    expect(totals).toMatchObject({ subtotal: 3821.32, tax: 382.14, total: 4203.46 });
    expect(totals.tax).not.toBe(382.13);
    expect(totals.total).not.toBe(4203.45);
  });
});
