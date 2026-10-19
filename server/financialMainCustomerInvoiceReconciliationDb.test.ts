import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  db: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  values: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  rows: [] as any[],
}));
vi.mock("./db", () => ({ getDb: m.db }));

import {
  MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE,
  classifyMainCustomerInvoiceReconciliationOrigin,
  isEligibleMainCustomerInvoiceLocalValidationFailure,
  isEligibleMainCustomerInvoiceReconciliationOriginal,
  reserveMainCustomerInvoiceReconciliation,
} from "./financialMainCustomerInvoiceReconciliationDb";
import { MAIN_CUSTOMER_INVOICE_RULES_HASH } from "./financialMainCustomerInvoiceDrafts";
import { financialSha256 } from "./financialProposalIntegrity";

const scope = MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE;
function original(patch: Record<string, unknown> = {}) {
  return {
    id: 750001,
    dealId: "5x490313",
    dealNumber: "D702946",
    quoteId: "20x946",
    quoteNumber: "Q-702946",
    proposedInvoiceNumber: "INV-702946",
    customerVtigerId: "4x946",
    customerName: "Customer",
    sourceRefreshedAt: new Date(),
    sourceSnapshotHash: "s".repeat(64),
    rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH,
    xeroPreflightHash: "x".repeat(64),
    proposal: {},
    xeroPreflight: {},
    xeroInvoiceId: null,
    releaseKey: "MAIN",
    authorisedPayload: {
      hash: "a".repeat(64),
      number: "INV-702946",
      bodyHash: "b".repeat(64),
    },
    processingToken: null,
    status: "reconciliation_required",
    holdReason: "held",
    executionId: null,
    ...patch,
  };
}
function failed(patch: Record<string, unknown> = {}) {
  return {
    id: 1110001,
    executionKey: "FWX-1",
    workflowType: "main_customer_invoice",
    documentFamily: "customer_invoice",
    proposedAction: "create_draft",
    proposedDocumentNumber: "INV-702946",
    targetXeroDocumentId: null,
    endpoint: "/Invoices",
    method: "POST",
    idempotencyKey: "c".repeat(64),
    payloadFingerprint: "c".repeat(24) + ":POST:/Invoices",
    status: "failed",
    approvalReference: "MAIN",
    safePayloadSummary: {},
    xeroDocumentId: null,
    xeroDocumentStatus: null,
    xeroResponseSummary: null,
    errorMessage: scope.validationError,
    preparedBy: 7,
    submittedAt: new Date(),
    completedAt: new Date(),
    ...patch,
  };
}
const evidence = () => ({
  originalEventId: 750001,
  failedWriterExecutionId: 1110001,
  dealId: "5x490313",
  dealNumber: "D702946",
  invoiceNumber: "INV-702946",
  originalEventHash: "o".repeat(64),
  failedWriterEvidenceHash: "f".repeat(64),
  sourceSnapshotHash: "s".repeat(64),
  xeroPreflightHash: "x".repeat(64),
  sourceSnapshot: {},
  proposal: {},
  xeroPreflight: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  m.rows = [];
  m.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => [m.rows.shift()].filter(Boolean) }),
    }),
  }));
  m.insert.mockImplementation(() => ({ values: m.values }));
  m.values.mockResolvedValue(undefined);
  m.update.mockImplementation(() => ({ set: m.set }));
  m.set.mockImplementation(() => ({ where: m.where }));
  m.db.mockResolvedValue({
    select: m.select,
    insert: m.insert,
    update: m.update,
  });
});

describe("Main Invoice exact local-validation recovery receipt", () => {
  it("accepts exactly D702946 original event 750001 and its exact local no-POST validation execution 1110001", () => {
    expect(
      isEligibleMainCustomerInvoiceReconciliationOriginal(original(), 750001)
    ).toBe(true);
    expect(isEligibleMainCustomerInvoiceLocalValidationFailure(failed())).toBe(
      true
    );
    expect(
      classifyMainCustomerInvoiceReconciliationOrigin({
        original: original(),
        failedExecution: failed(),
        originalEventId: 750001,
      })
    ).toEqual({
      dealId: "5x490313",
      dealNumber: "D702946",
      invoiceNumber: "INV-702946",
      total: 9932.07,
    });
  });

  it.each([
    { original: original({ id: 750002 }) },
    { original: original({ status: "held" }) },
    { original: original({ processingToken: "old" }) },
    { original: original({ xeroInvoiceId: "xero" }) },
    { original: original({ executionId: 2 }) },
    { failed: failed({ id: 1110002 }) },
    { failed: failed({ status: "reconciliation_required" }) },
    { failed: failed({ xeroResponseSummary: { status: 504 } }) },
    { failed: failed({ xeroDocumentId: "xero" }) },
    { failed: failed({ submittedAt: null }) },
    { failed: failed({ errorMessage: "another validation error" }) },
  ])(
    "rejects arbitrary/reconciliation/uncertain/Xero/duplicate receipt conditions %#",
    patch => {
      expect(() =>
        classifyMainCustomerInvoiceReconciliationOrigin({
          original: patch.original ?? original(),
          failedExecution: patch.failed ?? failed(),
          originalEventId: 750001,
        })
      ).toThrow(/exact D702946 locally-known/);
    }
  );

  it("reuses an identical generated recovery receipt idempotently and blocks a changed duplicate evidence receipt", async () => {
    const matching = {
      id: 750002,
      recoveryKey: financialSha256(evidence()),
      status: "reserved",
    };
    m.rows = [matching];
    await expect(
      reserveMainCustomerInvoiceReconciliation({
        ...evidence(),
        token: "first",
      })
    ).resolves.toMatchObject({ state: "already_reserved", event: matching });
    expect(m.insert).not.toHaveBeenCalled();

    const extant = { id: 750002, recoveryKey: "different", status: "reserved" };
    m.rows = [extant];
    const result = await reserveMainCustomerInvoiceReconciliation({
      ...evidence(),
      token: "first",
    });
    expect(result).toMatchObject({ state: "blocked", event: extant });
    expect(m.insert).not.toHaveBeenCalled();
  });
});
