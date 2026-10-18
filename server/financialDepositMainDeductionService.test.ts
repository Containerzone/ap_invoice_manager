import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), queue: vi.fn(), policy: vi.fn(), assertRelease: vi.fn(), facts: vi.fn(), depositFacts: vi.fn(), mainEvent: vi.fn(), auth: vi.fn(), reserve: vi.fn(), bind: vi.fn(), complete: vi.fn(), hold: vi.fn(), execute: vi.fn() }));
vi.mock("axios", () => ({ default: { get: m.get } }));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.queue }));
vi.mock("./financialDepositInvoiceRelease", () => ({ getDepositInvoiceReleasePolicy: m.policy, assertDepositMainDeductionRelease: m.assertRelease }));
vi.mock("./financialMainCustomerInvoiceService", () => ({ readMainCustomerInvoiceFacts: m.facts }));
vi.mock("./financialDepositInvoiceSource", () => ({ readDepositInvoiceFacts: m.depositFacts }));
vi.mock("./financialMainCustomerInvoiceDb", () => ({ getMainCustomerInvoiceEvent: m.mainEvent }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth, EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE" }));
vi.mock("./financialDepositMainDeductionDb", () => ({ reserveDepositMainDeduction: m.reserve, bindDepositMainDeductionPayload: m.bind, completeDepositMainDeduction: m.complete, holdDepositMainDeduction: m.hold }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.execute }));

import { processAutomaticDepositMainDeduction } from "./financialDepositMainDeductionService";

const main = { InvoiceID: "main-id", InvoiceNumber: "INV-702990", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Contact: { ContactID: "customer" }, Date: "2026-10-12", AmountPaid: 0, AmountCredited: 0, LineItems: [{ LineItemID: "main-line", Description: "Transport", Quantity: 1, UnitAmount: 1100, LineAmount: 1100, TaxAmount: 110, AccountCode: "200", TaxType: "OUTPUT" }], SubTotal: 1100, TotalTax: 110, Total: 1210 };
const deposit = { InvoiceID: "deposit-id", InvoiceNumber: "INV-702990-D", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Inclusive", Contact: { ContactID: "customer" }, Date: "2026-10-12", AmountPaid: 0, AmountCredited: 0, LineItems: [{ LineItemID: "deposit-line", ItemCode: "Deposit Required", Description: "Deposit Required", Quantity: 1, UnitAmount: 500, LineAmount: 500, TaxAmount: 45.45, AccountCode: "200", TaxType: "OUTPUT" }], SubTotal: 454.55, TotalTax: 45.45, Total: 500 };

beforeEach(() => {
  vi.clearAllMocks();
  m.policy.mockResolvedValue({ releaseKey: "deposit-release", approvedBy: 1 });
  m.assertRelease.mockImplementation(() => undefined);
  m.facts.mockResolvedValue({ dealId: "5x990", dealNumber: "D702990", quoteId: "6x1", quoteNumber: "Q1", customerVtigerId: "4x1", customerName: "Customer", customerKind: "organisation", sourceRefreshedAt: "2026-10-12T00:00:00.000Z", serviceLines: [] });
  m.depositFacts.mockResolvedValue({ dealId: "5x990", dealNumber: "D702990", quoteId: "6x1", quoteNumber: "Q1", depositAmountRequiredInclusive: 500 });
  m.mainEvent.mockResolvedValue({ status: "drafts_created", xeroInvoiceId: "main-id" });
  m.auth.mockResolvedValue({ token: "token", tenantId: "tenant" });
  m.reserve.mockResolvedValue({ state: "reserved", event: { id: 91 } });
  m.bind.mockResolvedValue(undefined); m.complete.mockResolvedValue(undefined); m.hold.mockResolvedValue(undefined);
  m.execute.mockResolvedValue({ outcome: "succeeded", executionId: 92, result: { xeroDocumentId: "main-id", documentNumber: "INV-702990", status: "DRAFT" } });
  m.queue.mockImplementation(async (_auth: unknown, _operation: string, request: () => Promise<unknown>) => request());
  m.get.mockImplementation((url: string, config?: any) => {
    const number = config?.params?.InvoiceNumbers;
    if (number === "INV-702990") return Promise.resolve({ data: { Invoices: [main] } });
    if (number === "INV-702990-D") return Promise.resolve({ data: { Invoices: [deposit] } });
    if (url.endsWith("/Invoices/main-id")) return Promise.resolve({ data: { Invoices: [main] } });
    if (url.endsWith("/Invoices/deposit-id")) return Promise.resolve({ data: { Invoices: [deposit] } });
    throw new Error(`Unexpected GET ${url}`);
  });
});

describe("automatic Deposit-to-main Draft deduction", () => {
  it("remains read-free and write-free until its separate release gate is armed", async () => {
    m.assertRelease.mockImplementation(() => { throw new Error("disabled"); });
    await expect(processAutomaticDepositMainDeduction("5x990")).resolves.toMatchObject({ status: "disabled", xeroWritesAttempted: 0 });
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });

  it("retains every main Draft line and appends one GST-balanced legacy deduction", async () => {
    const result = await processAutomaticDepositMainDeduction("5x990");
    expect(result).toMatchObject({ status: "deducted", eventId: 91, executionId: 92, xeroWritesAttempted: 1 });
    const command = m.execute.mock.calls[0]![0];
    const row = command.payload.body.Invoices[0];
    expect(row.LineItems).toHaveLength(2);
    expect(row.LineItems[0]).toEqual(main.LineItems[0]);
    expect(row.LineItems[1]).toMatchObject({ Description: "Less deposit invoice INV-702990-D", Quantity: 1, UnitAmount: -454.55, LineAmount: -454.55, TaxAmount: -45.45, AccountCode: "200", TaxType: "OUTPUT" });
    expect(command.expectedExactDraft).toEqual(row);
    expect(m.queue).toHaveBeenCalledTimes(4);
    expect(m.queue.mock.calls.map(([, operation]) => operation)).toEqual(expect.arrayContaining([
      "GET financial-read:deposit-main-deduction:invoice-number:INV-702990",
      "GET financial-read:deposit-main-deduction:invoice-number:INV-702990-D",
      "GET financial-read:deposit-main-deduction:invoice-id:main-id",
      "GET financial-read:deposit-main-deduction:invoice-id:deposit-id",
    ]));
  });

  it("never amends a main Draft that is not an AP-owned main-invoice receipt", async () => {
    m.mainEvent.mockResolvedValue({ status: "held", xeroInvoiceId: "main-id" });
    await expect(processAutomaticDepositMainDeduction("5x990")).resolves.toMatchObject({ status: "not_ready", xeroWritesAttempted: 0 });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });

  it("treats the earlier incident description as an existing deduction rather than appending another line", async () => {
    m.get.mockImplementation((url: string, config?: any) => {
      const incidentMain = { ...main, LineItems: [...main.LineItems, { Description: "Deposit deduction — INV-702990-D", Quantity: 1, UnitAmount: -454.55, LineAmount: -454.55, TaxAmount: -45.45, AccountCode: "200", TaxType: "OUTPUT" }] };
      const number = config?.params?.InvoiceNumbers;
      if (number === "INV-702990") return Promise.resolve({ data: { Invoices: [incidentMain] } });
      if (number === "INV-702990-D") return Promise.resolve({ data: { Invoices: [deposit] } });
      if (url.endsWith("/Invoices/main-id")) return Promise.resolve({ data: { Invoices: [incidentMain] } });
      if (url.endsWith("/Invoices/deposit-id")) return Promise.resolve({ data: { Invoices: [deposit] } });
      throw new Error(`Unexpected GET ${url}`);
    });
    await expect(processAutomaticDepositMainDeduction("5x990")).resolves.toMatchObject({ status: "already_deducted", xeroWritesAttempted: 0 });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.execute).not.toHaveBeenCalled();
  });
});
