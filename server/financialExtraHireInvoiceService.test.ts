import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  source: vi.fn(),
  xero: vi.fn(),
  policy: vi.fn(),
  claims: vi.fn(),
  record: vi.fn(),
  claim: vi.fn(),
  bind: vi.fn(),
  complete: vi.fn(),
  hold: vi.fn(),
  writer: vi.fn(),
  contactV2Source: vi.fn(),
  contactV2Preview: vi.fn(),
  contactV2Execute: vi.fn(),
}));
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
vi.mock("./financialExtraHireInvoiceDb", () => ({
  getExtraHireDealClaims: m.claims,
  recordExtraHireEvidence: m.record,
  claimExtraHireEvidence: m.claim,
  bindExtraHirePayload: m.bind,
  completeExtraHireDraft: m.complete,
  holdExtraHireExecution: m.hold,
}));
vi.mock("./financialWriterExecutionService", () => ({
  executeGuardedFinancialWriterCommand: m.writer,
}));
vi.mock("./financialCustomerContactSourceV2", () => ({ readCurrentCustomerContactResolution: m.contactV2Source }));
vi.mock("./financialCustomerContactServiceV2", () => ({ previewCustomerContactResolution: m.contactV2Preview, executeCustomerContactCreationV2: m.contactV2Execute }));
import {
  previewExtraHireInvoice,
  processAutomaticExtraHireInvoice,
} from "./financialExtraHireInvoiceService";
import { EXTRA_HIRE_RELEASE_KEY } from "./financialExtraHireInvoiceRelease";
import { EXTRA_HIRE_RULES_HASH } from "./financialExtraHireInvoiceRules";
import { financialSha256 } from "./financialProposalIntegrity";
const facts = () => ({
  dealId: "5x77",
  dealNumber: "D77",
  containerNumber: "ABCU1234567",
  containerType: "20 Foot Standard",
  containerFeet: 20,
  hireDuration: 30,
  hireEndDate: "2026-01-31",
  customerVtigerId: "3x88",
  customerName: "Synthetic",
  customerKind: "organisation",
  sourceRefreshedAt: "2026-01-01T00:00:00Z",
  customerRefreshedAt: null,
  mappingEvidence: { hireEndDate: "cf_potentials_hireenddate" },
  sourceHoldReason: null,
});
const evidence = () => ({
  history: [],
  historyComplete: true,
  exactCandidateMatches: [],
  contactId: "contact-1",
  contactName: "Synthetic",
  item: {
    itemCode: "20' Hire",
    unitAmount: 45,
    accountCode: "210",
    taxType: "OUTPUT",
  },
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "false");
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED", "false");
  m.source.mockResolvedValue(facts());
  m.xero.mockResolvedValue(evidence());
  m.policy.mockResolvedValue(policy());
  m.claims.mockResolvedValue([]);
  m.record.mockResolvedValue({ id: 41, status: "previewed" });
  m.claim.mockResolvedValue(true);
  m.writer
    .mockReset()
    .mockResolvedValue({
      outcome: "succeeded",
      executionId: 11,
      result: { xeroDocumentId: "xero-1", documentNumber: "INV-77-EH1" },
    });
  m.contactV2Source.mockResolvedValue({ dealId: "5x77", billingKind: "organisation", customerVtigerId: "3x88", organisationName: "Synthetic", contactName: null, name: "Synthetic", email: "customer@example.test", linkedAccountId: "3x88", linkedContactId: null, sourceFieldsUsed: ["Accounts.accountname"], resolvedAt: "2026-01-01T00:00:00.000Z", sourceSnapshotHash: "v".repeat(64) });
  m.contactV2Preview.mockReset();
  m.contactV2Execute.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
const noWrites = () => {
  for (const fn of [m.record, m.claim, m.bind, m.complete, m.hold, m.writer])
    expect(fn).not.toHaveBeenCalled();
};
describe("Extra Hire current source preview and automatic receiver lifecycle", () => {
  it("read-only preview refreshes exact source/history/candidate and saves nothing", async () => {
    const r = await previewExtraHireInvoice("5x77");
    expect(r).toMatchObject({
      state: "previewed",
      ordinal: 1,
      noWrites: true,
      preview: {
        proposedInvoiceNumber: "INV-77-EH1",
        document: { partySourceId: "contact-1", total: 212.16 },
      },
    });
    expect(m.xero.mock.calls).toEqual([
      ["D77", "Synthetic", 20, undefined, {}],
      ["D77", "Synthetic", 20, "INV-77-EH1", {}],
    ]);
    noWrites();
  });
  it("records a v2 would-create contact decision as a no-write Extra Hire preview", async () => {
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
    const plan = { source: await m.contactV2Source(), status: "would_create", outcome: "would_create_contact", contactId: null, contactName: "Synthetic", includeEmailOnCreate: true, lookupOrder: ["name", "email"], nameMatchCount: 0, emailMatchCount: 0, holdReason: null };
    m.contactV2Preview.mockResolvedValue(plan);
    const result = await previewExtraHireInvoice("5x77");
    expect(result).toMatchObject({ state: "held", noWrites: true, customerContactPlan: { outcome: "would_create_contact" } });
    expect(m.xero.mock.calls[0]).toEqual(["D77", "Synthetic", 20, undefined, { skipContactLookup: true }]);
    expect(m.contactV2Execute).not.toHaveBeenCalled();
    noWrites();
  });
  it("creates a v2 contact only after a held preview, then refreshes Extra Hire evidence before the Draft", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED", "true");
    const wouldCreate = { source: await m.contactV2Source(), status: "would_create", outcome: "would_create_contact", contactId: null, contactName: "Synthetic", includeEmailOnCreate: true, lookupOrder: ["name", "email"], nameMatchCount: 0, emailMatchCount: 0, holdReason: null };
    const matched = { ...wouldCreate, status: "matched", outcome: "matched_by_name", contactId: "v2-contact", includeEmailOnCreate: false };
    m.contactV2Preview.mockResolvedValueOnce(wouldCreate).mockResolvedValueOnce(matched);
    m.contactV2Execute.mockResolvedValue({ ...matched, status: "created", outcome: "created_contact", contactEventId: 99, contactWritesAttempted: 1 });
    const result = await processAutomaticExtraHireInvoice("5x77");
    expect(result).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 2 });
    expect(m.contactV2Execute).toHaveBeenCalledTimes(1);
    expect(m.xero.mock.calls[0]).toEqual(["D77", "Synthetic", 20, undefined, { skipContactLookup: true }]);
    expect(m.xero.mock.calls[2]).toEqual(["D77", "Synthetic", 20, undefined, { contactOverride: { contactId: "v2-contact", contactName: "Synthetic" } }]);
    expect(m.writer.mock.invocationCallOrder[0]).toBeGreaterThan(m.contactV2Execute.mock.invocationCallOrder[0]!);
  });
  it("default-off process rejects before source, ledger/Xero/alerts", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "");
    await expect(processAutomaticExtraHireInvoice("5x77")).rejects.toThrow(
      /release disabled/
    );
    expect(m.source).not.toHaveBeenCalled();
    expect(m.xero).not.toHaveBeenCalled();
    noWrites();
  });
  it("invalid policy blocks source even with valid flag", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.policy.mockResolvedValue({
      ...policy(),
      operationsExtraHireHandoff: false,
    });
    await expect(processAutomaticExtraHireInvoice("5x77")).rejects.toThrow(
      /release disabled/
    );
    expect(m.source).not.toHaveBeenCalled();
    noWrites();
  });
  it("unknown suffix/date semantics holds, never creates based on legacy -D helper", async () => {
    m.policy.mockResolvedValue({
      ...policy(),
      invoiceSuffixCollisionSchemeConfirmed: false,
      dateSemantics: null,
    });
    const r = await previewExtraHireInvoice("5x77");
    expect(r.state).toBe("held");
    expect(r.holdReason).toMatch(/Legacy suffix/);
    expect(r.preview.document).toBeNull();
    noWrites();
  });
  it("mapping/source hold and expected D-number mismatch stop Xero and never save preview", async () => {
    m.source.mockResolvedValue({
      ...facts(),
      sourceHoldReason: "Mapping ambiguous",
    });
    expect((await previewExtraHireInvoice("5x77")).holdReason).toMatch(
      /ambiguous/
    );
    m.source.mockResolvedValue(facts());
    expect((await previewExtraHireInvoice("5x77", "D78")).holdReason).toMatch(
      /named D-number/
    );
    expect(m.xero).not.toHaveBeenCalled();
    noWrites();
  });
  it("stale source or changed approved mapping records held evidence with zero writes", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.source.mockResolvedValue({
      ...facts(),
      sourceRefreshedAt: "2025-01-01T00:00:00Z",
    });
    expect(await processAutomaticExtraHireInvoice("5x77")).toMatchObject({
      ok: false,
      status: "held",
      xeroWritesAttempted: 0,
    });
    expect(m.claim).not.toHaveBeenCalled();
    m.source.mockResolvedValue({
      ...facts(),
      mappingEvidence: { hireEndDate: "changed" },
    });
    expect(await processAutomaticExtraHireInvoice("5x77")).toMatchObject({
      ok: false,
      status: "held",
      xeroWritesAttempted: 0,
    });
    expect(m.writer).not.toHaveBeenCalled();
  });
  it("exclusive claim collision never binds or calls writer", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.claim.mockResolvedValueOnce(false);
    expect(await processAutomaticExtraHireInvoice("5x77")).toMatchObject({
      ok: false,
      status: "held",
      xeroWritesAttempted: 0,
    });
    expect(m.bind).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });
  it("verified exact Draft completion is recorded with no CRM source/plan in writer command", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_VTIGER_POST_SUCCESS_ENABLED", "true");
    const r = await processAutomaticExtraHireInvoice("5x77");
    expect(r).toMatchObject({
      ok: true,
      status: "drafts_created",
      invoiceNumber: "INV-77-EH1",
      xeroWritesAttempted: 1,
    });
    expect(m.complete).toHaveBeenCalledWith(
      41,
      expect.any(String),
      11,
      "xero-1"
    );
    const cmd = m.writer.mock.calls[0][0];
    expect(cmd.authorisation).toMatchObject({
      extraHireAutomaticEventId: 41,
      extraHireReleaseKey: EXTRA_HIRE_RELEASE_KEY,
    });
    expect(cmd).not.toHaveProperty("postSuccessPlan");
    expect(cmd).not.toHaveProperty("sourceRecordId");
  });
  it.each(["reconciliation_required", "duplicate"])(
    "%s execution stays claimed and uncertain without success/CRM",
    async outcome => {
      vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
      m.writer.mockResolvedValue({ outcome, executionId: 11 });
      expect(await processAutomaticExtraHireInvoice("5x77")).toMatchObject({
        ok: false,
        status: "reconciliation_required",
      });
      expect(m.complete).not.toHaveBeenCalled();
      expect(m.hold).toHaveBeenCalledWith(
        41,
        expect.stringMatching(/reconciliation/)
      );
    }
  );
});
