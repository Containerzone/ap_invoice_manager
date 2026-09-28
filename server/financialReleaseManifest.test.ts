import { describe, expect, it } from "vitest";
import {
  FINANCIAL_RELEASE_FAMILIES,
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

  it("keeps a family out of a release when any mandatory gate is incomplete", () => {
    const status = releaseFamilyStatus({
      confirmedShadowTestId: null,
      xeroOutcome: "blocked",
      vtigerOutcome: "passed",
      hasLegacyWriterInventory: false,
      hasCurrentDocumentManifest: false,
    });
    expect(status.status).toBe("excluded");
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

  it("derives a stable frozen rule version from the exact active rule set", () => {
    expect(frozenRuleVersion(DEFAULT_FINANCIAL_AUTOMATION_RULES)).toMatch(/^rules-[a-f0-9]{16}$/);
    expect(frozenRuleVersion(DEFAULT_FINANCIAL_AUTOMATION_RULES)).toBe(frozenRuleVersion(DEFAULT_FINANCIAL_AUTOMATION_RULES));
  });
});
