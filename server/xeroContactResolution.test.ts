import { describe, expect, it } from "vitest";
import { classifyXeroContactMatches, type XeroContactCandidate } from "./xeroService";

const contact = (contactId: string, name: string, email: string | null): XeroContactCandidate => ({
  contactId,
  name,
  email,
  taxNumber: null,
});

describe("classifyXeroContactMatches", () => {
  it("matches automatically only when the single name and email match the same Xero contact", () => {
    const scf = contact("scf-1", "SCF Containers", "accounts@scf.com.au");

    const result = classifyXeroContactMatches({
      supplierName: "SCF Containers",
      supplierEmail: "accounts@scf.com.au",
      nameMatches: [scf],
      emailMatches: [scf],
    });

    expect(result).toMatchObject({
      status: "matched",
      matchBasis: "name_and_email",
      contact: { contactId: "scf-1" },
    });
  });

  it("requires explicit approval when a name match has a different or missing Xero email", () => {
    const scf = contact("scf-1", "SCF Containers", "old-contact@scf.com.au");

    const result = classifyXeroContactMatches({
      supplierName: "SCF Containers",
      supplierEmail: "accounts@scf.com.au",
      nameMatches: [scf],
      emailMatches: [],
    });

    expect(result).toMatchObject({
      status: "needs_selection",
      reason: "name_email_mismatch",
      candidates: [{ contactId: "scf-1" }],
    });
  });

  it("uses a single first-name match when the supplier provides no email for validation", () => {
    const scf = contact("scf-1", "SCF Containers", "accounts@scf.com.au");

    const result = classifyXeroContactMatches({
      supplierName: "SCF Containers",
      supplierEmail: null,
      nameMatches: [scf],
      emailMatches: [],
    });

    expect(result).toMatchObject({
      status: "matched",
      matchBasis: "name_only",
      contact: { contactId: "scf-1" },
    });
  });

  it("requires an approved choice when name and email point to different contacts", () => {
    const nameContact = contact("scf-name", "SCF Containers", "ops@scf.com.au");
    const emailContact = contact("scf-email", "SCF Logistics", "accounts@scf.com.au");

    const result = classifyXeroContactMatches({
      supplierName: "SCF Containers",
      supplierEmail: "accounts@scf.com.au",
      nameMatches: [nameContact],
      emailMatches: [emailContact],
    });

    expect(result).toMatchObject({
      status: "needs_selection",
      reason: "name_email_mismatch",
      nameMatchCount: 1,
      emailMatchCount: 1,
    });
    expect(result.candidates.map((candidate) => candidate.contactId).sort()).toEqual(["scf-email", "scf-name"]);
  });

  it("requires selection where the first supplier-name token has more than one Xero candidate", () => {
    const result = classifyXeroContactMatches({
      supplierName: "SCF Containers",
      supplierEmail: "accounts@scf.com.au",
      nameMatches: [
        contact("scf-1", "SCF Containers", "accounts@scf.com.au"),
        contact("scf-2", "SCF Containers Brisbane", "brisbane@scf.com.au"),
      ],
      emailMatches: [contact("scf-1", "SCF Containers", "accounts@scf.com.au")],
    });

    expect(result).toMatchObject({
      status: "needs_selection",
      reason: "multiple_name_matches",
      nameMatchCount: 2,
    });
  });

  it("allows a new contact only when neither the name nor email has a match", () => {
    const result = classifyXeroContactMatches({
      supplierName: "New Supplier Pty Ltd",
      supplierEmail: "accounts@new-supplier.example",
      nameMatches: [],
      emailMatches: [],
    });

    expect(result).toMatchObject({ status: "create_new", candidates: [] });
  });
});
