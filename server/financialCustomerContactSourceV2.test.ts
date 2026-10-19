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

  it("revalidates the linked Quote while retaining the current Deal organisation as the Main Invoice party", async () => {
    m.retrieve.mockImplementation(async (id: string) => {
      if (id === "5x100") return { ...deal, cf_potentials_quotereference: "20x55" };
      if (id === "20x55") return { id, contact_id: "4x300" };
      if (id === "3x200") return { id, accountname: "Deal Customer Pty Ltd", email1: "deal@example.test" };
      return { id, firstname: "Ignored", lastname: "Contact" };
    });

    const result = await readCurrentCustomerContactResolution("5x100", {
      customerVtigerId: "3x200", billingKind: "organisation", name: "Deal Customer Pty Ltd", quoteId: "20x55",
    });

    expect(result).toMatchObject({ billingKind: "organisation", customerVtigerId: "3x200", name: "Deal Customer Pty Ltd", email: "deal@example.test", invoiceQuoteId: "20x55" });
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual(["5x100", "20x55", "3x200"]);
  });

  it("holds before a contact write if the current Deal billing party changes after Main Invoice preview", async () => {
    m.retrieve.mockImplementation(async (id: string) => {
      if (id === "5x100") return { ...deal, related_to: "3x999", cf_potentials_quotereference: "20x55" };
      if (id === "20x55") return { id };
      return { id, accountname: "Changed Customer" };
    });

    await expect(readCurrentCustomerContactResolution("5x100", {
      customerVtigerId: "3x200", billingKind: "organisation", name: "Deal Customer Pty Ltd", quoteId: "20x55",
    })).rejects.toThrow(/Deal billing party changed/);
  });

  it("holds an attempted Quote-contact substitution when the current Deal has an organisation", async () => {
    m.retrieve.mockImplementation(async (id: string) => {
      if (id === "5x100") return { ...deal, cf_potentials_quotereference: "20x55" };
      if (id === "20x55") return { id, contact_id: "4x300" };
      if (id === "4x300") return { id, firstname: "Quote", lastname: "Contact", email: "quote.contact@example.test" };
      return { id, accountname: "Deal Organisation Must Not Win" };
    });

    await expect(readCurrentCustomerContactResolution("5x100", {
      customerVtigerId: "4x300", billingKind: "individual", name: "Quote Contact", quoteId: "20x55",
    })).rejects.toThrow(/Deal billing party changed/);
  });

  it("does not require a Quote bill-to field when the current Deal party is still exact", async () => {
    m.retrieve.mockImplementation(async (id: string) => {
      if (id === "5x100") return { ...deal, cf_potentials_quotereference: "20x55" };
      if (id === "20x55") return { id };
      return { id, accountname: "Deal Customer Pty Ltd", email: "deal@example.test" };
    });
    await expect(readCurrentCustomerContactResolution("5x100", {
      customerVtigerId: "3x200", billingKind: "organisation", name: "Deal Customer Pty Ltd", quoteId: "20x55",
    })).resolves.toMatchObject({ customerVtigerId: "3x200", billingKind: "organisation", invoiceQuoteId: "20x55" });
  });
});
