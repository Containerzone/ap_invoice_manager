import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), queue: vi.fn(), policy: vi.fn(), assertRelease: vi.fn(), facts: vi.fn(), depositFacts: vi.fn(), mainEvent: vi.fn(), auth: vi.fn(), reserve: vi.fn(), bind: vi.fn(), complete: vi.fn(), hold: vi.fn(), execute: vi.fn(), audit: vi.fn() }));
vi.mock("axios", () => ({ default: { get: m.get } }));
vi.mock("./xeroRequestManager", async original => ({ ...await original<any>(), runBoundedXeroGet: m.queue }));
vi.mock("./financialDepositInvoiceRelease", () => ({ getDepositInvoiceReleasePolicy: m.policy, assertDepositMainDeductionRelease: m.assertRelease }));
vi.mock("./financialMainCustomerInvoiceService", () => ({ readMainCustomerInvoiceFacts: m.facts }));
vi.mock("./financialDepositInvoiceSource", () => ({ readDepositInvoiceFacts: m.depositFacts }));
vi.mock("./financialMainCustomerInvoiceDb", () => ({ getMainCustomerInvoiceEvent: m.mainEvent }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth, EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE" }));
vi.mock("./financialDepositMainDeductionDb", async original => ({ ...await original<any>(), reserveDepositMainDeduction: m.reserve, bindDepositMainDeductionPayload: m.bind, completeDepositMainDeduction: m.complete, holdDepositMainDeduction: m.hold, recordDepositMainDeductionAttempt: m.audit }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.execute }));

import { processAutomaticDepositMainDeduction } from "./financialDepositMainDeductionService";
import { XeroRateLimitError } from "./xeroRequestManager";

const main = { InvoiceID: "main-id", InvoiceNumber: "INV-702990", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Contact: { ContactID: "customer" }, Date: "2026-10-12", AmountPaid: 0, AmountCredited: 0, LineItems: [{ LineItemID: "main-line", Description: "Transport", Quantity: 1, UnitAmount: 1100, LineAmount: 1100, TaxAmount: 110, AccountCode: "200", TaxType: "OUTPUT" }], SubTotal: 1100, TotalTax: 110, Total: 1210 };
const deposit = { InvoiceID: "deposit-id", InvoiceNumber: "INV-702990-D", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Inclusive", Contact: { ContactID: "customer" }, Date: "2026-10-12", AmountPaid: 0, AmountCredited: 0, LineItems: [{ LineItemID: "deposit-line", ItemCode: "Deposit Required", Description: "Deposit Required", Quantity: 1, UnitAmount: 500, LineAmount: 500, TaxAmount: 45.45, AccountCode: "200", TaxType: "OUTPUT" }], SubTotal: 454.55, TotalTax: 45.45, Total: 500 };

beforeEach(() => {
  vi.resetAllMocks();
  m.policy.mockResolvedValue({ releaseKey: "deposit-release", approvedBy: 1 });
  m.assertRelease.mockImplementation(() => undefined);
  m.facts.mockResolvedValue({ dealId: "5x990", dealNumber: "D702990", quoteId: "6x1", quoteNumber: "Q1", customerVtigerId: "4x1", customerName: "Customer", customerKind: "organisation", sourceRefreshedAt: "2026-10-12T00:00:00.000Z", serviceLines: [] });
  m.depositFacts.mockResolvedValue({ dealId: "5x990", dealNumber: "D702990", quoteId: "6x1", quoteNumber: "Q1", depositAmountRequiredInclusive: 500 });
  m.mainEvent.mockResolvedValue({ status: "drafts_created", xeroInvoiceId: "main-id" });
  m.auth.mockResolvedValue({ token: "token", tenantId: "tenant" });
  m.reserve.mockResolvedValue({ state: "reserved", event: { id: 91 } });
  m.bind.mockResolvedValue(undefined); m.complete.mockResolvedValue(undefined); m.hold.mockResolvedValue(true); m.audit.mockResolvedValue(undefined);
  m.execute.mockResolvedValue({ outcome: "succeeded", executionId: 92, result: { xeroDocumentId: "main-id", documentNumber: "INV-702990", status: "DRAFT" } });
  m.queue.mockImplementation(async (_auth: unknown, _operation: string, url: string, config: unknown) => m.get(url, config));
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
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "disabled", phase: "release", trigger: "replay", deductionEventId: null }));
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
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "already_deducted", phase: "eligibility", deductionEventId: null }));
  });

  it.each(["main", "deposit", "replay"] as const)("records one completed outcome with its explicit %s trigger", async trigger => {
    await processAutomaticDepositMainDeduction("5x990", trigger);
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ attemptKey: expect.stringMatching(/^[a-f0-9-]{36}$/), dealId: "5x990", dealNumber: "D702990", trigger, outcome: "deducted", phase: "completed", deductionEventId: 91, executionId: 92 }));
  });

  it("records a release-policy retrieval failure even before source reads", async () => {
    m.policy.mockRejectedValue(new Error("policy unavailable"));
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "held", reason: "policy unavailable" });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "held", phase: "release" }));
    expect(m.get).not.toHaveBeenCalled();
  });

  it("records a source read failure without external evidence or reservation", async () => {
    m.facts.mockRejectedValue(new Error("source unavailable"));
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "held", reason: "source unavailable" });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "held", phase: "source", dealNumber: null }));
    expect(m.get).not.toHaveBeenCalled(); expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it("records a failed reservation without binding or attempting a write", async () => {
    m.reserve.mockRejectedValue(new Error("reservation unavailable"));
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "held", reason: "reservation unavailable" });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "held", phase: "reservation", deductionEventId: null }));
    expect(m.bind).not.toHaveBeenCalled(); expect(m.hold).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it("records a not-ready pair before reservation", async () => {
    m.get.mockResolvedValue({ data: { Invoices: [] } });
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "not_ready" });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_ready", phase: "xero_read" }));
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it("records a safe read failure with 429 evidence before reservation, without a writer retry", async () => {
    m.queue.mockRejectedValue(new XeroRateLimitError("Xero minute limit reached", 60, "tenant"));
    expect(await processAutomaticDepositMainDeduction("5x990", "deposit")).toMatchObject({ status: "held", reason: "Xero minute limit reached" });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "held", phase: "xero_read", trigger: "deposit", details: { httpStatus: 429, retryAfterSeconds: 60 } }));
    expect(m.queue).toHaveBeenCalledTimes(1); expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it.each(["main", "deposit"])("holds an AUTHORISED %s without reservation or write", async family => {
    const original = m.get.getMockImplementation()!;
    m.get.mockImplementation(async (...args) => { const response = await original(...args); return { data: { Invoices: response.data.Invoices.map((row: any) => row.InvoiceID === `${family}-id` ? { ...row, Status: "AUTHORISED" } : row) } }; });
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "held" });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "held", phase: "eligibility" }));
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it("does not adopt a changed ID read-back", async () => {
    const original = m.get.getMockImplementation()!;
    m.get.mockImplementation(async (url, config) => url.endsWith("/Invoices/main-id") ? { data: { Invoices: [{ ...main, InvoiceID: "other-id" }] } } : original(url, config));
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "held" });
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it.each(["completed", "blocked", "uncertain"])("records the %s reservation terminal outcome without another write", async state => {
    m.reserve.mockResolvedValue({ state: state === "completed" ? "completed" : "blocked", event: { id: 91, status: state === "uncertain" ? "reconciliation_required" : "reserved", holdReason: "existing receipt" } });
    const status = state === "completed" ? "already_deducted" : state === "uncertain" ? "reconciliation_required" : "held";
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: status, phase: "reservation", deductionEventId: 91 }));
    expect(m.bind).not.toHaveBeenCalled(); expect(m.hold).not.toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled();
  });

  it.each(["bind", "writer", "complete"])("transitions the exact reserved event on a %s throw and never attempts a second write", async failure => {
    const fail = failure === "bind" ? m.bind : failure === "writer" ? m.execute : m.complete;
    fail.mockRejectedValue(new Error(`${failure} failed; token=sensitive`));
    let status = "reserved";
    m.hold.mockImplementation(async () => { status = "reconciliation_required"; return true; });
    const result = await processAutomaticDepositMainDeduction("5x990");
    expect(result).toMatchObject({ status: "reconciliation_required", reason: `${failure} failed; token=[REDACTED]` });
    expect(status).toBe("reconciliation_required");
    const token = m.reserve.mock.calls[0]![0].token;
    expect(m.hold).toHaveBeenCalledTimes(1); expect(m.hold).toHaveBeenCalledWith(91, token, `${failure} failed; token=[REDACTED]`);
    expect(m.execute).toHaveBeenCalledTimes(failure === "bind" ? 0 : 1);
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "reconciliation_required", phase: failure === "bind" ? "reservation" : "writer", details: { reservationTransitioned: true } }));
  });

  it("moves an uncertain writer outcome to reconciliation without a second command", async () => {
    m.execute.mockResolvedValue({ outcome: "reconciliation_required", executionId: 92 });
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "reconciliation_required", xeroWritesAttempted: 1 });
    expect(m.hold).toHaveBeenCalledTimes(1); expect(m.execute).toHaveBeenCalledTimes(1); expect(m.complete).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "reconciliation_required", phase: "writer", executionId: 92 }));
  });

  it.each(["zero rows", "DB failure"])("surfaces %s during reservation transition and never retries the write", async failure => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.bind.mockRejectedValue(new Error("bind failed"));
    if (failure === "zero rows") m.hold.mockResolvedValue(false); else m.hold.mockRejectedValue(new Error("DB unavailable"));
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status: "reconciliation_required", reason: expect.stringContaining("not transitioned") });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "reconciliation_required", details: { reservationTransitioned: false } }));
    expect(log).toHaveBeenCalled(); expect(m.execute).not.toHaveBeenCalled(); log.mockRestore();
  });

  it.each(["deducted", "disabled"])("does not rewrite a %s financial result when audit persistence fails", async status => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.audit.mockRejectedValue(new Error("audit unavailable"));
    if (status === "disabled") m.assertRelease.mockImplementation(() => { throw new Error("disabled"); });
    expect(await processAutomaticDepositMainDeduction("5x990")).toMatchObject({ status });
    expect(m.audit).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalled(); expect(m.hold).not.toHaveBeenCalled(); log.mockRestore();
  });
});
