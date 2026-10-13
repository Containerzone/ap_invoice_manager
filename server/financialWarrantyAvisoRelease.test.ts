import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: m.config }));
import { warrantyFixture } from "./financialWarrantyAvisoFixtures";
import { assertWarrantyRelease, getWarrantyReleasePolicy, resolveWarrantyRelease, WARRANTY_RELEASE_KEY } from "./financialWarrantyAvisoRelease";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "");
  m.config.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Warranty & Aviso default-off independent release", () => {
  it.each([undefined, null, [], "true", { enabled: "true" }, { enabled: 1 }])("absent/malformed policy %j fails closed", raw => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    const policy = resolveWarrantyRelease(raw);
    expect(policy.enabled).toBe(false);
    expect(() => assertWarrantyRelease(policy)).toThrow(/disabled/);
  });
  it.each([undefined, "", "false", "TRUE", "1", " true "])("flag %s cannot inherit other-family/global permission", flag => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", flag);
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_MAIN_INVOICE_AUTOMATIC_ENABLED", "true");
    expect(() => assertWarrantyRelease(warrantyFixture().policy)).toThrow(/disabled/);
  });
  it("only the exact dedicated approved policy and literal true flag pass", () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    expect(() => assertWarrantyRelease(warrantyFixture().policy)).not.toThrow();
  });
  it.each([
    "enabled", "warrantyOnlyVtigerBranch", "operationsMakeHandoverAcknowledged", "mainInvoiceCoordinationAcknowledged",
    "isolatedDraftOnlyScope", "draftAmendmentAcknowledged", "enableDraftMainAmendment", "noCrmPostSuccessMutation",
  ])("requires literal boolean %s", key => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    for (const value of [false, "true", 1, null]) {
      const p = resolveWarrantyRelease({ ...warrantyFixture().policy, [key]: value });
      expect(() => assertWarrantyRelease(p)).toThrow(/disabled/);
    }
  });
  it.each([
    { releaseKey: "generic" }, { releaseKey: "financial-automation.main-customer-invoice-release" }, { releaseKey: "" },
    { rulesHash: "stale" }, { approvedBy: null }, { approvedBy: "7" }, { approvedBy: 0 },
    { approvedAt: null }, { approvedAt: "invalid" }, { approvedAt: "2999-01-01" },
    { effectiveFrom: null }, { effectiveFrom: "invalid" }, { effectiveFrom: "2999-01-01" },
    { migrationScope: "historical" }, { sourceConfig: null }, { sourceConfig: [] },
    { sourceMappingsHash: "a".repeat(64) }, { addedServicesMappingHash: "b".repeat(64) },
    { xeroConfigurationHashes: {} }, { xeroConfigurationHashes: { WAR25: "A".repeat(64) } },
    { avisoContactId: "" }, { avisoSupplierName: "Aviso" }, { avisoAccountCode: "312" },
  ])("rejects unapproved or tampered policy %j", patch => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    expect(() => assertWarrantyRelease(resolveWarrantyRelease({ ...warrantyFixture().policy, ...patch }))).toThrow(/disabled/);
  });
  it("reads only the dedicated local config key, never generic family config", async () => {
    const policy = warrantyFixture().policy;
    m.config.mockResolvedValue([{ configKey: "financial-automation.release", configValue: policy }]);
    expect((await getWarrantyReleasePolicy()).enabled).toBe(false);
    m.config.mockResolvedValue([{ configKey: WARRANTY_RELEASE_KEY, configValue: policy }]);
    expect(await getWarrantyReleasePolicy()).toEqual(policy);
    expect(m.config).toHaveBeenCalledTimes(2);
  });
  it("source mapping edits invalidate the separately approved source hash", () => {
    vi.stubEnv("FINANCIAL_WARRANTY_AUTOMATIC_ENABLED", "true");
    const p = warrantyFixture().policy;
    p.sourceConfig!.fields.addedServices.name = "tampered_api_name";
    expect(() => assertWarrantyRelease(p)).toThrow(/disabled/);
  });
});
