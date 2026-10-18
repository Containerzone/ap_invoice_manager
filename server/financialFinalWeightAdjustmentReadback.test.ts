import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("axios", () => ({ default: { get: m.get, post: m.post, put: m.put } }));
vi.mock("./db", () => ({ getXeroToken: vi.fn().mockResolvedValue({ tenantName: "CONTAINERZONE" }) }));
vi.mock("./xeroService", () => ({ EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE", getXeroReadAuthWithRefresh: vi.fn().mockResolvedValue({ token: "synthetic", tenantId: "synthetic" }) }));
vi.mock("./xeroRequestManager", () => ({ XERO_CACHE_TTL: { invoiceSearch: 1 }, runCachedXeroGet: vi.fn(async (_a, _b, _c, operation) => (await operation()).data) }));
import { readBackFinancialDraft, readFinalWeightXeroEvidence } from "./financialReadOnlyXeroService";
import { buildFinalWeightAdjustment, finalWeightDraftEvidence } from "./financialFinalWeightAdjustmentRules";
import { facts, invoice, xero } from "./_test/finalWeightFixtures";
beforeEach(() => { vi.clearAllMocks(); m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : url.endsWith("/Contacts") ? { Contacts: [{ ContactID: "customer-exact", Name: "Synthetic Customer" }] } : url.endsWith("/Items/SER70") ? { Items: [{ Code: "SER70", IsSold: true, SalesDetails: { AccountCode: "200", TaxType: "OUTPUT" } }] } : url.endsWith("/Accounts") ? { Accounts: [{ Code: "200", Status: "ACTIVE" }] } : { Invoices: [invoice()] } })); });
const noMutations = () => { expect(m.post).not.toHaveBeenCalled(); expect(m.put).not.toHaveBeenCalled(); };
describe("Final weight exact GET/full-line readback", () => {
  it("queries one exact number including history then exact current immutable ID with all original lines", async () => {
    const result = await readFinalWeightXeroEvidence("INV-702877", "Synthetic Customer", "overweight"); expect(result.invoice!.LineItems).toEqual(invoice().LineItems);
    expect(m.get).toHaveBeenCalledWith("https://api.xero.com/api.xro/2.0/Invoices", expect.objectContaining({ params: { InvoiceNumbers: "INV-702877" } }));
    expect(m.get).toHaveBeenCalledWith("https://api.xero.com/api.xro/2.0/Invoices/invoice-exact", expect.any(Object)); noMutations();
  });
  it("underweight skips SER70/account reads and retains all lines", async () => { await readFinalWeightXeroEvidence("INV-702877", "Synthetic Customer", "underweight"); expect(m.get.mock.calls.some(([url]) => /Items|Accounts/.test(url))).toBe(false); noMutations(); });
  it("ambiguous Draft/deleted same number holds without ID detail read", async () => {
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : url.endsWith("/Contacts") ? { Contacts: [] } : { Invoices: [invoice(), invoice({ InvoiceID: "deleted", Status: "DELETED" })] } }));
    const result = await readFinalWeightXeroEvidence("INV-702877", "Synthetic Customer", "overweight"); expect(result.exactMatches).toHaveLength(2); expect(result.invoice).toBeNull(); expect(m.get.mock.calls.some(([url]) => url.endsWith("/Invoices/invoice-exact"))).toBe(false); noMutations();
  });
  it("existing readback validates exact retained lines/date/header for underweight", async () => {
    const expected = buildFinalWeightAdjustment(facts({ actualWeight: 9, collectionDate: "2026-10-20" }), "underweight", xero()).expectedDraft!;
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : { Invoices: [invoice({ Date: "2026-10-20", DueDate: "2026-10-22" })] } }));
    expect(await readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-702877", expectedXeroDocumentId: "invoice-exact", expectedFinalWeightDraft: expected })).toMatchObject({ status: "DRAFT", lineCount: 1 }); noMutations();
  });
  it("preserves an intentionally absent Draft due date", async () => {
    const actual = invoice({ DueDate: null, DueDateString: null });
    const expected = finalWeightDraftEvidence(actual);
    delete expected.DueDate;
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : { Invoices: [actual] } }));
    await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-702877", expectedXeroDocumentId: "invoice-exact", expectedExactDraft: expected })).resolves.toMatchObject({ status: "DRAFT" }); noMutations();
  });
  it("validates a full GST-inclusive customer Draft without applying exclusive subtotal math", async () => {
    const actual = {
      InvoiceID: "deposit-id", InvoiceNumber: "INV-702933-D", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Inclusive",
      Contact: { ContactID: "customer-exact" }, Date: "2026-10-12", DueDate: "2026-10-13",
      LineItems: [{ LineItemID: "deposit-line", ItemCode: "Deposit Required", Description: "Deposit for Q531665 from INV-702933", Quantity: 1, UnitAmount: 500, LineAmount: 500, TaxAmount: 45.45, AccountCode: "200", TaxType: "OUTPUT" }],
      SubTotal: 454.55, TotalTax: 45.45, Total: 500,
    };
    const expected = finalWeightDraftEvidence(actual);
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : { Invoices: [actual] } }));
    await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-702933-D", expectedXeroDocumentId: "deposit-id", expectedExactDraft: expected })).resolves.toMatchObject({ status: "DRAFT", lineCount: 1 }); noMutations();
  });
  it("validates positive SER70 derived net/tax and all retained line totals", async () => {
    const expected = buildFinalWeightAdjustment(facts(), "overweight", xero()).expectedDraft!;
    const actual = { ...expected, LineItems: [expected.LineItems[0], { ...expected.LineItems[1], LineItemID: "new-ser-id", LineAmount: 250, TaxAmount: 25 }], SubTotal: 340, TotalTax: 34, Total: 374 };
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : { Invoices: [actual] } }));
    await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-702877", expectedXeroDocumentId: "invoice-exact", expectedFinalWeightDraft: expected })).resolves.toMatchObject({ status: "DRAFT", lineCount: 2 }); noMutations();
  });
  it.each([{ TaxAmount: 0 }, { LineAmount: -250 }, { DiscountRate: 10 }, { Tracking: [{ Name: "Unexpected" }] }])("SER70 unexpected derived variation holds %#", async patch => {
    const expected = buildFinalWeightAdjustment(facts(), "overweight", xero()).expectedDraft!;
    const actual = { ...expected, LineItems: [expected.LineItems[0], { ...expected.LineItems[1], LineAmount: 250, TaxAmount: 25, ...patch }], SubTotal: 340, TotalTax: 34, Total: 374 };
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : { Invoices: [actual] } }));
    await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-702877", expectedXeroDocumentId: "invoice-exact", expectedFinalWeightDraft: expected })).rejects.toThrow(); noMutations();
  });
  it.each([{ Total: 100 }, { TotalTax: 0 }, { AmountPaid: 1 }, { CreditNotes: [{}] }, { Url: "unexpected" }])("underweight changed total/allocation/optional header holds %#", async patch => {
    const expected = buildFinalWeightAdjustment(facts({ actualWeight: 9, collectionDate: "2026-10-20" }), "underweight", xero()).expectedDraft!;
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : { Invoices: [invoice({ Date: "2026-10-20", DueDate: "2026-10-22", ...patch })] } }));
    await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-702877", expectedXeroDocumentId: "invoice-exact", expectedFinalWeightDraft: expected })).rejects.toThrow(); noMutations();
  });
  it.each([{ Date: "2026-10-21" }, { DueDate: "2026-10-21" }, { Contact: { ContactID: "wrong" } }, { LineItems: [{ ...invoice().LineItems[0], DiscountRate: 0 }] }, { Status: "PAID" }, { InvoiceID: "other" }])("rejects changed exact readback %#", async patch => {
    m.get.mockImplementation(async (url: string) => ({ data: url.endsWith("/Organisation") ? { Organisations: [{ Name: "CONTAINERZONE" }] } : { Invoices: [invoice(patch)] } }));
    const expected = buildFinalWeightAdjustment(facts({ actualWeight: 9, collectionDate: "2026-10-20" }), "underweight", xero()).expectedDraft!;
    await expect(readBackFinancialDraft({ documentFamily: "customer_invoice", documentNumber: "INV-702877", expectedXeroDocumentId: "invoice-exact", expectedFinalWeightDraft: expected })).rejects.toThrow(); noMutations();
  });
});
