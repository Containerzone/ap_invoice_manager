import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  retrieve: vi.fn(),
  describe: vi.fn(),
  preflight: vi.fn(),
  item: vi.fn(),
  record: vi.fn(),
  claim: vi.fn(),
  previous: vi.fn(),
  bind: vi.fn(),
  complete: vi.fn(),
  hold: vi.fn(),
  writer: vi.fn(),
  policy: vi.fn(),
  contactSource: vi.fn(),
  contactResolution: vi.fn(),
  contactV2Source: vi.fn(),
  contactV2Preview: vi.fn(),
  contactV2Execute: vi.fn(),
  billingSync: vi.fn(),
  deduction: vi.fn(),
}));
vi.mock("./vtigerFinancialReadService", () => ({
  retrieveCurrentVtigerFinancialRecord: m.retrieve,
  queryCurrentVtigerFinancialRecords: vi.fn(async () => [{ id: "20x9", quote_no: "Q-702877", modifiedtime: "2026-10-11T02:00:00Z" }]),
  describeVtigerFinancialModuleFields: m.describe,
}));
vi.mock("./financialReadOnlyXeroService", () => ({
  preflightFinancialXeroIntents: m.preflight,
  readDepositInvoiceXeroItemConfiguration: m.item,
}));
vi.mock("./financialDepositInvoiceDb", async original => ({
  ...(await original<any>()),
  recordDepositInvoicePreview: m.record,
  claimDepositInvoicePreview: m.claim,
  getDepositInvoiceClaim: m.previous,
  bindDepositInvoicePayload: m.bind,
  completeDepositInvoiceDraft: m.complete,
  holdDepositInvoiceExecution: m.hold,
}));
vi.mock("./financialDepositInvoiceRelease", async original => ({
  ...(await original<any>()),
  getDepositInvoiceReleasePolicy: m.policy,
}));
vi.mock("./financialWriterExecutionService", () => ({
  executeGuardedFinancialWriterCommand: m.writer,
}));
vi.mock("./financialCustomerContactSource", () => ({
  readCurrentCustomerContactSource: m.contactSource,
}));
vi.mock("./financialCustomerContactService", () => ({
  resolveOrCreateAutomaticCustomerContact: m.contactResolution,
}));
vi.mock("./financialCustomerContactSourceV2", () => ({ readCurrentCustomerContactResolution: m.contactV2Source }));
vi.mock("./financialCustomerContactServiceV2", () => ({ previewCustomerContactResolution: m.contactV2Preview, executeCustomerContactCreationV2: m.contactV2Execute }));
vi.mock("./financialBillingPartySyncService", () => ({ processAutomaticBillingPartySync: m.billingSync }));
vi.mock("./financialDepositMainDeductionService", () => ({ processAutomaticDepositMainDeduction: m.deduction }));
import { readDepositInvoiceFacts } from "./financialDepositInvoiceSource";
import {
  previewDepositInvoice,
  processAutomaticDepositInvoice,
} from "./financialDepositInvoiceService";
import { DEPOSIT_INVOICE_RULES_HASH } from "./financialDepositInvoiceDrafts";
const fieldMetadata = () => ({
  name: "Potentials",
  fields: [
    { name: "potential_no", label: "Deal Number" },
    { name: "cf_real_status", label: "Deposit Status" },
    { name: "cf_potentials_extras", label: "Deposit Amount Required" },
    { name: "cf_potentials_emptycontainersupplydate", label: "Empty Container Supply Date" },
    { name: "cf_potentials_fullcontainercollectiondate", label: "Full Container Collection Date" },
  ],
});
const deal = (patch: Record<string, unknown> = {}) => ({
  id: "5x77",
  potential_no: "D702877",
  potentialname: "Named Deal",
  related_to: "4x2",
  contact_id: "12x3",
  cf_potentials_quotereference: "20x9",
  cf_real_status: "PENDING",
  cf_potentials_extras: "110.00",
  cf_potentials_emptycontainersupplydate: "2026-10-12",
  cf_potentials_fullcontainercollectiondate: "",
  modifiedtime: "2026-10-11T01:00:00Z",
  ...patch,
});
const ready = () => ({
  documentNumber: "INV-702877-D",
  documentFamily: "customer_invoice",
  duplicateState: "not_found",
  xeroDocumentId: null,
  status: null,
  partyName: null,
  error: null,
  contactCheck: {
    found: true,
    count: 1,
    contactId: "xero-customer",
    partyName: "Customer Pty Ltd",
  },
  itemChecks: [{ itemCode: "Deposit Required", found: true }],
});
beforeEach(() => {
  vi.clearAllMocks();
  m.deduction.mockReset(); m.deduction.mockResolvedValue({ status: "disabled", reason: "independently gated", xeroWritesAttempted: 0 });
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "false");
  vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "false");
  // This suite validates Deposit creation only. The separately released generic
  // Deposit-to-main writer has its own integration tests and must not perform
  // an unmocked Xero read when the deployed project environment enables it.
  vi.stubEnv("FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED", "false");
  m.billingSync.mockResolvedValue({ status: "unchanged", contactId: "xero-customer", xeroWritesAttempted: 0 });
  m.retrieve.mockImplementation(async (id: string) =>
    id === "5x77"
      ? deal()
      : id === "4x2"
        ? {
            id,
            accountname: "Customer Pty Ltd",
            modifiedtime: "2026-10-10T01:00:00Z",
          }
        : id === "20x9"
          ? { id, quote_no: "Q-702877", account_id: "4x2", modifiedtime: "2026-10-11T02:00:00Z" }
          : { id, firstname: "Jane", lastname: "Customer" }
  );
  m.describe.mockResolvedValue(fieldMetadata());
  m.preflight.mockResolvedValue([ready()]);
  m.item.mockResolvedValue({
    itemCode: "Deposit Required",
    accountCode: "200",
    taxType: "OUTPUT",
  });
  m.record.mockResolvedValue({ id: 61, status: "previewed" });
  m.claim.mockResolvedValue(true);
  m.previous.mockResolvedValue(null);
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
  m.writer.mockResolvedValue({
    outcome: "succeeded",
    executionId: 91,
    result: { documentNumber: "INV-702877-D", xeroDocumentId: "new-deposit" },
  });
  m.contactSource.mockResolvedValue({
    customerVtigerId: "4x2", customerKind: "organisation", name: "Customer Pty Ltd", email: "customer@example.test", phone: null,
    sourceSnapshotHash: "c".repeat(64),
  });
  m.contactResolution.mockResolvedValue({ status: "matched", contactId: "xero-customer", contactEventId: null, reason: null, contactWritesAttempted: 0 });
  m.contactV2Source.mockResolvedValue({ dealId: "5x77", billingKind: "organisation", customerVtigerId: "4x2", organisationName: "Customer Pty Ltd", contactName: "Jane Customer", name: "Customer Pty Ltd", email: "customer@example.test", linkedAccountId: "4x2", linkedContactId: "12x3", sourceFieldsUsed: ["Accounts.accountname"], resolvedAt: "2026-10-11T01:00:00.000Z", sourceSnapshotHash: "v".repeat(64) });
  m.contactV2Preview.mockReset();
  m.contactV2Preview.mockResolvedValue({ source: { sourceSnapshotHash: "v".repeat(64) }, status: "matched", contactId: "xero-customer", holdReason: null });
  m.contactV2Execute.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
