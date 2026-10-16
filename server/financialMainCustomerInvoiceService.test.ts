import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  preflight: vi.fn(),
  recordPreview: vi.fn().mockResolvedValue({ id: 51, status: "previewed" }),
  getEvent: vi.fn(), claim: vi.fn(), bind: vi.fn(), complete: vi.fn(), hold: vi.fn(),
  policy: vi.fn(), writer: vi.fn(), contactSource: vi.fn(), contactResolution: vi.fn(), contactV2Source: vi.fn(), contactV2Preview: vi.fn(), contactV2Execute: vi.fn(),
}));
const { retrieve, preflight, recordPreview } = mocks;
vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: mocks.retrieve }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: mocks.preflight }));
vi.mock("./financialMainCustomerInvoiceDb", () => ({
  recordMainCustomerInvoicePreview: mocks.recordPreview, getMainCustomerInvoiceEvent: mocks.getEvent, getMainCustomerInvoiceEvents: vi.fn(),
  bindMainCustomerInvoicePayload: mocks.bind, claimMainCustomerInvoicePreview: mocks.claim, completeMainCustomerInvoiceDraft: mocks.complete, holdMainCustomerInvoiceExecution: mocks.hold,
}));
vi.mock("./financialProposalIntegrity", () => ({ financialSha256: () => "f".repeat(64), sourceSnapshotHash: () => "a".repeat(64) }));
vi.mock("./financialMainCustomerInvoiceRelease", () => ({ assertMainCustomerInvoiceRelease: vi.fn(), getMainCustomerInvoiceReleasePolicy: mocks.policy }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: mocks.writer }));
vi.mock("./financialCustomerContactSource", () => ({ readCurrentCustomerContactSource: mocks.contactSource }));
vi.mock("./financialCustomerContactService", () => ({ resolveOrCreateAutomaticCustomerContact: mocks.contactResolution }));
vi.mock("./financialCustomerContactSourceV2", () => ({ readCurrentCustomerContactResolution: mocks.contactV2Source }));
vi.mock("./financialCustomerContactServiceV2", () => ({ previewCustomerContactResolution: mocks.contactV2Preview, executeCustomerContactCreationV2: mocks.contactV2Execute }));

import { previewMainCustomerInvoice, processAutomaticMainCustomerInvoice, readMainCustomerInvoiceFacts } from "./financialMainCustomerInvoiceService";

const readyPreflight = () => [{
  duplicateState: "not_found", status: null,
  contactCheck: { found: true, contactId: "xero-customer", count: 1, partyName: "Customer Pty Ltd" },
  itemChecks: [{ itemCode: "SER9", found: true, isSold: true, salesAccountCode: "200", salesTaxType: "OUTPUT", nativeDescription: "Loaded Container from <> to <>" }],
}];

beforeEach(() => {
  retrieve.mockReset(); preflight.mockReset(); recordPreview.mockClear(); mocks.getEvent.mockReset(); mocks.claim.mockReset(); mocks.bind.mockReset(); mocks.complete.mockReset(); mocks.hold.mockReset(); mocks.policy.mockReset(); mocks.writer.mockReset(); mocks.contactSource.mockReset(); mocks.contactResolution.mockReset(); mocks.contactV2Source.mockReset(); mocks.contactV2Preview.mockReset(); mocks.contactV2Execute.mockReset(); vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "");
  retrieve.mockImplementation(async (id: string) => {
    const records: Record<string, Record<string, unknown>> = {
      "5x77": { id: "5x77", potential_no: "D702877", cf_potentials_quotereference: "20x9", related_to: "4x2", cf_potentials_containersituationselectone: "SHIPPER OWN", cf_potentials_pickuplocation: "Origin", cf_potentials_deliverylocation: "Destination", modifiedtime: "2026-10-11T01:00:00Z" },
      "20x9": { id: "20x9", quote_no: "Q-702877", LineItems: { 1: { productid: "14x1", quantity: "2", listprice: "250" } }, modifiedtime: "2026-10-11T02:00:00Z" },
      "4x2": { id: "4x2", accountname: "Customer Pty Ltd" },
      "14x1": { id: "14x1", servicename: "Transport - Loaded Container" },
    };
    return records[id] ?? { id };
  });
  preflight.mockResolvedValue(readyPreflight());
  mocks.policy.mockResolvedValue({ releaseKey: "MAIN-test", enabled: true, approvedBy: 7, approvedAt: "2026-10-01T00:00:00Z", effectiveFrom: "2026-10-01T00:00:00Z", mainInvoiceOnlyVtigerBranch: true, operationsMainInvoiceHandoff: true });
  mocks.getEvent.mockResolvedValue({ id: 51, status: "previewed", proposedInvoiceNumber: "INV-702877" });
  mocks.claim.mockResolvedValue(true);
  mocks.contactSource.mockResolvedValue({ customerVtigerId: "4x2", customerKind: "organisation", name: "Customer Pty Ltd", email: "customer@example.test", phone: null, sourceSnapshotHash: "c".repeat(64) });
  mocks.contactResolution.mockResolvedValue({ status: "created", contactId: "xero-customer", contactEventId: 21, reason: null, contactWritesAttempted: 1 });
  mocks.writer.mockResolvedValue({ outcome: "succeeded", executionId: 91, result: { documentNumber: "INV-702877", xeroDocumentId: "invoice-1" } });
  mocks.contactV2Source.mockResolvedValue({ dealId: "5x77", billingKind: "organisation", customerVtigerId: "4x2", organisationName: "Customer Pty Ltd", contactName: null, name: "Customer Pty Ltd", email: "customer@example.test", linkedAccountId: "4x2", linkedContactId: null, sourceFieldsUsed: ["Accounts.accountname"], resolvedAt: "2026-10-11T01:00:00.000Z", sourceSnapshotHash: "v".repeat(64) });
});

