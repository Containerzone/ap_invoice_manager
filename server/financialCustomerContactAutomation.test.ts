import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), auth: vi.fn(), run: vi.fn(), requireLedger: vi.fn(), reserve: vi.fn(), complete: vi.fn(), hold: vi.fn(), getEvent: vi.fn(),
}));
vi.mock("axios", () => ({ default: { get: m.get, post: m.post } }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({
  runBoundedXeroGet: async (_auth: unknown, _operation: string, url: string, config: unknown) => m.get(url, config),
  runXeroRequest: m.run,
}));
vi.mock("./financialCustomerContactDb", () => ({
  requireFinancialCustomerContactLedger: m.requireLedger,
  reserveFinancialCustomerContactEvent: m.reserve,
  completeFinancialCustomerContactEvent: m.complete,
  holdFinancialCustomerContactEvent: m.hold,
  getFinancialCustomerContactEvent: m.getEvent,
}));
import { resolveOrCreateAutomaticCustomerContact } from "./financialCustomerContactService";

const source = { customerVtigerId: "4x42", customerKind: "contact" as const, name: "Nick Stephenson", email: "nick@example.test", phone: "+61400000000", sourceSnapshotHash: "a".repeat(64) };
const response = (data: unknown) => ({ data, headers: {} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED", "true");
  m.auth.mockResolvedValue({ token: "test-token", tenantId: "tenant-1" });
  m.run.mockImplementation(async (_auth: unknown, _operation: string, operation: () => Promise<unknown>) => operation());
  m.requireLedger.mockResolvedValue(undefined);
  m.reserve.mockResolvedValue({ kind: "reserved", event: { id: 31, status: "reserved" } });
  m.complete.mockResolvedValue(undefined);
  m.hold.mockResolvedValue(undefined);
});

describe("automatic customer contact creation", () => {
  it("creates exactly one contact only after two empty exact searches, then reads it back", async () => {
    m.get
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [{ ContactID: "xero-42", Name: "Nick Stephenson", EmailAddress: "nick@example.test", ContactStatus: "ACTIVE", Phones: [{ PhoneType: "MOBILE", PhoneNumber: "+61400000000" }] }] }));
    m.post.mockResolvedValue(response({ Contacts: [{ ContactID: "xero-42", Name: "Nick Stephenson", EmailAddress: "nick@example.test", ContactStatus: "ACTIVE" }] }));

    const result = await resolveOrCreateAutomaticCustomerContact(source);

    expect(result).toMatchObject({ status: "created", contactId: "xero-42", contactEventId: 31, contactWritesAttempted: 1 });
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.post.mock.calls[0]![1]).toEqual({ Contacts: [{ Name: "Nick Stephenson", EmailAddress: "nick@example.test", Phones: [{ PhoneType: "MOBILE", PhoneNumber: "+61400000000" }] }] });
    expect(m.complete).toHaveBeenCalledWith(31, expect.objectContaining({ status: "created", xeroContactId: "xero-42" }));
  });

  it("never posts when any exact name/email match conflicts or is ambiguous", async () => {
    m.get
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Contacts: [{ ContactID: "other", Name: "Nick Stephenson", EmailAddress: "old@example.test", ContactStatus: "ACTIVE" }] }))
      .mockResolvedValueOnce(response({ Contacts: [] }));

    const result = await resolveOrCreateAutomaticCustomerContact(source);

    expect(result).toMatchObject({ status: "held", contactWritesAttempted: 0 });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("does not create a second contact when a previous create outcome is uncertain", async () => {
    m.get
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }));
    m.reserve.mockResolvedValue({ kind: "existing", event: { id: 31, status: "reconciliation_required", xeroContactId: null } });

    const result = await resolveOrCreateAutomaticCustomerContact(source);

    expect(result).toMatchObject({ status: "reconciliation_required", contactEventId: 31, contactWritesAttempted: 0 });
    expect(m.post).not.toHaveBeenCalled();
  });
});
