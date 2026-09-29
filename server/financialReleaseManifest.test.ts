import { describe, expect, it } from "vitest";
import {
  FINANCIAL_RELEASE_FAMILIES,
  FINANCIAL_LEGACY_WRITER_INVENTORY,
  frozenRuleVersion,
  releaseFamilyStatus,
} from "./financialReleaseManifest";
import { DEFAULT_FINANCIAL_AUTOMATION_RULES } from "./financialAutomationRules";

describe("all-family financial release manifest", () => {
  it("defines every mandated financial family with unique release keys", () => {
    expect(FINANCIAL_RELEASE_FAMILIES).toHaveLength(14);
    expect(new Set(FINANCIAL_RELEASE_FAMILIES.map((entry) => entry.familyKey)).size).toBe(14);
    expect(FINANCIAL_RELEASE_FAMILIES.map((entry) => entry.displayName)).toEqual(expect.arrayContaining([
      "Initial Container Control — Asset",
      "Initial Container Control — Customer Sale",
      "Initial Container Control — For Hire",
      "Recurring For Hire",
      "Origin Storage Activation",
      "Destination Storage Activation",
      "Recurring Storage",
      "Storage Finalisation / Recovery",
      "Main Customer Invoice",
      "Deposit Invoice",
      "Final Weight — Overweight",
      "Final Weight — Underweight",
      "Extra Hire",
      "Warranty Customer Invoice and Aviso PO",
    ]));
  });

  it("holds a family when any mandatory gate is incomplete", () => {
    const status = releaseFamilyStatus({
      confirmedShadowTestId: null,
      xeroOutcome: "blocked",
      vtigerOutcome: "passed",
      hasLegacyWriterInventory: false,
      hasCurrentDocumentManifest: false,
    });
    expect(status.status).toBe("held");
    expect(status.reason).toContain("Xero GET-only tenant readiness");
    expect(status.reason).toContain("reviewer-confirmed shadow test");
    expect(status.reason).toContain("writer and exact disable action");
  });

  it("allows a family into a manifest only when every documented gate is passed", () => {
    expect(releaseFamilyStatus({
      confirmedShadowTestId: 101,
      xeroOutcome: "passed",
      vtigerOutcome: "passed",
      hasLegacyWriterInventory: true,
      hasCurrentDocumentManifest: true,
    })).toMatchObject({ status: "included" });
  });

  it("records the factual no-current-candidate result without inferring failure", () => {
    expect(releaseFamilyStatus({
      candidateOutcome: "no_current_candidate",
      confirmedShadowTestId: null,
      xeroOutcome: "passed",
      vtigerOutcome: "passed",
      hasLegacyWriterInventory: true,
      hasCurrentDocumentManifest: false,
    })).toMatchObject({ status: "no_current_candidate" });
  });

  it("holds a previously confirmed family when current fingerprints are stale", () => {
    expect(releaseFamilyStatus({
      candidateOutcome: "found",
      confirmedShadowTestId: 101,
      xeroOutcome: "passed",
      vtigerOutcome: "passed",
      hasLegacyWriterInventory: true,
      hasCurrentDocumentManifest: true,
      hasDisabledPostSuccessMapping: true,
      evidenceFresh: false,
    })).toMatchObject({ status: "held", reason: expect.stringContaining("stale") });
  });

  it("prefills one local legacy handover entry for every release family", () => {
    expect(FINANCIAL_LEGACY_WRITER_INVENTORY).toHaveLength(14);
    expect(FINANCIAL_LEGACY_WRITER_INVENTORY.map((entry) => entry.familyKey)).toEqual(FINANCIAL_RELEASE_FAMILIES.map((entry) => entry.familyKey));
    expect(FINANCIAL_LEGACY_WRITER_INVENTORY.find((entry) => entry.familyKey === "recurring_for_hire")?.legacyWriterIdentifier)
      .toContain("forHireMonthlyPo");
  });

  it("derives a stable frozen rule version from the exact active rule set", () => {
    expect(frozenRuleVersion(DEFAULT_FINANCIAL_AUTOMATION_RULES)).toMatch(/^rules-[a-f0-9]{16}$/);
    expect(frozenRuleVersion(DEFAULT_FINANCIAL_AUTOMATION_RULES)).toBe(frozenRuleVersion(DEFAULT_FINANCIAL_AUTOMATION_RULES));
  });
});
