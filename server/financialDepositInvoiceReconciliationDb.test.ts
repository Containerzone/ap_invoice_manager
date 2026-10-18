import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  db: vi.fn(),
  selectRows: [] as any[],
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  values: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  policy: vi.fn(),
  current: vi.fn(),
  preflight: vi.fn(),
  item: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialDepositInvoiceRelease", async original => ({
  ...(await original<any>()),
  getDepositInvoiceReleasePolicy: m.policy,
}));
vi.mock("./financialDepositInvoiceSource", () => ({ readDepositInvoiceFacts: m.current }));
vi.mock("./financialReadOnlyXeroService", () => ({
  preflightFinancialXeroIntents: m.preflight,
  readDepositInvoiceXeroItemConfiguration: m.item,
}));

import {
  bindDepositInvoiceReconciliationPayload,
  classifyDepositInvoiceReconciliationOrigin,
  reserveDepositInvoiceReconciliation,
} from "./financialDepositInvoiceReconciliationDb";
import { financialSha256 } from "./financialProposalIntegrity";

const evidence = () => ({
  originalEventId: 180001,
  dealId: "5x2941",
  dealNumber: "D702941",
  invoiceNumber: "INV-702941-D",
  originalEventHash: "o".repeat(64),
  sourceSnapshotHash: "s".repeat(64),
  xeroPreflightHash: "p".repeat(64),
  sourceSnapshot: { dealId: "5x2941" },
  proposal: { proposedDocumentNumber: "INV-702941-D" },
  xeroPreflight: { documentNumber: "INV-702941-D", duplicateState: "not_found" },
});
const payload = () => ({
  method: "POST" as const,
  endpoint: "/Invoices" as const,
  documentFamily: "customer_invoice" as const,
  documentNumber: "INV-702941-D",
  expectedXeroDocumentId: null,
  idempotencyKey: "a".repeat(64),
  body: { Invoices: [{ InvoiceNumber: "INV-702941-D", Type: "ACCREC", Status: "DRAFT" }] },
});

const rateLimitPayload = () => ({
  ...payload(),
  documentNumber: "INV-702944-D",
  body: {
    Invoices: [{
      InvoiceNumber: "INV-702944-D", Type: "ACCREC", Status: "DRAFT",
      CurrencyCode: "AUD", LineAmountTypes: "Inclusive", Contact: { ContactID: "exact-contact" },
      LineItems: [{ ItemCode: "Deposit Required", Description: "Deposit for Q1 from INV-702944", TaxType: "OUTPUT", AccountCode: "200", Quantity: 1, UnitAmount: 110 }],
    }],
  },
});

const rateLimitOriginal = (patch: Record<string, unknown> = {}) => {
  const authorised = rateLimitPayload();
  return {
    id: 210001,
    dealId: "5x2944",
    dealNumber: "D702944",
    proposedInvoiceNumber: "INV-702944-D",
    status: "reconciliation_required",
    executionId: null,
    xeroInvoiceId: null,
    processingToken: null,
    claimedDealId: "5x2944",
    claimedInvoiceNumber: "INV-702944-D",
    holdReason: "Request failed with status code 429",
    // Stored JSON can omit prior undefined fields, so the original in-memory
    // hash need not equal a rehash of this persisted payload.
    authorisedPayload: { hash: "a".repeat(64), number: "INV-702944-D", payload: authorised },
    ...patch,
  } as any;
};

const rateLimitExecution = (payload = rateLimitPayload(), patch: Record<string, unknown> = {}) => ({
  id: 990001,
  workflowType: "deposit_invoice",
  documentFamily: "customer_invoice",
  proposedAction: "create_draft",
  proposedDocumentNumber: "INV-702944-D",
  targetXeroDocumentId: null,
  method: "POST",
  endpoint: "/Invoices",
  idempotencyKey: payload.idempotencyKey,
  payloadFingerprint: `${payload.idempotencyKey.slice(0, 24)}:POST:/Invoices`,
  status: "failed",
  xeroDocumentId: null,
  submittedAt: new Date(),
  errorMessage: "Request failed with status code 429",
  ...patch,
} as any);

