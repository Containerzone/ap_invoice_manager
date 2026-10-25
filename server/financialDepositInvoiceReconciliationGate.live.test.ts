import { describe, expect, it } from "vitest";
import { assertDepositInvoiceRelease, getDepositInvoiceReleasePolicy } from "./financialDepositInvoiceRelease";
import { previewDepositInvoiceReconciliation } from "./financialDepositInvoiceReconciliationService";

const live = process.env.RUN_LIVE_FINANCIAL_TESTS === "true";
const test = live ? it : it.skip;

describe("Deposit Invoice reconciliation recovery gate (live, GET-only)", () => {
  test("requires the configured gate and permits only a no-write D702950 preview", async () => {
    expect(process.env.FINANCIAL_DEPOSIT_INVOICE_RECONCILIATION_ENABLED).toBe("true");

    const policy = await getDepositInvoiceReleasePolicy();
    assertDepositInvoiceRelease(policy);

    const preview = await previewDepositInvoiceReconciliation(420002);
    expect(preview).toMatchObject({
      originalEventId: 420002,
      dealNumber: "D702950",
      invoiceNumber: "INV-702950-D",
      noWrites: true,
    });
    expect(preview.payload).toMatchObject({
      method: "POST",
      endpoint: "/Invoices",
      documentNumber: "INV-702950-D",
      expectedXeroDocumentId: null,
    });
  }, 120_000);
});
