import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  db: vi.fn(),
  selectRows: [] as any[],
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  values: vi.fn(),
  duplicate: vi.fn(),
  current: vi.fn(),
  preflight: vi.fn(),
  item: vi.fn(),
  policy: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialDepositInvoiceSource", () => ({
  readDepositInvoiceFacts: m.current,
}));
vi.mock("./financialReadOnlyXeroService", () => ({
  preflightFinancialXeroIntents: m.preflight,
  readDepositInvoiceXeroItemConfiguration: m.item,
}));
vi.mock("./financialDepositInvoiceRelease", async original => ({
  ...(await original<any>()),
  getDepositInvoiceReleasePolicy: m.policy,
}));
vi.mock("./financialProductionWriter", () => ({
  prepareFinancialDraftPayload: vi.fn(document => ({
    method: "POST",
    endpoint: "/Invoices",
    documentFamily: "customer_invoice",
    documentNumber: document.proposedDocumentNumber,
    expectedXeroDocumentId: null,
    idempotencyKey: "a".repeat(64),
    body: {
      Invoices: [
        {
          InvoiceNumber: document.proposedDocumentNumber,
          Type: "ACCREC",
          Status: "DRAFT",
          LineAmountTypes: "Inclusive",
          Contact: { ContactID: document.partySourceId },
          Date: document.issueDate.toISOString().slice(0, 10),
          DueDate: document.dueDate.toISOString().slice(0, 10),
          LineItems: document.lineItems.map((line: any) => ({
            ItemCode: line.itemCode,
            Description: line.description,
            Quantity: line.quantity,
            UnitAmount: line.unitAmount,
            TaxType: "OUTPUT",
            AccountCode: line.accountCode,
          })),
        },
      ],
    },
  })),
}));
import {
  bindDepositInvoicePayload,
  claimDepositInvoicePreview,
  completeDepositInvoiceDraft,
  depositInvoicePayloadHash,
  holdDepositInvoiceExecution,
  recordDepositInvoicePreview,
  verifyDepositInvoiceAutomaticWriteAccess,
} from "./financialDepositInvoiceDb";
import {
  buildDepositInvoice,
  DEPOSIT_INVOICE_RULES_HASH,
  DEPOSIT_INVOICE_RULES_VERSION,
  type DepositInvoiceFacts,
} from "./financialDepositInvoiceDrafts";
import {
  financialSha256,
  sourceSnapshotHash,
} from "./financialProposalIntegrity";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
const facts = (): DepositInvoiceFacts => ({
  dealId: "5x77",
  dealNumber: "D702877",
  depositStatus: "PENDING",
  depositAmountRequiredInclusive: 110,
  customerVtigerId: "4x2",
  customerName: "Customer Pty Ltd",
  customerKind: "organisation",
  emptyContainerSupplyDate: "2026-10-12",
  fullContainerCollectionDate: "",
  sourceRefreshedAt: "2026-10-11T01:00:00Z",
  customerRefreshedAt: null,
  mappingEvidence: {},
  sourceHoldReason: null,
});
const preflight = () => ({
  documentNumber: "INV-702877-D",
  documentFamily: "customer_invoice",
  duplicateState: "not_found",
  xeroDocumentId: null,
  status: null,
  error: null,
  partyName: null,
  contactCheck: {
    found: true,
    count: 1,
    contactId: "customer",
    partyName: "Customer Pty Ltd",
  },
  itemChecks: [{ itemCode: "Deposit Required", found: true }],
});
function readyEvent() {
  const source = facts();
  const proposal = buildDepositInvoice(
    source,
    new Date("2026-10-11T00:00:00Z")
  ).document!;
  proposal.partySourceId = "customer";
  proposal.accountCode = "201";
  proposal.lineItems[0]!.accountCode = "201";
  const sourceHash = sourceSnapshotHash({
    ...source,
    rulesVersion: DEPOSIT_INVOICE_RULES_VERSION,
  });
  const payload = prepareFinancialDraftPayload(
    proposal,
    `${source.dealId}:deposit_invoice:${sourceHash}`
  );
  (payload.body.Invoices as any[])[0].CurrencyCode = "AUD";
  return {
    id: 61,
    dealId: source.dealId,
    proposedInvoiceNumber: proposal.proposedDocumentNumber,
    claimedDealId: source.dealId,
    claimedInvoiceNumber: proposal.proposedDocumentNumber,
    status: "reserved",
    processingToken: "token",
    releaseKey: "DEPOSIT-test",
    rulesSnapshotHash: DEPOSIT_INVOICE_RULES_HASH,
    sourceSnapshot: source,
    sourceSnapshotHash: sourceHash,
    proposal: JSON.parse(JSON.stringify(proposal)),
    xeroPreflight: preflight(),
    xeroPreflightHash: financialSha256(preflight()),
    authorisedPayload: {
      number: payload.documentNumber,
      hash: depositInvoicePayloadHash(payload),
      payload,
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.selectRows = [];
  m.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => m.selectRows.shift() ?? [] }),
    }),
  }));
  m.duplicate.mockResolvedValue(undefined);
  m.values.mockReturnValue({ onDuplicateKeyUpdate: m.duplicate });
  m.insert.mockReturnValue({ values: m.values });
  m.where.mockResolvedValue([{ affectedRows: 1 }]);
  m.set.mockReturnValue({ where: m.where });
  m.update.mockReturnValue({ set: m.set });
  m.db.mockResolvedValue({
    select: m.select,
    insert: m.insert,
    update: m.update,
  });
  m.current.mockResolvedValue(facts());
  m.preflight.mockResolvedValue([preflight()]);
  m.item.mockResolvedValue({
    itemCode: "Deposit Required",
    accountCode: "201",
    taxType: "OUTPUT",
  });
  m.policy.mockResolvedValue({
    releaseKey: "DEPOSIT-test",
    rulesHash: DEPOSIT_INVOICE_RULES_HASH,
    enabled: true,
    approvedBy: 7,
    approvedAt: "2026-01-01T00:00:00Z",
    effectiveFrom: "2026-10-01T00:00:00Z",
    depositOnlyVtigerBranch: true,
    operationsDepositHandoff: true,
    sourceMappingsConfirmed: true,
    isolatedDraftOnlyApproved: true,
    migrationScope: "new_events_only",
  });
  vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());
