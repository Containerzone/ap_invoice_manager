import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  auth: vi.fn(),
  boundedGet: vi.fn(),
  run: vi.fn(),
  requireLedger: vi.fn(),
  reserve: vi.fn(),
  complete: vi.fn(),
  hold: vi.fn(),
  event: vi.fn(),
}));

vi.mock("axios", () => ({ default: { get: m.get, post: m.post } }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runBoundedXeroGet: m.boundedGet, runXeroRequest: m.run }));
vi.mock("./financialCustomerContactDb", () => ({
  getFinancialCustomerContactEvent: m.event,
  requireFinancialCustomerContactLedger: m.requireLedger,
  reserveFinancialCustomerContactEvent: m.reserve,
  completeFinancialCustomerContactEvent: m.complete,
  holdFinancialCustomerContactEvent: m.hold,
}));

import { resolveOrCreateAutomaticCustomerContact, type CustomerContactSource } from "./financialCustomerContactService";

const source: CustomerContactSource = {
  customerVtigerId: "4x42",
  customerKind: "organisation",
  name: "SCF Containers",
  email: "accounts@scf.example",
  phone: null,
  sourceSnapshotHash: "a".repeat(64),
};
const response = (data: unknown) => ({ data, headers: {} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED", "true");
  m.auth.mockResolvedValue({ token: "token", tenantId: "tenant" });
  m.boundedGet.mockImplementation(async (_auth: unknown, _name: string, url: string, config: unknown) => m.get(url, config));
  m.run.mockImplementation(async (_auth: unknown, _name: string, operation: () => Promise<unknown>) => operation());
  m.requireLedger.mockResolvedValue(undefined);
  m.reserve.mockResolvedValue({ kind: "reserved", event: { id: 90, status: "reserved" } });
  m.complete.mockResolvedValue(undefined);
  m.hold.mockResolvedValue(undefined);
});

describe("legacy customer contact execution", () => {
  it("uses bounded GET for tenant, searches, and read-back while POST remains a no-retry request", async () => {
    m.get
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [{ ContactID: "customer-1", Name: "SCF Containers", EmailAddress: "accounts@scf.example", ContactStatus: "ACTIVE" }] }));
    m.post.mockResolvedValue(response({ Contacts: [{ ContactID: "customer-1", Name: "SCF Containers", EmailAddress: "accounts@scf.example", ContactStatus: "ACTIVE" }] }));

    const result = await resolveOrCreateAutomaticCustomerContact(source);

    expect(result).toMatchObject({ status: "created", contactId: "customer-1", contactWritesAttempted: 1 });
    expect(m.boundedGet.mock.calls.map(([, name]) => name)).toEqual([
      "GET financial-customer-contact-tenant",
      "GET financial-customer-contact-name",
      "GET financial-customer-contact-email",
      "GET financial-customer-contact-name",
      "GET financial-customer-contact-email",
      "GET financial-customer-contact-readback",
    ]);
    expect(m.run).toHaveBeenCalledWith(expect.any(Object), "POST financial-customer-contact", expect.any(Function), { retryTransientGatewayFailures: false });
    expect(m.post).toHaveBeenCalledTimes(1);
  });

  it("does not retry an uncertain legacy contact POST", async () => {
    m.get
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }));
    m.post.mockRejectedValue(Object.assign(new Error("gateway"), { response: { status: 502 } }));

    const result = await resolveOrCreateAutomaticCustomerContact(source);

    expect(result).toMatchObject({ status: "reconciliation_required", contactWritesAttempted: 0 });
    expect(m.run).toHaveBeenCalledWith(expect.any(Object), "POST financial-customer-contact", expect.any(Function), { retryTransientGatewayFailures: false });
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.hold).toHaveBeenCalledWith(90, expect.stringMatching(/uncertain gateway/i), true);
  });
});
