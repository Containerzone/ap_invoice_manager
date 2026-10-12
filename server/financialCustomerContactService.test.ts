import { describe, expect, it } from "vitest";
import { classifyExactCustomerContactMatches, type CustomerContactSource } from "./financialCustomerContactService";

const source = (patch: Partial<CustomerContactSource> = {}): CustomerContactSource => ({
  customerVtigerId: "4x42",
  customerKind: "organisation",
  name: "SCF Containers",
  email: "accounts@scf.example",
  phone: null,
  sourceSnapshotHash: "a".repeat(64),
  ...patch,
});
const contact = (contactId: string, name: string, email: string | null, status = "ACTIVE") => ({ contactId, name, email, phone: null, status });

describe("exact customer contact safety rules", () => {
  it("uses only one active exact name and exact email match", () => {
    const candidate = contact("customer-1", "SCF Containers", "accounts@scf.example");
    expect(classifyExactCustomerContactMatches({ source: source(), nameMatches: [candidate], emailMatches: [candidate] }))
      .toMatchObject({ status: "matched", contactId: "customer-1" });
  });

  it("does not treat a supplier-style first token as an exact customer match", () => {
    const similar = contact("customer-1", "SCF Containers Brisbane", "accounts@scf.example");
    expect(classifyExactCustomerContactMatches({ source: source(), nameMatches: [similar], emailMatches: [similar] }))
      .toMatchObject({ status: "held", reason: expect.stringMatching(/same active contact/) });
  });

  it("holds a single name/email conflict rather than adopting or creating", () => {
    expect(classifyExactCustomerContactMatches({
      source: source(),
      nameMatches: [contact("name", "SCF Containers", "old@scf.example")],
      emailMatches: [contact("email", "Other Company", "accounts@scf.example")],
    })).toMatchObject({ status: "held", reason: expect.stringMatching(/same active contact/) });
  });

  it("holds multiple exact matches and inactive contacts", () => {
    expect(classifyExactCustomerContactMatches({
      source: source(),
      nameMatches: [contact("one", "SCF Containers", "accounts@scf.example"), contact("two", "SCF Containers", "accounts@scf.example")],
      emailMatches: [],
    })).toMatchObject({ status: "held", reason: expect.stringMatching(/More than one/) });
    expect(classifyExactCustomerContactMatches({
      source: source(),
      nameMatches: [contact("archived", "SCF Containers", "accounts@scf.example", "ARCHIVED")],
      emailMatches: [contact("archived", "SCF Containers", "accounts@scf.example", "ARCHIVED")],
    })).toMatchObject({ status: "held", reason: expect.stringMatching(/inactive or archived/) });
  });

  it("allows a name-only existing customer only when no source email is available", () => {
    expect(classifyExactCustomerContactMatches({
      source: source({ email: null }),
      nameMatches: [contact("customer-1", "SCF Containers", "old@scf.example")],
      emailMatches: [],
    })).toMatchObject({ status: "matched", contactId: "customer-1" });
  });
});