describe("Deposit immutable event/payload ledger", () => {
  it("appends source/preflight receipts and only permits a duplicate evidence-key no-op", async () => {
    m.selectRows.push([{ id: 61 }]);
    await recordDepositInvoicePreview({
      facts: facts(),
      sourceHash: "a".repeat(64),
      proposal: null,
      preflight: null,
      proposedInvoiceNumber: "INV-702877-D",
      status: "held",
      holdReason: "Mapping unresolved",
    });
    expect(m.values).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSnapshot: facts(),
        status: "held",
        postconditionHold: expect.stringContaining("never amends"),
      })
    );
    expect(Object.keys(m.duplicate.mock.calls[0]![0].set)).toEqual([
      "evidenceKey",
    ]);
    expect(m.update).not.toHaveBeenCalled();
  });
  it("claims exact source/preflight hashes, handles unique-number collision and never permits rebinding payload", async () => {
    m.selectRows.push([readyEvent()]);
    m.where.mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" })
    );
    expect(
      await claimDepositInvoicePreview(
        61,
        "token",
        "source-hash",
        "preflight-hash"
      )
    ).toBe(false);
    expect(m.set).toHaveBeenCalledWith(
      expect.objectContaining({
        claimedDealId: "5x77",
        claimedInvoiceNumber: "INV-702877-D",
        status: "reserved",
      })
    );
    m.where.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(
      bindDepositInvoicePayload(
        61,
        "token",
        "DEPOSIT-test",
        readyEvent().authorisedPayload.payload
      )
    ).rejects.toThrow(/bound once/);
  });
  it("keeps exact claim keys on hold and requires an exclusive token to mark Draft success", async () => {
    await holdDepositInvoiceExecution(61, "Unknown Xero response");
    expect(m.set).toHaveBeenCalledWith({
      status: "reconciliation_required",
      processingToken: null,
      holdReason: "Unknown Xero response",
    });
    m.where.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(
      completeDepositInvoiceDraft({
        eventId: 61,
        token: "lost",
        executionId: 91,
        xeroInvoiceId: "xero",
      })
    ).rejects.toThrow(/reconciliation/);
  });
  it("independently rereads the exact current Deal and GET-only Xero evidence before permitting the immutable payload", async () => {
    const event = readyEvent();
    m.selectRows.push([event]);
    await verifyDepositInvoiceAutomaticWriteAccess({
      eventId: 61,
      releaseKey: "DEPOSIT-test",
      preparedBy: 7,
      payload: event.authorisedPayload.payload,
    });
    expect(m.current).toHaveBeenCalledWith("5x77");
    expect(m.preflight).toHaveBeenCalledTimes(1);
    expect(m.item).toHaveBeenCalledTimes(1);
    expect(m.update).not.toHaveBeenCalled();
  });
  it("holds tampered payload before upstream reads, and changed source or deleted collision before transport", async () => {
    const event = readyEvent();
    m.selectRows.push([event]);
    await expect(
      verifyDepositInvoiceAutomaticWriteAccess({
        eventId: 61,
        releaseKey: "DEPOSIT-test",
        preparedBy: 7,
        payload: {
          ...event.authorisedPayload.payload,
          documentNumber: "INV-702877",
        },
      })
    ).rejects.toThrow(/immutable exact-payload/);
    expect(m.current).not.toHaveBeenCalled();
    m.selectRows.push([event]);
    m.current.mockResolvedValue({
      ...facts(),
      depositAmountRequiredInclusive: 220,
    });
    await expect(
      verifyDepositInvoiceAutomaticWriteAccess({
        eventId: 61,
        releaseKey: "DEPOSIT-test",
        preparedBy: 7,
        payload: event.authorisedPayload.payload,
      })
    ).rejects.toThrow(/Deal changed/);
    expect(m.preflight).not.toHaveBeenCalled();
    m.selectRows.push([event]);
    m.current.mockResolvedValue(facts());
    m.preflight.mockResolvedValue([
      {
        ...preflight(),
        duplicateState: "found",
        status: "DELETED",
        xeroDocumentId: "old",
      },
    ]);
    await expect(
      verifyDepositInvoiceAutomaticWriteAccess({
        eventId: 61,
        releaseKey: "DEPOSIT-test",
        preparedBy: 7,
        payload: event.authorisedPayload.payload,
      })
    ).rejects.toThrow(/deleted history/);
  });
});
