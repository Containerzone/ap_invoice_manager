import { describe, expect, it } from "vitest";
import {
  getBillReconciliationState,
  parseBillReconciliationSnapshot,
  type BillReconciliationSnapshot,
} from "../shared/billReconciliation";

describe("Xero bill reconciliation state", () => {
  const snapshot: BillReconciliationSnapshot = {
    outcome: "found",
    checkedAt: "2026-09-18T13:00:00.000Z",
    billId: "bill-1",
    billNumber: "BILL-001",
    billStatus: "AUTHORISED",
    contactName: "Supplier Pty Ltd",
    currencyCode: "AUD",
    subTotal: 100,
    totalTax: 10,
    total: 110,
  };

  it("marks matching GST-inclusive invoice and bill totals as reconciled", () => {
    expect(getBillReconciliationState({ invoiceTotal: 110, xeroFinalBillId: "bill-1", snapshot }))
      .toEqual({ status: "matched", difference: 0 });
  });

  it("reports the invoice-minus-Xero bill difference when totals differ", () => {
    expect(getBillReconciliationState({ invoiceTotal: 125.5, xeroFinalBillId: "bill-1", snapshot }))
      .toEqual({ status: "amount_differs", difference: 15.5 });
  });

  it("never treats invoices without a linked bill as a Xero reconciliation candidate", () => {
    expect(getBillReconciliationState({ invoiceTotal: 110, xeroFinalBillId: null, snapshot: null }))
      .toEqual({ status: "not_pushed", difference: null });
  });

  it("distinguishes unrefreshed, unavailable and failed linked bills", () => {
    expect(getBillReconciliationState({ invoiceTotal: 110, xeroFinalBillId: "bill-1", snapshot: null }))
      .toEqual({ status: "needs_refresh", difference: null });
    expect(getBillReconciliationState({ invoiceTotal: 110, xeroFinalBillId: "bill-1", snapshot: { outcome: "not_found", checkedAt: "now" } }))
      .toEqual({ status: "xero_bill_unavailable", difference: null });
    expect(getBillReconciliationState({ invoiceTotal: 110, xeroFinalBillId: "bill-1", snapshot: { outcome: "failed", checkedAt: "now", error: "Rate limit" } }))
      .toEqual({ status: "refresh_failed", difference: null });
  });

  it("does not accept malformed persisted JSON as a valid bill snapshot", () => {
    expect(parseBillReconciliationSnapshot({ outcome: "found", total: "110" })).toBeNull();
    expect(parseBillReconciliationSnapshot(snapshot)).toEqual(snapshot);
  });
});
