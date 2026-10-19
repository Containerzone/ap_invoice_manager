import { describe, expect, it } from "vitest";
import { planCustomerContactResolution, type XeroCustomerContactCandidate } from "./financialCustomerContactServiceV2";
import type { CustomerContactResolutionSource } from "./financialCustomerContactSourceV2";

function source(patch: Partial<CustomerContactResolutionSource> = {}): CustomerContactResolutionSource {
  return {
    dealId: "5x100",
    billingKind: "organisation",
    customerVtigerId: "3x200",
    organisationName: "SCF   Containers",
    contactName: "Jane Person",
    name: "SCF   Containers",
    email: "jane@example.test",
    linkedAccountId: "3x200",
    linkedContactId: "4x300",
    sourceFieldsUsed: ["Deal.organizationname"],
    resolvedAt: "2026-10-13T00:00:00.000Z",
    sourceSnapshotHash: "a".repeat(64),
    ...patch,
  };
}

function contact(contactId: string, name: string, email: string | null, status = "ACTIVE"): XeroCustomerContactCandidate {
  return { contactId, name, email, status };
}

describe("organisation-first customer contact resolution", () => {
  it("uses an exact organisation name despite a different linked-person email", () => {
    const result = planCustomerContactResolution({
      source: source(),
      nameResults: [contact("org", "scf containers", "old@example.test")],
      emailResults: [contact("person", "Jane Person", "jane@example.test")],
    });
    expect(result).toMatchObject({ status: "matched", outcome: "matched_by_name", contactId: "org" });
  });

  it("plans creation of the organisation without adopting a person sharing its email", () => {
    const result = planCustomerContactResolution({
      source: source(),
      nameResults: [],
      emailResults: [contact("person", "Jane Person", "jane@example.test")],
    });
    expect(result).toMatchObject({ status: "would_create", outcome: "would_create_contact", includeEmailOnCreate: false });
  });

  it("plans creation with email only when no Xero contact owns that address", () => {
    const result = planCustomerContactResolution({ source: source(), nameResults: [], emailResults: [] });
    expect(result).toMatchObject({ status: "would_create", includeEmailOnCreate: true });
  });

  it("uses trim/collapse-whitespace/en-AU case-insensitive exact names but never similar names", () => {
    expect(planCustomerContactResolution({ source: source(), nameResults: [contact("ok", "  scf Containers  ", null)], emailResults: [] }))
      .toMatchObject({ status: "matched", contactId: "ok" });
    expect(planCustomerContactResolution({ source: source(), nameResults: [contact("no", "SCF Containers Brisbane", null)], emailResults: [] }))
      .toMatchObject({ status: "would_create" });
  });

  it("holds duplicate or inactive exact organisation-name matches", () => {
    expect(planCustomerContactResolution({ source: source(), nameResults: [contact("one", "SCF Containers", null), contact("two", "SCF Containers", null)], emailResults: [] }))
      .toMatchObject({ status: "held", outcome: "held_duplicate_or_ambiguous" });
    expect(planCustomerContactResolution({ source: source(), nameResults: [contact("archived", "SCF Containers", null, "ARCHIVED")], emailResults: [] }))
      .toMatchObject({ status: "held", outcome: "held_duplicate_or_ambiguous" });
  });
});

describe("individual customer contact resolution", () => {
  const individual = (patch: Partial<CustomerContactResolutionSource> = {}) => source({ billingKind: "individual", customerVtigerId: "4x300", organisationName: null, name: "Jane Person", ...patch });

  it("selects the exact-name match among same-email results", () => {
    const result = planCustomerContactResolution({
      source: individual(),
      nameResults: [],
      emailResults: [contact("other", "Other Name", "jane@example.test"), contact("jane", "Jane Person", "jane@example.test")],
    });
    expect(result).toMatchObject({ status: "matched", outcome: "matched_by_email", contactId: "jane" });
  });

  it("holds when an exact email belongs to a different Xero customer name", () => {
    const result = planCustomerContactResolution({
      source: individual(),
      nameResults: [],
      emailResults: [contact("first", "Billing Alias", "jane@example.test"), contact("second", "Other", "jane@example.test")],
    });
    expect(result).toMatchObject({ status: "held", outcome: "held_duplicate_or_ambiguous", contactId: null, holdReason: expect.stringContaining("different name") });
  });

  it("falls back to one exact individual name only when email has no match", () => {
    expect(planCustomerContactResolution({ source: individual(), nameResults: [contact("jane", "Jane Person", null)], emailResults: [] }))
      .toMatchObject({ status: "matched", outcome: "matched_by_name", contactId: "jane" });
    expect(planCustomerContactResolution({ source: individual({ email: null }), nameResults: [], emailResults: [] }))
      .toMatchObject({ status: "would_create", includeEmailOnCreate: false });
  });

  it("holds blank identity before a contact decision", () => {
    expect(planCustomerContactResolution({ source: individual({ name: "   " }), nameResults: [], emailResults: [] }))
      .toMatchObject({ status: "held", outcome: "held_missing_customer_identity" });
  });
});
