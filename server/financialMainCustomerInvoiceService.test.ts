import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  preflight: vi.fn(),
  recordPreview: vi.fn().mockResolvedValue({ id: 51, status: "previewed" }),
  getEvent: vi.fn(), claim: vi.fn(), bind: vi.fn(), complete: vi.fn(), hold: vi.fn(),
  policy: vi.fn(), writer: vi.fn(), contactSource: vi.fn(), contactResolution: vi.fn(),
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

import { previewMainCustomerInvoice, processAutomaticMainCustomerInvoice, readMainCustomerInvoiceFacts } from "./financialMainCustomerInvoiceService";

const readyPreflight = () => [{ duplicateState: "not_found", status: null, contactCheck: { found: true, contactId: "xero-customer", count: 1, partyName: "Customer Pty Ltd" }, itemChecks: [] }];

beforeEach(() => {
  retrieve.mockReset(); preflight.mockReset(); recordPreview.mockClear(); mocks.getEvent.mockReset(); mocks.claim.mockReset(); mocks.bind.mockReset(); mocks.complete.mockReset(); mocks.hold.mockReset(); mocks.policy.mockReset(); mocks.writer.mockReset(); mocks.contactSource.mockReset(); mocks.contactResolution.mockReset();
  retrieve.mockImplementation(async (id: string) => {
    const records: Record<string, Record<string, unknown>> = {
      "5x77": { id: "5x77", potential_no: "D702877", cf_potentials_quotereference: "20x9", related_to: "4x2", modifiedtime: "2026-10-11T01:00:00Z" },
      "20x9": { id: "20x9", quote_no: "Q-702877", LineItems: { 1: { productid: "14x1", quantity: "2", listprice: "250" } }, modifiedtime: "2026-10-11T02:00:00Z" },
      "4x2": { id: "4x2", accountname: "Customer Pty Ltd" },
      "14x1": { id: "14x1", servicename: "Rail delivery" },
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
});

describe("Main Customer Invoice current-source evidence", () => {
  it("re-reads Deal, Quote, organisation and each VTiger Service before forming a GET-only Xero-ready proposal", async () => {
    const facts = await readMainCustomerInvoiceFacts("5x77");
    expect(retrieve.mock.calls.map(([id]) => id)).toEqual(["5x77", "20x9", "4x2", "14x1"]);
    expect(facts).toMatchObject({ dealNumber: "D702877", quoteNumber: "Q-702877", customerName: "Customer Pty Ltd", serviceLines: [{ serviceVtigerId: "14x1", description: "Rail delivery", quantity: 2, unitAmount: 250 }] });
    const result = await previewMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ state: "previewed", noWrites: true });
    expect(result.preview.document).toMatchObject({ proposedDocumentNumber: "INV-702877", partySourceId: "xero-customer", total: 550 });
    expect(recordPreview).toHaveBeenCalledWith(expect.objectContaining({ status: "previewed", proposedInvoiceNumber: "INV-702877" }));
  });

  it("holds a source when Xero already has the exact INV number instead of adopting or suffixing it", async () => {
    preflight.mockResolvedValue([{ ...readyPreflight()[0], duplicateState: "found", status: "DRAFT" }]);
    const result = await previewMainCustomerInvoice("5x77");
    expect(result).toMatchObject({ state: "held", noWrites: true, holdReason: expect.stringContaining("Exact Xero invoice INV-702877") });
    expect(recordPreview).toHaveBeenCalledWith(expect.objectContaining({ status: "held" }));
  });

  it("creates a contact only for a contact-only preflight hold, refreshes evidence, then writes the Draft", async () => {
    preflight.mockResolvedValueOnce([{ ...readyPreflight()[0], contactCheck: { found: false, contactId: null, count: 0, partyName: "Customer Pty Ltd" } }])
      .mockResolvedValueOnce(readyPreflight());

    const result = await processAutomaticMainCustomerInvoice("5x77");

    expect(result).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 2 });
    expect(mocks.contactResolution).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(mocks.writer).toHaveBeenCalledTimes(1);
    expect(mocks.writer.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.contactResolution.mock.invocationCallOrder[0]!);
  });
});
