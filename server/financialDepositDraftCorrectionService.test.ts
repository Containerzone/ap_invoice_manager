import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), facts: vi.fn(), preflight: vi.fn(), item: vi.fn(), auth: vi.fn() }));
vi.mock("axios", () => ({ default: { get: m.get } }));
vi.mock("./financialMainCustomerInvoiceService", () => ({ readMainCustomerInvoiceFacts: m.facts }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: m.preflight, readDepositInvoiceXeroItemConfiguration: m.item }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth }));

import { previewDepositDraftCorrection } from "./financialDepositDraftCorrectionService";

const main = {
  InvoiceID: "main-id", InvoiceNumber: "INV-702933", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Exclusive",
  Contact: { ContactID: "customer" }, Date: "2026-10-12", LineItems: [{ LineItemID: "main-line", Description: "Transport", Quantity: 1, UnitAmount: 5379.41, LineAmount: 5379.41, TaxAmount: 537.94, AccountCode: "200", TaxType: "OUTPUT" }],
  SubTotal: 5379.41, TotalTax: 537.94, Total: 5917.35,
};
const deposit = {
  InvoiceID: "deposit-id", InvoiceNumber: "INV-702933-D", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Inclusive",
  Contact: { ContactID: "customer" }, Date: "2026-10-12", DueDate: "2026-10-13", LineItems: [{ LineItemID: "deposit-line", ItemCode: "Deposit Required", Description: "Deposit Required", Quantity: 1, UnitAmount: 500, LineAmount: 500, TaxAmount: 45.45, AccountCode: "200", TaxType: "OUTPUT" }],
  SubTotal: 454.55, TotalTax: 45.45, Total: 500,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.facts.mockResolvedValue({ dealId: "5x488785", dealNumber: "D702933", quoteId: "6x1", quoteNumber: "Q531665", customerVtigerId: "4x1", customerName: "Customer", customerKind: "organisation", sourceRefreshedAt: "2026-10-12T10:26:22.000Z", serviceLines: [] });
  m.preflight.mockResolvedValue([
    { duplicateState: "found", status: "DRAFT", xeroDocumentId: "main-id", contactCheck: { found: true, contactId: "customer" } },
    { duplicateState: "found", status: "DRAFT", xeroDocumentId: "deposit-id", contactCheck: { found: true, contactId: "customer" } },
  ]);
  m.auth.mockResolvedValue({ token: "token", tenantId: "tenant" });
  m.item.mockResolvedValue({ itemCode: "Deposit Required", accountCode: "200", taxType: "OUTPUT" });
  m.get.mockImplementation((url: string) => {
    if (url.endsWith("/Invoices/main-id")) return Promise.resolve({ data: { Invoices: [main] } });
    if (url.endsWith("/Invoices/deposit-id")) return Promise.resolve({ data: { Invoices: [deposit] } });
    if (url.endsWith("/Items/Deposit%20Required")) return Promise.resolve({ data: { Items: [{ Code: "Deposit Required", Description: "Deposit  for Q<> from INV-<>" }] } });
    throw new Error(`Unexpected GET ${url}`);
  });
});

describe("Deposit Draft correction preview", () => {
  it("keeps every existing main line and adds the approved exclusive deduction", async () => {
    const preview = await previewDepositDraftCorrection("5x488785");
    expect(preview.depositDescription).toBe("Deposit for Q531665 from INV-702933");
    expect(preview.deductionExclusive).toBe(454.55);
    expect(preview.deductionTax).toBe(45.45);
    expect(preview.mainTotalAfter).toBe(5417.35);
    const depositUpdate = (preview.depositPayload.body.Invoices as any[])[0];
    const mainUpdate = (preview.mainPayload.body.Invoices as any[])[0];
    expect(depositUpdate.LineItems[0]).toMatchObject({ LineItemID: "deposit-line", Description: "Deposit for Q531665 from INV-702933", UnitAmount: 500 });
    expect(mainUpdate.LineItems).toHaveLength(2);
    expect(mainUpdate.LineItems[0]).toEqual(main.LineItems[0]);
    expect(mainUpdate.LineItems[1]).toMatchObject({ Description: "Deposit deduction — INV-702933-D", Quantity: 1, UnitAmount: -454.55, AccountCode: "200", TaxType: "OUTPUT" });
    expect(m.preflight).toHaveBeenCalledWith(expect.any(Array), { skipContactCheck: true });
  });

  it("holds if the Deposit item description is not the approved native template", async () => {
    m.get.mockImplementation((url: string) => {
      if (url.endsWith("/Invoices/main-id")) return Promise.resolve({ data: { Invoices: [main] } });
      if (url.endsWith("/Invoices/deposit-id")) return Promise.resolve({ data: { Invoices: [deposit] } });
      return Promise.resolve({ data: { Items: [{ Code: "Deposit Required", Description: "Different description" }] } });
    });
    await expect(previewDepositDraftCorrection("5x488785")).rejects.toThrow(/approved Deposit template/);
  });
});
