import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  db: vi.fn(),
  rows: [] as any[],
  select: vi.fn(),
  values: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  source: vi.fn(),
  xero: vi.fn(),
  policy: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialExtraHireInvoiceSource", () => ({
  readExtraHireFacts: m.source,
}));
vi.mock("./financialExtraHireInvoiceXero", () => ({
  readExtraHireXeroEvidence: m.xero,
}));
vi.mock("./financialExtraHireInvoiceRelease", async original => ({
  ...(await original<any>()),
  getExtraHireReleasePolicy: m.policy,
}));
import {
  bindExtraHirePayload,
  claimExtraHireEvidence,
  completeExtraHireDraft,
  consumeExtraHirePayload,
  holdExtraHireExecution,
  recordExtraHireEvidence,
  verifyExtraHireAutomaticWriteAccess,
} from "./financialExtraHireInvoiceDb";
import {
  buildExtraHireInvoice,
  EXTRA_HIRE_RULES_HASH,
  EXTRA_HIRE_RULES_VERSION,
} from "./financialExtraHireInvoiceRules";
import { EXTRA_HIRE_RELEASE_KEY } from "./financialExtraHireInvoiceRelease";
import {
  financialSha256,
  sourceSnapshotHash,
} from "./financialProposalIntegrity";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
const facts = () => ({
  dealId: "5x77",
  dealNumber: "D77",
  containerNumber: "ABCU1234567",
  containerType: "20 Foot Standard",
  containerFeet: 20 as const,
  hireDuration: 30,
  hireEndDate: "2026-01-31",
  customerVtigerId: "3x88",
  customerName: "Synthetic",
  customerKind: "organisation" as const,
  sourceRefreshedAt: "2026-01-01T00:00:00Z",
  customerRefreshedAt: null,
  mappingEvidence: { hireEndDate: "cf_potentials_hireenddate" },
  sourceHoldReason: null,
});
const policy = () => ({
  releaseKey: EXTRA_HIRE_RELEASE_KEY,
  rulesHash: EXTRA_HIRE_RULES_HASH,
  enabled: true,
  approvedBy: 7,
  approvedAt: "2026-01-01T00:00:00Z",
  effectiveFrom: "2026-01-01T00:00:00Z",
  extraHireOnlyVtigerBranch: true,
  operationsExtraHireHandoff: true,
  sourceMappingsConfirmed: true,
  sourceMappingsHash: financialSha256(facts().mappingEvidence),
  invoiceSuffixCollisionSchemeConfirmed: true,
  suffixScheme: "EH_AP_ORDINAL_V1",
  isolatedDraftOnlyApproved: true,
  postSuccessHireEndDateAcknowledged: true,
  dateSemantics: "CURRENT_HIRE_END_DATE_NO_DUE_DATE",
  migrationScope: "new_events_only",
});
const evidence = () => ({
  history: [],
  historyComplete: true,
  exactCandidateMatches: [],
  contactId: "contact-1",
  contactName: "Synthetic",
  item: {
    itemCode: "20' Hire" as const,
    unitAmount: 45,
    accountCode: "210",
    taxType: "OUTPUT" as const,
  },
});
function receipt() {
  const f = facts(),
    x = evidence();
  const sourceHash = sourceSnapshotHash({
    ...f,
    rulesVersion: EXTRA_HIRE_RULES_VERSION,
  });
  const proposal = buildExtraHireInvoice(
    f,
    "INV-77-EH1",
    x.item,
    policy().dateSemantics
  ).document!;
  proposal.partySourceId = x.contactId;
  const payload = prepareFinancialDraftPayload(
    proposal,
    `${f.dealId}:extra_hire:${f.hireEndDate}:1:${sourceHash}`
  );
  (payload.body.Invoices as any[])[0].CurrencyCode = "AUD";
  return {
    payload,
    input: {
      eventId: 5,
      releaseKey: policy().releaseKey,
      preparedBy: 7,
      payload,
    },
    event: {
      id: 5,
      evidenceKey: "a".repeat(64),
      dealId: f.dealId,
      dealNumber: f.dealNumber,
      sourceHireEndDate: f.hireEndDate,
      ordinal: 1,
      proposedInvoiceNumber: "INV-77-EH1",
      preflightAt: new Date(),
      sourceSnapshot: f,
      sourceSnapshotHash: sourceHash,
      rulesSnapshotHash: EXTRA_HIRE_RULES_HASH,
      xeroPreflight: x,
      xeroPreflightHash: financialSha256(x),
      proposal,
      claimedPeriodKey: `${f.dealId}:${f.hireEndDate}`,
      claimedOrdinalKey: `${f.dealId}:1`,
      claimedInvoiceNumber: "INV-77-EH1",
      releaseKey: policy().releaseKey,
      authorisedPayload: {
        hash: financialSha256(payload),
        number: "INV-77-EH1",
      },
      processingToken: "token",
      status: "reserved",
      submittedAt: null,
    } as any,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.where.mockReset().mockResolvedValue([{ affectedRows: 1 }]);
  m.values.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
  m.rows = [receipt().event];
  m.select.mockImplementation(() => ({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(m.rows), { limit: async () => m.rows }),
    }),
  }));
  m.set.mockImplementation(() => ({ where: m.where }));
  m.db.mockResolvedValue({
    select: m.select,
    insert: () => ({ values: m.values }),
    update: () => ({ set: m.set }),
  });
  m.source.mockResolvedValue(facts());
  m.xero.mockResolvedValue(evidence());
  m.policy.mockResolvedValue(policy());
});
afterEach(() => vi.unstubAllEnvs());
describe("Extra Hire immutable AP-only ledger", () => {
  it("revalidates current exact source, exact mappings and fresh Xero before one-time transport", async () => {
    await verifyExtraHireAutomaticWriteAccess(receipt().input);
    expect(m.source).toHaveBeenCalledWith("5x77");
    expect(m.xero).toHaveBeenCalledWith("D77", "Synthetic", 20, "INV-77-EH1");
    expect(m.set).not.toHaveBeenCalled();
  });
  it.each([
    "status",
    "processingToken",
    "claimedPeriodKey",
    "claimedOrdinalKey",
    "claimedInvoiceNumber",
    "releaseKey",
    "rulesSnapshotHash",
    "xeroPreflightHash",
  ])("rejects tampered %s claim before source read", async key => {
    m.rows[0][key] = key === "processingToken" ? null : "wrong";
    await expect(
      verifyExtraHireAutomaticWriteAccess(receipt().input)
    ).rejects.toThrow(/immutable/);
    expect(m.source).not.toHaveBeenCalled();
  });
  it("rejects source/proposal/payload tampering and stale/future source refresh", async () => {
    m.rows[0].sourceSnapshot.containerNumber = "forged";
    await expect(
      verifyExtraHireAutomaticWriteAccess(receipt().input)
    ).rejects.toThrow(/source integrity/);
    m.rows = [receipt().event];
    m.rows[0].proposal.total = 1;
    await expect(
      verifyExtraHireAutomaticWriteAccess(receipt().input)
    ).rejects.toThrow(/rebuilt/);
    m.rows = [receipt().event];
    m.rows[0].preflightAt = new Date(Date.now() - 301000);
    await expect(
      verifyExtraHireAutomaticWriteAccess(receipt().input)
    ).rejects.toThrow(/immutable/);
    m.rows = [receipt().event];
    m.rows[0].preflightAt = new Date(Date.now() + 10000);
    await expect(
      verifyExtraHireAutomaticWriteAccess(receipt().input)
    ).rejects.toThrow(/immutable/);
  });
  it("rejects current source or Xero change and wrong approver", async () => {
    m.source.mockResolvedValue({ ...facts(), containerNumber: "changed" });
    await expect(
      verifyExtraHireAutomaticWriteAccess(receipt().input)
    ).rejects.toThrow(/changed/);
    m.source.mockResolvedValue(facts());
    m.xero.mockResolvedValue({
      ...evidence(),
      item: { ...evidence().item, unitAmount: 50 },
    });
    await expect(
      verifyExtraHireAutomaticWriteAccess(receipt().input)
    ).rejects.toThrow(/Xero evidence changed/);
    await expect(
      verifyExtraHireAutomaticWriteAccess({ ...receipt().input, preparedBy: 8 })
    ).rejects.toThrow(/immutable/);
  });
  it("insert-only duplicate receipts never update source, proposal, history or live state", async () => {
    const row = receipt().event;
    m.values.mockRejectedValue({ code: "ER_DUP_ENTRY" });
    await recordExtraHireEvidence(row);
    expect(m.values).toHaveBeenCalledWith(row);
    expect(m.set).not.toHaveBeenCalled();
  });
  it("claim is exclusive for exact source period/AP ordinal/invoice and duplicate-key holds", async () => {
    m.rows = [
      {
        ...receipt().event,
        status: "previewed",
        processingToken: null,
        claimedPeriodKey: null,
      },
    ];
    expect(await claimExtraHireEvidence(5, "token", policy().releaseKey)).toBe(
      true
    );
    expect(m.set).toHaveBeenCalledWith(
      expect.objectContaining({
        claimedPeriodKey: "5x77:2026-01-31",
        claimedOrdinalKey: "5x77:1",
        claimedInvoiceNumber: "INV-77-EH1",
        status: "reserved",
      })
    );
    m.where.mockRejectedValueOnce({ code: "ER_DUP_ENTRY" });
    expect(await claimExtraHireEvidence(5, "token", policy().releaseKey)).toBe(
      false
    );
  });
  it("binds once and consumed/stale CAS never becomes retry eligible", async () => {
    await bindExtraHirePayload(5, "token", receipt().payload);
    expect(m.set).toHaveBeenCalledWith({
      authorisedPayload: {
        hash: financialSha256(receipt().payload),
        number: "INV-77-EH1",
      },
    });
    m.where.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(
      bindExtraHirePayload(5, "token", receipt().payload)
    ).rejects.toThrow(/once/);
    await expect(consumeExtraHirePayload(5, 11)).rejects.toThrow(
      /already submitted/
    );
    await expect(
      completeExtraHireDraft(5, "token", 11, "xero-1")
    ).rejects.toThrow(/reconciliation/);
  });
  it("one-way submit and reconciliation preserve immutable payload/evidence/all claims", async () => {
    await consumeExtraHirePayload(5, 11);
    expect(m.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "submitted", executionId: 11 })
    );
    await holdExtraHireExecution(5, "uncertain");
    const patch = m.set.mock.calls.at(-1)![0];
    expect(patch).toMatchObject({
      status: "reconciliation_required",
      processingToken: null,
    });
    for (const k of [
      "claimedInvoiceNumber",
      "claimedPeriodKey",
      "claimedOrdinalKey",
      "sourceSnapshot",
      "proposal",
      "xeroPreflight",
      "authorisedPayload",
    ])
      expect(patch).not.toHaveProperty(k);
  });
  it("completed receipts are never changed into retryable hold", async () => {
    m.rows[0].status = "drafts_created";
    await holdExtraHireExecution(5, "error");
    expect(m.set).not.toHaveBeenCalled();
  });
});
