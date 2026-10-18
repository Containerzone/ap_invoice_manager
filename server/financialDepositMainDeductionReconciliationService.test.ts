import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ readBack: vi.fn(), reconcile: vi.fn() }));
vi.mock("./financialReadOnlyXeroService", () => ({ readBackFinancialDraft: m.readBack }));
vi.mock("./financialDepositMainDeductionDb", () => ({ reconcileVerifiedDepositMainDeduction: m.reconcile }));

import { reconcileVerifiedDepositMainDeductionReadback } from "./financialDepositMainDeductionReconciliationService";

const payload = {
  method: "POST" as const,
  endpoint: "/Invoices/main-id",
  documentFamily: "customer_invoice" as const,
  documentNumber: "INV-702941",
  expectedXeroDocumentId: "main-id",
  idempotencyKey: "a".repeat(64),
  body: {
    Invoices: [{
      InvoiceID: "main-id",
      InvoiceNumber: "INV-702941",
      Type: "ACCREC",
      Status: "DRAFT",
      CurrencyCode: "AUD",
      LineAmountTypes: "Exclusive",
      LineItems: [{ Description: "Less deposit invoice INV-702941-D", Quantity: 1, UnitAmount: -454.55, LineAmount: -454.55, TaxAmount: -45.45, AccountCode: "200", TaxType: "OUTPUT" }],
    }],
  },
};

describe("Deposit-to-main exact read-back reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.readBack.mockResolvedValue({ documentFamily: "customer_invoice", xeroDocumentId: "main-id", documentNumber: "INV-702941", status: "DRAFT", partyName: "Kyle Ram", subtotal: 4006.53, total: 4407.19, lineCount: 3 });
    m.reconcile.mockResolvedValue({ event: { id: 60001, status: "draft_updated" }, executionId: 930002, alreadyCompleted: false });
  });

  it("reconciles only the independently read-back exact immutable Draft payload", async () => {
    const result = await reconcileVerifiedDepositMainDeductionReadback({ eventId: 60001, authorisedPayload: { hash: "bound-hash", payload } });
    expect(m.readBack).toHaveBeenCalledWith({ documentFamily: "customer_invoice", documentNumber: "INV-702941", expectedXeroDocumentId: "main-id", expectedExactDraft: payload.body.Invoices[0] });
    expect(m.reconcile).toHaveBeenCalledWith({ eventId: 60001, payload, xeroDocumentId: "main-id", documentNumber: "INV-702941", status: "DRAFT" });
    expect(result).toMatchObject({ executionId: 930002, xeroWritesAttempted: 0 });
  });

  it("rejects a malformed or non-Draft payload before any Xero read or local adoption", async () => {
    await expect(reconcileVerifiedDepositMainDeductionReadback({ eventId: 60001, authorisedPayload: { payload: { ...payload, endpoint: "/Invoices" } } })).rejects.toThrow(/not an exact AUD Draft amendment/);
    expect(m.readBack).not.toHaveBeenCalled();
    expect(m.reconcile).not.toHaveBeenCalled();
  });
});