describe("Deposit exact current source and read-only preview", () => {
  it("refreshes exact Deal and Deal organisation first, resolves metadata labels, and previews without any local or remote write", async () => {
    const result = await previewDepositInvoice("5x77");
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual(["5x77", "20x9", "4x2"]);
    expect(m.describe).toHaveBeenCalledWith("Potentials");
    expect(result).toMatchObject({
      state: "previewed",
      noWrites: true,
      facts: {
        mappingEvidence: {
          depositStatus: "cf_real_status",
          depositAmountRequired: "cf_potentials_extras",
        },
      },
    });
    expect(result.preview.document).toMatchObject({
      proposedDocumentNumber: "INV-702877-D",
      total: 110,
      accountCode: "200",
      partySourceId: "xero-customer",
    });
    expect(m.record).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });
  it("resolves the current Deal contact only when there is no organisation", async () => {
    m.retrieve.mockImplementation(async id =>
      id === "5x77"
        ? deal({ related_to: "" })
        : { id, firstname: "Jane", lastname: "Customer" }
    );
    const facts = await readDepositInvoiceFacts("5x77");
    expect(facts).toMatchObject({
      customerKind: "contact",
      customerVtigerId: "12x3",
      customerName: "Jane Customer",
    });
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual(["5x77", "20x9", "12x3"]);
  });
  it("holds missing/ambiguous schema fields rather than treating an absent Deposit Status as blank", async () => {
    m.describe.mockResolvedValue({
      ...fieldMetadata(),
      fields: fieldMetadata().fields.filter(
        field => field.label !== "Deposit Status"
      ),
    });
    expect((await previewDepositInvoice("5x77")).holdReason).toMatch(
      /mapping for Deposit Status/
    );
    expect(m.preflight).not.toHaveBeenCalled();
    m.describe.mockResolvedValue({
      ...fieldMetadata(),
      fields: [
        ...fieldMetadata().fields,
        { name: "other", label: "Deposit Status" },
      ],
    });
    expect((await previewDepositInvoice("5x77")).state).toBe("held");
  });
  it("treats absent optional date metadata as no Due Date, without guessing a fallback date", async () => {
    m.describe.mockResolvedValue({
      ...fieldMetadata(),
      fields: fieldMetadata().fields.filter(
        field => !["Empty Container Supply Date", "Full Container Collection Date"].includes(field.label)
      ),
    });
    m.retrieve.mockImplementation(async (id: string) =>
      id === "5x77"
        ? deal({ cf_potentials_emptycontainersupplydate: undefined, cf_potentials_fullcontainercollectiondate: undefined })
        : { id, accountname: "Customer Pty Ltd", modifiedtime: "2026-10-10T01:00:00Z" }
    );

    const result = await previewDepositInvoice("5x77");

    expect(result).toMatchObject({ state: "previewed", noWrites: true });
    expect(result.preview).toMatchObject({ eligible: true, dueDateSource: "not_set" });
    expect(result.preview.document?.dueDate).toBeNull();
    expect(result.facts.mappingEvidence).not.toHaveProperty("emptyContainerSupplyDate");
    expect(result.facts.mappingEvidence).not.toHaveProperty("fullContainerCollectionDate");
  });
  it("refuses mismatched retrieve IDs, non-Deals, changed business numbers and incomplete scalar fields", async () => {
    m.retrieve.mockResolvedValue({ id: "5x99" });
    await expect(previewDepositInvoice("5x77")).rejects.toThrow(
      /exact requested/
    );
    m.retrieve.mockImplementation(async id =>
      id === "5x77"
        ? deal({ potentialname: "", cf_real_status: undefined })
        : { id, accountname: "Customer Pty Ltd" }
    );
    expect((await previewDepositInvoice("5x77")).state).toBe("held");
    await expect(previewDepositInvoice("5x77", "D123")).rejects.toThrow(
      /exact lookup/
    );
  });
  it.each(["DRAFT", "AUTHORISED", "PAID", "VOIDED", "DELETED"])(
    "holds exact existing -D in %s without adoption or suffix",
    async status => {
      m.preflight.mockResolvedValue([
        { ...ready(), duplicateState: "found", status, xeroDocumentId: "old" },
      ]);
      const result = await previewDepositInvoice("5x77");
      expect(result).toMatchObject({
        state: "held",
        holdReason: expect.stringContaining("INV-702877-D"),
      });
      expect(result.preview.proposedInvoiceNumber).toBe("INV-702877-D");
      expect(m.item).not.toHaveBeenCalled();
      expect(m.writer).not.toHaveBeenCalled();
    }
  );
  it.each(["ambiguous", "error", "not_checked", "blocked"])(
    "holds incomplete/colliding preflight %s",
    async duplicateState => {
      m.preflight.mockResolvedValue([{ ...ready(), duplicateState }]);
      expect((await previewDepositInvoice("5x77")).state).toBe("held");
    }
  );
  it("holds mismatched exact preflight/customer and missing Deposit sales account", async () => {
    m.preflight.mockResolvedValue([
      { ...ready(), documentNumber: "INV-702877" },
    ]);
    expect((await previewDepositInvoice("5x77")).state).toBe("held");
    m.preflight.mockResolvedValue([
      { ...ready(), contactCheck: { ...ready().contactCheck, count: 2 } },
    ]);
    expect((await previewDepositInvoice("5x77")).state).toBe("held");
    m.preflight.mockResolvedValue([ready()]);
    m.item.mockRejectedValue(new Error("Unconfirmed sales account"));
    expect((await previewDepositInvoice("5x77")).holdReason).toMatch(
      /Unconfirmed sales account/
    );
  });
});
describe("Deposit isolated automatic path", () => {
  it("rejects before any source/preflight/read or writer while its own gate is disabled", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "false");
    await expect(processAutomaticDepositInvoice("5x77")).rejects.toThrow(
      /disabled/
    );
    expect(m.retrieve).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });
  it("binds one immutable payload and creates only a Deposit Draft with a held deduction postcondition", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    const result = await processAutomaticDepositInvoice("5x77");
    expect(result).toMatchObject({
      status: "drafts_created",
      invoiceNumber: "INV-702877-D",
      xeroWritesAttempted: 1,
      postconditionHold: expect.stringMatching(/never amends/),
    });
    expect(m.writer).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: "deposit_invoice",
        proposedAction: "create_draft",
        authorisation: expect.objectContaining({
          depositInvoiceAutomaticEventId: 61,
        }),
      })
    );
    expect(m.writer.mock.calls[0]![0].postSuccessPlan).toBeUndefined();
    expect(m.bind).toHaveBeenCalledTimes(1);
    expect(m.complete).toHaveBeenCalledTimes(1);
  });
  it("creates a customer contact only for the contact-only hold, refreshes preflight, then creates the Deposit Draft", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    m.preflight.mockResolvedValueOnce([{ ...ready(), contactCheck: { found: false, count: 0, contactId: null, partyName: "Customer Pty Ltd" } }])
      .mockResolvedValueOnce([ready()]);
    m.contactResolution.mockResolvedValue({ status: "created", contactId: "xero-customer", contactEventId: 31, reason: null, contactWritesAttempted: 1 });

    const result = await processAutomaticDepositInvoice("5x77");

    expect(result).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 2 });
    expect(m.contactResolution).toHaveBeenCalledTimes(1);
    expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(m.writer).toHaveBeenCalledTimes(1);
    expect(m.writer.mock.invocationCallOrder[0]).toBeGreaterThan(m.contactResolution.mock.invocationCallOrder[0]!);
  });
  it("keeps a v2 would-create preview read-only, then refreshes contact/invoice evidence before the Deposit Draft", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
    const wouldCreate = { source: await m.contactV2Source(), status: "would_create", outcome: "would_create_contact", contactId: null, contactName: "Customer Pty Ltd", includeEmailOnCreate: true, lookupOrder: ["name", "email"], nameMatchCount: 0, emailMatchCount: 0, holdReason: null };
    const matched = { ...wouldCreate, status: "matched", outcome: "matched_by_name", contactId: "v2-contact", includeEmailOnCreate: false };
    m.contactV2Preview.mockResolvedValueOnce(wouldCreate).mockResolvedValueOnce(wouldCreate).mockResolvedValueOnce(matched);
    m.contactV2Execute.mockResolvedValue({ ...matched, status: "created", outcome: "created_contact", contactEventId: 99, contactWritesAttempted: 1 });
    const preview = await previewDepositInvoice("5x77");
    expect(preview).toMatchObject({ state: "held", noWrites: true, customerContactPlan: { outcome: "would_create_contact" } });
    expect(m.contactV2Execute).not.toHaveBeenCalled();
    const result = await processAutomaticDepositInvoice("5x77");
    expect(result).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 2 });
    expect(m.contactV2Execute).toHaveBeenCalledTimes(1);
    expect(m.preflight).toHaveBeenCalledTimes(3);
    expect(m.writer.mock.invocationCallOrder[0]).toBeGreaterThan(m.contactV2Execute.mock.invocationCallOrder[0]!);
  });
  it("records an old source as held even when its customer was updated after cutover", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    m.retrieve.mockImplementation(async id =>
      id === "5x77"
        ? deal({ modifiedtime: "2026-09-01T00:00:00Z" })
        : {
            id,
            accountname: "Customer Pty Ltd",
            modifiedtime: "2026-10-11T02:00:00Z",
          }
    );
    expect((await processAutomaticDepositInvoice("5x77")).status).toBe("held");
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "held",
        holdReason: expect.stringContaining("predates"),
      })
    );
    expect(m.writer).not.toHaveBeenCalled();
  });
  it("a contact-only hold never bypasses the Deposit source cutover", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
    m.retrieve.mockImplementation(async id => id === "5x77"
      ? deal({ modifiedtime: "2026-09-01T00:00:00Z" })
      : { id, quote_no: "Q-702877" });
    m.contactV2Preview.mockResolvedValue({ source: await m.contactV2Source(), status: "would_create", contactId: null, holdReason: null });
    m.preflight.mockResolvedValue([{ ...ready(), contactCheck: { found: false, count: 0, contactId: null, partyName: "Customer Pty Ltd" } }]);
    expect(await processAutomaticDepositInvoice("5x77")).toMatchObject({ status: "held", warning: expect.stringContaining("predates"), xeroWritesAttempted: 0 });
    expect(m.contactV2Execute).not.toHaveBeenCalled(); expect(m.contactResolution).not.toHaveBeenCalled();
    expect(m.billingSync).not.toHaveBeenCalled(); expect(m.claim).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });
  it("holds an existing AP reservation and uncertain results instead of retrying", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    m.previous.mockResolvedValue({ id: 1, status: "reconciliation_required" });
    expect((await processAutomaticDepositInvoice("5x77")).status).toBe("held");
    expect(m.writer).not.toHaveBeenCalled();
    m.previous.mockResolvedValue(null);
    m.writer.mockResolvedValue({ outcome: "reconciliation_required" });
    expect((await processAutomaticDepositInvoice("5x77")).status).toBe(
      "reconciliation_required"
    );
    expect(m.hold).toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });
  it("syncs current main billing before a Deposit claim and then rereads the complete Deposit preflight", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
    m.billingSync.mockResolvedValue({ status: "updated", contactId: "xero-customer", sourceSnapshotHash: "v".repeat(64), xeroWritesAttempted: 1 });
    const result = await processAutomaticDepositInvoice("5x77");
    expect(result).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 2, billingSync: { status: "updated" } });
    expect(m.billingSync).toHaveBeenCalledWith("5x77", "deposit_invoice");
    expect(m.preflight).toHaveBeenCalledTimes(2);
    expect(m.claim.mock.invocationCallOrder[0]).toBeGreaterThan(m.billingSync.mock.invocationCallOrder[0]!);
    expect(m.writer.mock.invocationCallOrder[0]).toBeGreaterThan(m.preflight.mock.invocationCallOrder[1]!);
  });
  it("holds a billing sync failure without reserving or sending the Deposit", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.billingSync.mockResolvedValue({ status: "held", warning: "Main is AUTHORISED with another billing party", xeroWritesAttempted: 0 });
    expect(await processAutomaticDepositInvoice("5x77")).toMatchObject({ status: "held", warning: expect.stringMatching(/AUTHORISED/), xeroWritesAttempted: 0 });
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });
  it("refuses a further billing-party change between sync and Deposit preparation", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.billingSync.mockResolvedValue({ status: "updated", contactId: "other-contact", xeroWritesAttempted: 1 });
    expect(await processAutomaticDepositInvoice("5x77")).toMatchObject({ status: "held", warning: expect.stringMatching(/changed again/), xeroWritesAttempted: 1 });
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.writer).not.toHaveBeenCalled();
  });
  it("never syncs an existing consumed Deposit claim or a pre-cutover source", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.previous.mockResolvedValue({ id: 1, status: "reconciliation_required" });
    expect((await processAutomaticDepositInvoice("5x77")).status).toBe("held");
    expect(m.billingSync).not.toHaveBeenCalled();
  });

  it.each(["disabled", "not_ready", "held", "reconciliation_required"])("forwards deposit after real source/draft completion and keeps creation successful for %s", async status => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED", "true");
    m.deduction.mockResolvedValue({ status, reason: "exact postcondition reason", xeroWritesAttempted: 0 });
    const result = await processAutomaticDepositInvoice("5x77");
    expect(result).toMatchObject({ ok: true, status: "drafts_created", mainDeduction: { status } });
    expect(m.deduction).toHaveBeenCalledTimes(1); expect(m.deduction).toHaveBeenCalledWith("5x77", "deposit");
    expect(m.deduction.mock.invocationCallOrder[0]).toBeGreaterThan(m.complete.mock.invocationCallOrder[0]!);
    expect(m.retrieve).toHaveBeenCalled(); expect(m.writer).toHaveBeenCalledTimes(1);
  });

  it("forwards replay for a completed Deposit claim without recreating the invoice", async () => {
    vi.stubEnv("FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED", "true");
    m.previous.mockResolvedValue({ id: 61, status: "drafts_created" });
    m.deduction.mockResolvedValue({ status: "already_deducted", reason: "existing exact line", xeroWritesAttempted: 0 });
    expect(await processAutomaticDepositInvoice("5x77")).toMatchObject({ ok: false, status: "held" });
    expect(m.deduction).toHaveBeenCalledWith("5x77", "replay"); expect(m.writer).not.toHaveBeenCalled();
  });
});