beforeEach(() => {
  vi.clearAllMocks();
  m.selectRows = [];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => m.selectRows.shift() ?? [] }) }) }));
  m.values.mockResolvedValue(undefined);
  m.insert.mockReturnValue({ values: m.values });
  m.where.mockResolvedValue([{ affectedRows: 1 }]);
  m.set.mockReturnValue({ where: m.where });
  m.update.mockReturnValue({ set: m.set });
  m.db.mockResolvedValue({ select: m.select, insert: m.insert, update: m.update });
});
afterEach(() => vi.unstubAllEnvs());

describe("Deposit recovery independent immutable reservation", () => {
  it("creates only a separate recovery receipt and reserves an exact current proof once", async () => {
    const input = evidence();
    const first = { id: 88, status: "previewed", recoveryKey: financialSha256(input) };
    const reserved = { ...first, status: "reserved", processingToken: "first" };
    m.selectRows.push([], [first], [reserved]);
    const initial = await reserveDepositInvoiceReconciliation({ ...evidence(), token: "first" });
    expect(initial).toMatchObject({ state: "reserved", event: reserved });
    expect(m.insert).toHaveBeenCalledTimes(1);
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({
      originalEventId: 180001,
      dealNumber: "D702941",
      invoiceNumber: "INV-702941-D",
      status: "previewed",
      processingToken: null,
    }));
    expect(m.update).toHaveBeenCalledTimes(1);
  });

  it("blocks changed current proof and never overwrites the independent recovery receipt", async () => {
    const existing = { id: 88, status: "previewed", recoveryKey: "different-current-proof" };
    m.selectRows.push([existing]);
    const collision = await reserveDepositInvoiceReconciliation({ ...evidence(), token: "second" });
    expect(collision).toMatchObject({ state: "blocked", event: existing });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("permits a recovery payload to bind exactly once to the independent reservation", async () => {
    m.where.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(bindDepositInvoiceReconciliationPayload(88, "token", "DEPOSIT-test", payload()))
      .rejects.toThrow(/bind once/);
    expect(m.set).toHaveBeenCalledWith(expect.objectContaining({
      releaseKey: "DEPOSIT-test",
      authorisedPayload: expect.objectContaining({ number: "INV-702941-D" }),
    }));
  });
});

describe("Deposit D702944 definitive 429 no-transport origin classifier", () => {
  it("keeps the named D702941 legacy receipt eligible without any writer evidence query", async () => {
    const legacy = {
      id: 180001, dealId: "5x2941", dealNumber: "D702941", proposedInvoiceNumber: "INV-702941-D",
      status: "reconciliation_required", executionId: null, xeroInvoiceId: null, processingToken: null,
      claimedDealId: "5x2941", claimedInvoiceNumber: "INV-702941-D",
    } as any;
    await expect(classifyDepositInvoiceReconciliationOrigin(legacy, 180001))
      .resolves.toEqual({ kind: "legacy", dealNumber: "D702941", invoiceNumber: "INV-702941-D" });
    expect(m.select).not.toHaveBeenCalled();
  });

  it("allows only the exact D702944 failed 429 original plus one matching immutable writer record", async () => {
    const original = rateLimitOriginal();
    m.selectRows.push([rateLimitExecution(original.authorisedPayload.payload)]);
    await expect(classifyDepositInvoiceReconciliationOrigin(original, 210001))
      .resolves.toEqual({ kind: "rate_limit_429", dealNumber: "D702944", invoiceNumber: "INV-702944-D" });
    expect(m.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["arbitrary event", rateLimitOriginal({ id: 210002 }), []],
    ["altered original hold text", rateLimitOriginal({ holdReason: "Request failed with status code 429; retry later" }), []],
    ["altered writer hold text", rateLimitOriginal(), [rateLimitExecution(rateLimitPayload(), { errorMessage: "Request failed with status code 429; retry later" })]],
    ["mismatched writer idempotency", rateLimitOriginal(), [rateLimitExecution(rateLimitPayload(), { idempotencyKey: "b".repeat(64) })]],
    ["missing writer evidence", rateLimitOriginal(), []],
    ["duplicate writer evidence", rateLimitOriginal(), [rateLimitExecution(), rateLimitExecution(rateLimitPayload(), { id: 990002 })]],
  ])("rejects %s before any source/Xero read or local recovery write", async (_name, original, executions) => {
    if (original.id === 210001) m.selectRows.push(executions);
    await expect(classifyDepositInvoiceReconciliationOrigin(original, 210001)).rejects.toThrow(/D702944|Only the immutable/);
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
    expect(m.preflight).not.toHaveBeenCalled();
    expect(m.current).not.toHaveBeenCalled();
  });
});
