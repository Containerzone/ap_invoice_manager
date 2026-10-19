import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), auth: vi.fn(), run: vi.fn(), current: vi.fn(), requireLedger: vi.fn(), reserve: vi.fn(), complete: vi.fn(), hold: vi.fn() }));
vi.mock("axios", () => ({ default: { get: m.get, post: m.post } }));
vi.mock("./xeroService", () => ({ getXeroReadAuthWithRefresh: m.auth }));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.run }));
vi.mock("./financialCustomerContactSourceV2", () => ({
  normalizeCustomerEmail: (value: string | null | undefined) => value?.trim().toLocaleLowerCase("en-AU") ?? "",
  normalizeCustomerName: (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU"),
  readCurrentCustomerContactResolution: m.current,
}));
vi.mock("./financialCustomerContactDb", () => ({
  requireFinancialCustomerContactLedger: m.requireLedger,
  reserveFinancialCustomerContactEvent: m.reserve,
  completeFinancialCustomerContactEvent: m.complete,
  holdFinancialCustomerContactEvent: m.hold,
}));
import { executeCustomerContactCreationV2, type CustomerContactPlan } from "./financialCustomerContactServiceV2";

const source = { dealId: "5x77", billingKind: "organisation" as const, customerVtigerId: "4x2", organisationName: "Customer Pty Ltd", contactName: null, name: "Customer Pty Ltd", email: "customer@example.test", linkedAccountId: "4x2", linkedContactId: null, sourceFieldsUsed: ["Accounts.accountname"], resolvedAt: "2026-10-13T00:00:00.000Z", sourceSnapshotHash: "a".repeat(64) };
const plan = (): CustomerContactPlan => ({ source, status: "would_create", outcome: "would_create_contact", contactId: null, contactName: "Customer Pty Ltd", includeEmailOnCreate: true, lookupOrder: ["name", "email"], nameMatchCount: 0, emailMatchCount: 0, holdReason: null });
const response = (data: unknown) => ({ data, headers: {} });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "true");
  vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED", "true");
  m.current.mockResolvedValue(source);
  m.auth.mockResolvedValue({ token: "token", tenantId: "tenant" });
  m.run.mockImplementation(async (_auth: unknown, _name: string, operation: () => Promise<unknown>) => operation());
  m.requireLedger.mockResolvedValue(undefined);
  m.reserve.mockResolvedValue({ kind: "reserved", event: { id: 90, status: "reserved" } });
  m.complete.mockResolvedValue(undefined);
  m.hold.mockResolvedValue(undefined);
});

describe("v2 customer contact execution", () => {
  it("does not create when the exact current VTiger source changed after preview", async () => {
    m.current.mockResolvedValue({ ...source, sourceSnapshotHash: "b".repeat(64) });
    const result = await executeCustomerContactCreationV2(plan());
    expect(result).toMatchObject({ status: "held", outcome: "held_duplicate_or_ambiguous", contactWritesAttempted: 0 });
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });

  it("rechecks current source and two empty searches before POST/readback", async () => {
    m.get
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [{ ContactID: "customer-v2", Name: "Customer Pty Ltd", EmailAddress: "customer@example.test", ContactStatus: "ACTIVE" }] }));
    m.post.mockResolvedValue(response({ Contacts: [{ ContactID: "customer-v2", Name: "Customer Pty Ltd", EmailAddress: "customer@example.test", ContactStatus: "ACTIVE" }] }));
    const result = await executeCustomerContactCreationV2(plan());
    expect(result).toMatchObject({ status: "created", contactId: "customer-v2", contactWritesAttempted: 1 });
    expect(m.post).toHaveBeenCalledWith(expect.stringMatching(/\/Contacts$/), { Contacts: [{ Name: "Customer Pty Ltd", EmailAddress: "customer@example.test" }] }, expect.any(Object));
    expect(m.complete).toHaveBeenCalledWith(90, expect.objectContaining({ status: "created", outcome: "created_contact" }));
  });

  it("does not retry an uncertain contact POST and records one attempted write for reconciliation", async () => {
    m.get
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Organisations: [{ Name: "ContainerZone" }] }))
      .mockResolvedValueOnce(response({ Contacts: [] }))
      .mockResolvedValueOnce(response({ Contacts: [] }));
    m.run.mockImplementation(async (_auth: unknown, name: string, operation: () => Promise<unknown>, options?: unknown) => {
      if (name === "POST customer-contact-v2") expect(options).toEqual({ retryTransientGatewayFailures: false });
      return operation();
    });
    m.post.mockRejectedValue(Object.assign(new Error("gateway"), { response: { status: 502 } }));

    const result = await executeCustomerContactCreationV2(plan());

    expect(result).toMatchObject({ status: "reconciliation_required", contactWritesAttempted: 1 });
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.hold).toHaveBeenCalledWith(90, expect.stringMatching(/uncertain gateway/i), true, "held_xero_contact_creation_failed");
  });

  it("leaves a would-create plan read-only while either independent gate is disabled", async () => {
    vi.stubEnv("FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED", "");
    const result = await executeCustomerContactCreationV2(plan());
    expect(result).toMatchObject({ status: "would_create", contactWritesAttempted: 0 });
    expect(m.current).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });
});
