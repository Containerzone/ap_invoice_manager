import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), run: vi.fn(), cached: vi.fn(), auth: vi.fn(),
  config: vi.fn(), source: vi.fn(), plan: vi.fn(), create: vi.fn(), deal: vi.fn(),
  receipt: vi.fn(), conflict: vi.fn(), event: vi.fn(), reserve: vi.fn(), lock: vi.fn(), audit: vi.fn(), alert: vi.fn(), pending: vi.fn(),
}));
vi.mock("axios", () => ({ default: { get: m.get, post: m.post } }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.run, runCachedXeroGet: m.cached, XERO_CACHE_TTL: { invoiceSearch: 1 } }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: m.config }));
vi.mock("./financialCustomerContactSourceV2", () => ({ readCurrentCustomerContactResolution: m.source }));
vi.mock("./financialCustomerContactServiceV2", () => ({ previewCustomerContactResolution: m.plan, executeCustomerContactCreationV2: m.create }));
vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: m.deal }));
vi.mock("./financialBillingPartySyncDb", () => ({
  getBillingPartySyncEvents: vi.fn(), getBillingPartySyncMainReceipt: m.receipt,
  recordBillingPartySyncEvent: m.event, reserveBillingPartySyncInvoiceLock: m.reserve,
  setBillingPartySyncInvoiceLockState: m.lock, recordBillingPartySyncAudit: m.audit,
  billingPartySyncConflictReason: m.conflict, getBillingPartySyncPendingInvoiceLock: m.pending,
}));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: m.alert }));
import {
  BILLING_PARTY_SYNC_RELEASE_KEY, BILLING_PARTY_SYNC_RULES_HASH,
  billingPartyPreservationProjection, processAutomaticBillingPartySync,
  previewBillingPartySync, verifyBillingPartyReadback,
} from "./financialBillingPartySyncService";

