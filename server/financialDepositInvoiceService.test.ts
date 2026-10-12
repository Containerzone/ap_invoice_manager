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
}));
vi.mock("./vtigerFinancialReadService", () => ({
  retrieveCurrentVtigerFinancialRecord: m.retrieve,
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
    { name: "cf_real_amount", label: "Deposit Amount Required" },
    { name: "cf_real_supply", label: "Empty Container Supply Date" },
    { name: "cf_real_collection", label: "Full Container Collection Date" },
  ],
});
const deal = (patch: Record<string, unknown> = {}) => ({
  id: "5x77",
  potential_no: "D702877",
  potentialname: "Named Deal",
  related_to: "4x2",
  contact_id: "12x3",
  cf_real_status: "PENDING",
  cf_real_amount: "110.00",
  cf_real_supply: "2026-10-12",
  cf_real_collection: "",
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
  m.retrieve.mockImplementation(async (id: string) =>
    id === "5x77"
      ? deal()
      : id === "4x2"
        ? {
            id,
            accountname: "Customer Pty Ltd",
            modifiedtime: "2026-10-10T01:00:00Z",
          }
        : { id, firstname: "Jane", lastname: "Customer" }
  );
  m.describe.mockResolvedValue(fieldMetadata());
  m.preflight.mockResolvedValue([ready()]);
  m.item.mockResolvedValue({
    itemCode: "Deposit Required",
    accountCode: "201",
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
});
afterEach(() => vi.unstubAllEnvs());
describe("Deposit exact current source and read-only preview", () => {
  it("refreshes exact Deal and Deal organisation first, resolves metadata labels, and previews without any local or remote write", async () => {
    const result = await previewDepositInvoice("5x77");
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual(["5x77", "4x2"]);
    expect(m.describe).toHaveBeenCalledWith("Potentials");
    expect(result).toMatchObject({
      state: "previewed",
      noWrites: true,
      facts: {
        mappingEvidence: {
          depositStatus: "cf_real_status",
          depositAmountRequired: "cf_real_amount",
        },
      },
    });
    expect(result.preview.document).toMatchObject({
      proposedDocumentNumber: "INV-702877-D",
      total: 110,
      accountCode: "201",
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
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual(["5x77", "12x3"]);
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
        ? deal({ cf_real_supply: undefined, cf_real_collection: undefined })
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
});
