import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: m.retrieve }));
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";

const deal = {
  id: "5x100",
  organizationname: "ContainerZone Customer Pty Ltd",
  contactname: "Ignored Person",
  related_to: "3x200",
  contact_id: "4x300",
  cf_potentials_contactemail: "deal@example.test",
  modifiedtime: "2026-10-13T00:00:00+00:00",
};

beforeEach(() => {
  m.retrieve.mockReset();
  m.retrieve.mockImplementation(async (id: string) => {
    if (id === "5x100") return deal;
    if (id === "3x200") return { id, accountname: "Fallback Account" };
    return { id, firstname: "Linked", lastname: "Person", email: "person@example.test", email1: "second@example.test" };
  });
});

describe("current customer contact resolution source", () => {
  it("prefers a current Deal organisation over an individual and retains linked contact email", async () => {
    const result = await readCurrentCustomerContactResolution("5x100");
    expect(result).toMatchObject({
      billingKind: "organisation",
      name: "ContainerZone Customer Pty Ltd",
      organisationName: "ContainerZone Customer Pty Ltd",
      contactName: "Ignored Person",
      email: "person@example.test",
      linkedAccountId: "3x200",
      linkedContactId: "4x300",
      sourceFieldsUsed: expect.arrayContaining(["Deal.organizationname", "Deal.contactname", "Contacts.email"]),
    });
    expect(result.sourceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses linked Account when all Deal organisation fields are blank", async () => {
    m.retrieve.mockImplementation(async (id: string) => {
      if (id === "5x100") return { ...deal, organizationname: "", contactname: "", cf_potentials_organizationname: "" };
      if (id === "3x200") return { id, accountname: "Fallback Account" };
      return { id, firstname: "Linked", lastname: "Person", email1: "second@example.test" };
    });
    const result = await readCurrentCustomerContactResolution("5x100");
    expect(result).toMatchObject({ billingKind: "organisation", name: "Fallback Account", email: "second@example.test", sourceFieldsUsed: expect.arrayContaining(["Accounts.accountname", "Contacts.email1"]) });
  });

  it("uses individual contact identity only when no organisation is available", async () => {
    m.retrieve.mockImplementation(async (id: string) => {
      if (id === "5x100") return { ...deal, organizationname: "", related_to: "", contactname: "Jane Customer" };
      if (id === "4x300") return { id, firstname: "Linked", lastname: "Person", email: "person@example.test" };
      return { id, accountname: "" };
    });
    const result = await readCurrentCustomerContactResolution("5x100");
    expect(result).toMatchObject({ billingKind: "individual", name: "Jane Customer", customerVtigerId: "4x300" });
  });

  it("fails closed with the named missing-identity hold", async () => {
    m.retrieve.mockImplementation(async (id: string) => id === "5x100" ? { id, modifiedtime: "2026-10-13T00:00:00+00:00" } : { id });
    await expect(readCurrentCustomerContactResolution("5x100")).rejects.toThrow(/held_missing_customer_identity/);
  });
});