const response = (data: unknown) => ({ data, headers: {} });
const source = {
  dealId: "5x77", billingKind: "organisation" as const, customerVtigerId: "4x2",
  organisationName: "Current Customer Pty Ltd", contactName: "Ignored Person", name: "Current Customer Pty Ltd",
  email: "billing@example.test", linkedAccountId: "4x2", linkedContactId: "12x3",
  sourceFieldsUsed: ["Deal.organizationname"], resolvedAt: "2026-10-12T00:00:00.000Z", sourceSnapshotHash: "a".repeat(64),
};
const plan = {
  source, status: "matched" as const, outcome: "matched_by_name" as const, contactId: "contact-target",
  contactName: "Current Customer Pty Ltd", includeEmailOnCreate: false, lookupOrder: ["name"],
  nameMatchCount: 1, emailMatchCount: 0, holdReason: null,
};
const invoice = (contactId = "contact-original"): any => ({
  InvoiceID: "invoice-exact", InvoiceNumber: "INV-702877", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD",
  AmountPaid: 0, AmountCredited: 0, Date: "2026-10-01", DueDate: "2026-10-15", Reference: "Must stay unchanged",
  SubTotal: 90, TotalTax: 9, Total: 99, Contact: { ContactID: contactId, Name: "Old contact" },
  LineItems: [{ LineItemID: "line-1", Description: "Original Quote description", Quantity: 2, UnitAmount: 50,
    LineAmount: 90, TaxAmount: 9, TaxType: "OUTPUT", AccountCode: "200", ItemCode: "SER9", DiscountRate: 10,
    DiscountAmount: 10, Tracking: [{ Name: "Region", Option: "Sydney" }], FutureFinancialField: { value: 3 } }],
});
const policy = () => ({
  releaseKey: BILLING_PARTY_SYNC_RELEASE_KEY, rulesHash: BILLING_PARTY_SYNC_RULES_HASH, enabled: true,
  approvedBy: 7, approvedAt: "2026-01-01T00:00:00.000Z", effectiveFrom: "2026-01-02T00:00:00.000Z",
  migrationScope: "new_events_only", apOwnedMainReceiptOnly: true, exactDraftContactIdOnly: true,
  sourceRevalidationRequired: true, tenantBound: true, preservationReadbackRequired: true,
});
function armPolicy(patch: Record<string, unknown> = {}) {
  m.config.mockResolvedValue([{ configKey: BILLING_PARTY_SYNC_RELEASE_KEY, configValue: { ...policy(), ...patch } }]);
}
function invoiceReads(readbackPatch: Record<string, unknown> = {}) {
  let reads = 0;
  m.get.mockImplementation(async (url: string) => {
    if (url.endsWith("/Organisation")) return response({ Organisations: [{ Name: "ContainerZone Pty Ltd" }] });
    if (url.includes("/Contacts/")) return response({ Contacts: [{ ContactID: decodeURIComponent(url.split("/").pop()!), ContactStatus: "ACTIVE" }] });
    reads += 1;
    return response({ Invoices: [reads >= 3 ? { ...invoice("contact-target"), ...readbackPatch } : invoice()] });
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
  armPolicy();
  m.auth.mockResolvedValue({ token: "test-token", tenantId: "tenant-exact" });
  m.run.mockImplementation(async (_auth: unknown, _name: string, operation: () => Promise<unknown>) => operation());
  m.cached.mockImplementation(async (_auth: unknown, _key: string, _ttl: number, operation: () => Promise<unknown>) => (await operation() as any).data);
  m.deal.mockResolvedValue({ id: "5x77", potential_no: "D702877" });
  m.source.mockResolvedValue(source); m.plan.mockResolvedValue(plan);
  m.receipt.mockResolvedValue({ status: "drafts_created", proposedInvoiceNumber: "INV-702877", xeroInvoiceId: "invoice-exact" });
  m.conflict.mockResolvedValue(null); m.pending.mockResolvedValue(null);
  m.event.mockResolvedValue({ id: 1 }); m.reserve.mockResolvedValue({ kind: "reserved", lock: { id: 88, state: "reserved" } });
  m.lock.mockResolvedValue(true); m.audit.mockResolvedValue(undefined); m.post.mockResolvedValue(response({ Invoices: [invoice("contact-target")] }));
  invoiceReads();
});
afterEach(() => vi.unstubAllEnvs());

describe("billing-party sync preservation and source guards", () => {
  it("changes only ContactID and ignores response metadata but preserves complete line JSON", () => {
    const original = invoice(); const readback = invoice("contact-target");
    readback.UpdatedDateUTC = "response-only"; readback.Contact.EmailAddress = "changed response detail";
    expect(verifyBillingPartyReadback({ original, readback, expectedContactId: "contact-target" })).toEqual({ ok: true });
    expect(billingPartyPreservationProjection(original).LineItems).toEqual(original.LineItems);
  });
  it.each(["Description", "Quantity", "UnitAmount", "AccountCode", "TaxAmount", "DiscountAmount", "Tracking", "FutureFinancialField"])("rejects a changed retained line field: %s", key => {
    const original = invoice(); const readback = invoice("contact-target"); readback.LineItems[0][key] = "unsafe change";
    expect(verifyBillingPartyReadback({ original, readback, expectedContactId: "contact-target" })).toMatchObject({ ok: false });
  });
  it.each(["Reference", "DueDate", "Date", "Total", "TotalTax", "CurrencyCode", "InvoiceID", "Status"])("rejects a changed retained header: %s", key => {
    const original = invoice(); const readback = invoice("contact-target"); readback[key] = "unsafe change";
    expect(verifyBillingPartyReadback({ original, readback, expectedContactId: "contact-target" })).toMatchObject({ ok: false });
  });
  it("rejects wrong readback contact", () => {
    expect(verifyBillingPartyReadback({ original: invoice(), readback: invoice("wrong"), expectedContactId: "contact-target" })).toMatchObject({ ok: false });
  });
  it("default-off gate performs no source, contact or invoice I/O", async () => {
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "false");
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "disabled", xeroWritesAttempted: 0 });
    expect(m.config).not.toHaveBeenCalled(); expect(m.source).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it.each([{ enabled: false }, { rulesHash: "stale" }, { tenantBound: false }, { migrationScope: "historical" }])("fails shut on incomplete release %#", async patch => {
    armPolicy(patch);
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "disabled", xeroWritesAttempted: 0 });
    expect(m.source).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it("requires the existing customer-contact v2 gate", async () => {
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "false");
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "disabled" });
    expect(m.plan).not.toHaveBeenCalled();
  });
  it.each(["2025-01-01T00:00:00.000Z", "invalid-date"])("rejects stale or invalid Deal timestamps %s before contact creation", async resolvedAt => {
    m.source.mockResolvedValue({ ...source, resolvedAt });
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "held", xeroWritesAttempted: 0 });
    expect(m.create).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it("uses the current Deal party instead of any earlier main billing source", async () => {
    const result = await processAutomaticBillingPartySync("5x77", "deposit_invoice");
    expect(result).toMatchObject({ status: "updated", sourceSnapshotHash: source.sourceSnapshotHash });
    expect(m.event).toHaveBeenCalledWith(expect.objectContaining({ sourceSnapshot: expect.objectContaining({ billingKind: "organisation", name: "Current Customer Pty Ltd" }), targetContactId: "contact-target" }));
  });
  it("repeats shared v2 matching for a current individual email match", async () => {
    const person = { ...source, billingKind: "individual", organisationName: null, linkedAccountId: null, name: "Current Person" };
    m.source.mockResolvedValue(person); m.plan.mockResolvedValue({ ...plan, source: person, outcome: "matched_by_email", lookupOrder: ["email", "name"] });
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "updated" });
    expect(m.plan).toHaveBeenCalledWith(person);
  });
  it("creates a missing contact only through the existing guarded v2 path then refreshes evidence", async () => {
    m.plan.mockResolvedValueOnce({ ...plan, status: "would_create", contactId: null }).mockResolvedValue(plan);
    m.create.mockResolvedValue({ ...plan, status: "created", contactWritesAttempted: 1 });
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "updated", xeroWritesAttempted: 2 });
    expect(m.create).toHaveBeenCalledTimes(1); expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.post.mock.invocationCallOrder[0]).toBeGreaterThan(m.create.mock.invocationCallOrder[0]!);
  });
  it("holds an uncertain contact-creation result without changing a main invoice", async () => {
    m.plan.mockResolvedValue({ ...plan, status: "would_create", contactId: null });
    m.create.mockResolvedValue({ status: "reconciliation_required", contactWritesAttempted: 1, holdReason: "Contact readback uncertain" });
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "reconciliation_required", xeroWritesAttempted: 1 });
    expect(m.post).not.toHaveBeenCalled();
  });
  it("does not POST when the current party changes after lock reservation", async () => {
    m.source.mockResolvedValueOnce(source).mockResolvedValue({ ...source, sourceSnapshotHash: "b".repeat(64) });
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "held", xeroWritesAttempted: 0 });
    expect(m.lock).toHaveBeenCalledWith(expect.objectContaining({ eventFingerprint: expect.any(String), from: ["reserved"], to: "held" }));
    expect(m.post).not.toHaveBeenCalled();
  });
  it("rechecks billing source after a rate-manager delay and does not count an unsent POST", async () => {
    m.run.mockImplementation(async (_auth: unknown, name: string, operation: () => Promise<unknown>) => {
      if (name.startsWith("POST")) m.source.mockResolvedValue({ ...source, sourceSnapshotHash: "changed" });
      return operation();
    });
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "held", xeroWritesAttempted: 0 });
    expect(m.post).not.toHaveBeenCalled();
  });
  it("blocks a newly competing writer discovered after transport queue delay", async () => {
    m.conflict.mockResolvedValueOnce(null).mockResolvedValue("Another exact invoice writer is pending");
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "held", xeroWritesAttempted: 0 });
    expect(m.post).not.toHaveBeenCalled();
  });
  it("returns unchanged without a write for an already-correct non-Draft main", async () => {
    invoiceReads({});
    m.get.mockImplementation(async url => url.endsWith("/Organisation")
      ? response({ Organisations: [{ Name: "ContainerZone Pty Ltd" }] })
      : response({ Invoices: [{ ...invoice("contact-target"), Status: "AUTHORISED" }] }));
    expect(await processAutomaticBillingPartySync("5x77", "main_invoice_finalisation")).toMatchObject({ ok: true, status: "unchanged", xeroWritesAttempted: 0 });
    expect(m.receipt).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it.each(["reserved", "submitted", "reconciliation_required"])("never treats a matching contact as unchanged while lock is %s", async state => {
    m.get.mockImplementation(async url => url.endsWith("/Organisation")
      ? response({ Organisations: [{ Name: "ContainerZone Pty Ltd" }] })
      : response({ Invoices: [invoice("contact-target")] }));
    m.pending.mockResolvedValue({ id: 1, state });
    expect((await processAutomaticBillingPartySync("5x77", "deposit_invoice")).status).toBe(state === "reconciliation_required" ? "reconciliation_required" : "held");
    expect(m.post).not.toHaveBeenCalled();
  });
  it.each(["AUTHORISED", "PAID", "VOIDED"])("does not change different billing on a %s main", async Status => {
    m.get.mockImplementation(async url => url.endsWith("/Organisation")
      ? response({ Organisations: [{ Name: "ContainerZone Pty Ltd" }] })
      : response({ Invoices: [{ ...invoice(), Status }] }));
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "held", xeroWritesAttempted: 0 });
    expect(m.post).not.toHaveBeenCalled();
  });
  it("does not adopt an unowned exact main Draft", async () => {
    m.receipt.mockResolvedValue(null);
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "held", warning: expect.stringMatching(/AP-owned/) });
    expect(m.reserve).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it.each(["reserved", "submitted", "held", "reconciliation_required"])("never replays an existing %s billing lock", async state => {
    m.reserve.mockResolvedValue({ kind: "existing", lock: { id: 88, state } });
    expect(["held", "reconciliation_required"]).toContain((await processAutomaticBillingPartySync("5x77", "deposit_invoice")).status);
    expect(m.post).not.toHaveBeenCalled();
  });
  it("sends only the minimal permitted ContactID payload and records preservation readback", async () => {
    expect(await processAutomaticBillingPartySync("5x77", "main_invoice_finalisation")).toMatchObject({ ok: true, status: "updated", xeroWritesAttempted: 1 });
    expect(m.post).toHaveBeenCalledWith(expect.stringMatching(/\/Invoices\/invoice-exact$/),
      { Invoices: [{ InvoiceID: "invoice-exact", InvoiceNumber: "INV-702877", Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: "contact-target" } }] }, expect.objectContaining({ timeout: 30000 }));
    expect(m.run.mock.calls.find(([, name]) => name.startsWith("POST"))?.[3]).toEqual({ retryTransientGatewayFailures: false });
    expect(m.lock).toHaveBeenLastCalledWith(expect.objectContaining({ from: ["submitted"], to: "updated" }));
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "updated", details: expect.objectContaining({ readbackContactId: "contact-target", retainedBusinessFieldsHash: expect.any(String) }) }));
  });
  it.each([undefined, 504])("never retries a timeout/gateway POST (%s)", async status => {
    m.post.mockRejectedValue(Object.assign(new Error("response lost"), status ? { response: { status } } : {}));
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "reconciliation_required", xeroWritesAttempted: 1 });
    expect(m.post).toHaveBeenCalledTimes(1);
  });
  it("holds a readback financial-line mismatch after the one submitted update", async () => {
    const changed = invoice("contact-target").LineItems; changed[0].Description = "unsafe"; invoiceReads({ LineItems: changed });
    expect(await processAutomaticBillingPartySync("5x77", "deposit_invoice")).toMatchObject({ status: "reconciliation_required", xeroWritesAttempted: 1 });
    expect(m.lock).toHaveBeenLastCalledWith(expect.objectContaining({ to: "reconciliation_required" }));
  });
  it("read-only preview validates AP ownership without event/contact or invoice writes", async () => {
    const result = await previewBillingPartySync("5x77", "D702877");
    expect(result).toMatchObject({ noWrites: true, canSync: true, invoice: { contactName: "Old contact" } });
    expect(m.event).not.toHaveBeenCalled(); expect(m.audit).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled(); expect(m.post).not.toHaveBeenCalled();
  });
  it("does not resolve a guessed number from a non-D business reference", async () => {
    m.deal.mockResolvedValue({ id: "5x77", potential_no: "702877" });
    expect((await previewBillingPartySync("5x77")).state).toBe("held"); expect(m.get).not.toHaveBeenCalled();
  });
});
