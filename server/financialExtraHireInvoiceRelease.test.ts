import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertExtraHireRelease,
  EXTRA_HIRE_RELEASE_KEY,
  resolveExtraHireRelease,
} from "./financialExtraHireInvoiceRelease";
import { EXTRA_HIRE_RULES_HASH } from "./financialExtraHireInvoiceRules";
afterEach(() => vi.unstubAllEnvs());
const valid = () =>
  resolveExtraHireRelease({
    releaseKey: EXTRA_HIRE_RELEASE_KEY,
    rulesHash: EXTRA_HIRE_RULES_HASH,
    enabled: true,
    approvedBy: 7,
    approvedAt: "2026-01-01T00:00:00Z",
    effectiveFrom: "2026-01-01T00:00:00Z",
    extraHireOnlyVtigerBranch: true,
    operationsExtraHireHandoff: true,
    sourceMappingsConfirmed: true,
    sourceMappingsHash: "a".repeat(64),
    invoiceSuffixCollisionSchemeConfirmed: true,
    suffixScheme: "EH_AP_ORDINAL_V1",
    isolatedDraftOnlyApproved: true,
    postSuccessHireEndDateAcknowledged: true,
    dateSemantics: "CURRENT_HIRE_END_DATE_NO_DUE_DATE",
    migrationScope: "new_events_only",
  });
describe("Extra Hire independently approved new-events policy", () => {
  it("default off even with global/all other family flags", () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "false");
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    expect(() => assertExtraHireRelease(valid())).toThrow(/disabled/);
    expect(resolveExtraHireRelease(null).enabled).toBe(false);
  });
  it("valid exact policy passes only with exact true flag", () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() => assertExtraHireRelease(valid())).not.toThrow();
  });
  it.each([
    "enabled",
    "extraHireOnlyVtigerBranch",
    "operationsExtraHireHandoff",
    "sourceMappingsConfirmed",
    "invoiceSuffixCollisionSchemeConfirmed",
    "isolatedDraftOnlyApproved",
    "postSuccessHireEndDateAcknowledged",
  ])("requires independent %s", key => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() => assertExtraHireRelease({ ...valid(), [key]: false })).toThrow(
      /disabled/
    );
  });
  it.each([
    { sourceMappingsHash: "" },
    { releaseKey: "generic" },
    { rulesHash: "stale" },
    { suffixScheme: "D" },
    { dateSemantics: null },
    { effectiveFrom: "not a date" },
    { approvedAt: "2999-01-01" },
    { effectiveFrom: "2999-01-01" },
    { approvedBy: null },
    { migrationScope: "historical" },
  ])("holds invalid approval %j", patch => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() =>
      assertExtraHireRelease({ ...valid(), ...patch } as any)
    ).toThrow(/disabled/);
  });
  it("unknown scope cannot resolve as enabled", () =>
    expect(
      resolveExtraHireRelease({ ...valid(), migrationScope: "historical" })
        .enabled
    ).toBe(false));
});
