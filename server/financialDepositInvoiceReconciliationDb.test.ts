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