describe("Main Customer Invoice current-source evidence", () => {
  it("re-reads Deal, Quote, organisation and each VTiger Service before forming a GET-only Xero-ready proposal", async () => {
    const facts = await readMainCustomerInvoiceFacts("5x77");
    expect(retrieve.mock.calls.map(([id]) => id)).toEqual(["5x77", "20x9", "4x2", "14x1"]);
    expect(facts).toMatchObject({ dealNumber: "D702877", quoteNumber: "Q-702877", customerName: "Customer Pty Ltd", serviceLines: [{ serviceVtigerId: "14x1", description: "Transport - Loaded Container", quantity: 2, unitAmount: 250 }] });
    const result = await previewMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ state: "previewed", noWrites: true });
    expect(result.preview.document).toMatchObject({ proposedDocumentNumber: "INV-702877", partySourceId: "xero-customer", total: 550, lineItems: [expect.objectContaining({ itemCode: "SER9", description: "Loaded Container from Origin to Destination" })] });
    expect(recordPreview).toHaveBeenCalledWith(expect.objectContaining({ status: "previewed", proposedInvoiceNumber: "INV-702877" }));
  });

  it("holds a source when Xero already has the exact INV number instead of adopting or suffixing it", async () => {
    preflight.mockResolvedValue([{ ...readyPreflight()[0], duplicateState: "found", status: "DRAFT" }]);
    const result = await previewMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ state: "held", noWrites: true, holdReason: expect.stringContaining("Exact Xero invoice INV-702877") });
    expect(recordPreview).toHaveBeenCalledWith(expect.objectContaining({ status: "held" }));
  });

  it("creates a contact only for a contact-only preflight hold, refreshes evidence, then writes the Draft", async () => {
    preflight.mockResolvedValueOnce(readyPreflight())
      .mockResolvedValueOnce([{ ...readyPreflight()[0], contactCheck: { found: false, contactId: null, count: 0, partyName: "Customer Pty Ltd" } }])
      .mockResolvedValueOnce(readyPreflight())
      .mockResolvedValueOnce(readyPreflight());

    const result = await processAutomaticMainCustomerInvoice("5x77");

    expect(result).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 2 });
    expect(mocks.contactResolution).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(4);
    expect(mocks.writer).toHaveBeenCalledTimes(1);
    expect(mocks.writer.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.contactResolution.mock.invocationCallOrder[0]!);
  });

  it("keeps a v2 would-create preview read-only, then refreshes contact/invoice evidence before the Draft", async () => {
    vi.stubEnv("FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
    const wouldCreate = { source: await mocks.contactV2Source(), status: "would_create", outcome: "would_create_contact", contactId: null, contactName: "Customer Pty Ltd", includeEmailOnCreate: true, lookupOrder: ["name", "email"], nameMatchCount: 0, emailMatchCount: 0, holdReason: null };
    const matched = { ...wouldCreate, status: "matched", outcome: "matched_by_name", contactId: "v2-contact", contactName: "Customer Pty Ltd", includeEmailOnCreate: false };
    mocks.contactV2Preview.mockResolvedValueOnce(wouldCreate).mockResolvedValueOnce(wouldCreate).mockResolvedValueOnce(matched);
    mocks.contactV2Execute.mockResolvedValue({ ...matched, status: "created", outcome: "created_contact", contactEventId: 99, contactWritesAttempted: 1 });

    const preview = await previewMainCustomerInvoice("5x77");
    expect(preview).toMatchObject({ state: "held", noWrites: true, customerContactPlan: { outcome: "would_create_contact" } });
    expect(mocks.contactV2Execute).not.toHaveBeenCalled();
    const result = await processAutomaticMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 2 });
    expect(mocks.contactV2Execute).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(6);
    expect(mocks.writer.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.contactV2Execute.mock.invocationCallOrder[0]!);
  });
});
