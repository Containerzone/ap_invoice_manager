import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./financialWorkflowDb", () => ({
  getFinancialWorkflowConfig: vi.fn(),
  upsertFinancialWorkflowConfig: vi.fn(),
}));

import {
  STORAGE_RELEASE_KEY,
  STORAGE_RULES_HASH,
  assertStorageRelease,
  getStorageReleasePolicy,
  prepareStorageReleasePolicy,
  resolveStorageRelease,
  type StorageReleasePolicy,
} from "./financialStorageRelease";
import * as workflowDb from "./financialWorkflowDb";

function releasedPolicy(overrides: Partial<StorageReleasePolicy> = {}): StorageReleasePolicy {
  return {
    releaseKey: "STORAGE-APPROVED-RELEASE",
    rulesHash: STORAGE_RULES_HASH,
    enabled: true,
    approvedBy: 12,
    approvedAt: "2026-01-10T00:00:00.000Z",
    effectiveFrom: "2026-01-11T00:00:00.000Z",
    handoffs: { activation: true, recurring: true, finalisation: true },
    recoveryEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "false");
  vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([] as any);
  vi.mocked(workflowDb.upsertFinancialWorkflowConfig).mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("loaded-storage standing release policy", () => {
  it("resolves absent or malformed persisted configuration to an off-by-default, no-handover policy", () => {
    expect(resolveStorageRelease(null)).toEqual({
      releaseKey: "",
      rulesHash: STORAGE_RULES_HASH,
      enabled: false,
      approvedBy: null,
      approvedAt: null,
      effectiveFrom: null,
      handoffs: { activation: false, recurring: false, finalisation: false },
      recoveryEnabled: false,
    });
    expect(resolveStorageRelease({ enabled: "true", handoffs: { activation: 1 }, recoveryEnabled: 1 } as any)).toMatchObject({
      enabled: false,
      handoffs: { activation: false, recurring: false, finalisation: false },
      recoveryEnabled: false,
    });
  });

  it("reads only the named stored policy and leaves storage automatic processing disabled by default", async () => {
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([
      { configKey: "unrelated", configValue: releasedPolicy() },
      { configKey: STORAGE_RELEASE_KEY, configValue: { releaseKey: "prepared-only" } },
    ] as any);

    await expect(getStorageReleasePolicy()).resolves.toMatchObject({
      releaseKey: "prepared-only",
      enabled: false,
      handoffs: { activation: false, recurring: false, finalisation: false },
      recoveryEnabled: false,
    });
    expect(() => assertStorageRelease(resolveStorageRelease({ releaseKey: "prepared-only" }), "initial")).toThrow(/disabled/i);
  });

  it("does not write configuration while validating an off default policy", () => {
    expect(() => assertStorageRelease(resolveStorageRelease(null), "initial")).toThrow(/disabled/i);
    expect(workflowDb.upsertFinancialWorkflowConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["stale rules hash", { rulesHash: "0".repeat(64) }],
    ["no release key", { releaseKey: "" }],
    ["no approver", { approvedBy: null }],
    ["no approval timestamp", { approvedAt: null }],
    ["invalid effective date", { effectiveFrom: "not-a-date" }],
    ["future effective date", { effectiveFrom: "2099-01-01T00:00:00.000Z" }],
  ] as const)("rejects enabled policy with %s", (_reason, override) => {
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    expect(() => assertStorageRelease(releasedPolicy(override), "initial")).toThrow(/disabled or has no approved current rules policy/i);
  });

  it.each([
    ["initial", { activation: false, recurring: true, finalisation: true }, /activation/i],
    ["recurring", { activation: true, recurring: false, finalisation: true }, /recurring/i],
    ["finalisation", { activation: true, recurring: true, finalisation: false }, /finalisation/i],
  ] as const)("requires the named legacy handover for %s", (kind, handoffs, expected) => {
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    expect(() => assertStorageRelease(releasedPolicy({ handoffs }), kind)).toThrow(expected);
  });

  it("treats recovery as activation plus its explicit recovery and finalisation handoffs", () => {
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");

    expect(() => assertStorageRelease(releasedPolicy({ recoveryEnabled: false }), "recovery")).toThrow(/recovery is not released/i);
    expect(() => assertStorageRelease(releasedPolicy({ handoffs: { activation: true, recurring: true, finalisation: false } }), "recovery")).toThrow(/recovery is not released/i);
    expect(() => assertStorageRelease(releasedPolicy({ handoffs: { activation: false, recurring: true, finalisation: true } }), "recovery")).toThrow(/activation/i);
    expect(() => assertStorageRelease(releasedPolicy(), "recovery")).not.toThrow();
  });

  it("accepts each non-recovery workflow only when the environment flag and all current approvals are present", () => {
    const policy = releasedPolicy();
    expect(() => assertStorageRelease(policy, "initial")).toThrow(/disabled/i);

    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    expect(() => assertStorageRelease(policy, "initial")).not.toThrow();
    expect(() => assertStorageRelease(policy, "recurring")).not.toThrow();
    expect(() => assertStorageRelease(policy, "finalisation")).not.toThrow();
  });

  it("prepares a disabled policy only and never enables automatic processing or a schedule", async () => {
    const prepared = await prepareStorageReleasePolicy(55);

    expect(prepared).toMatchObject({
      releaseKey: expect.stringMatching(/^STORAGE-[a-f0-9]{16}$/),
      rulesHash: STORAGE_RULES_HASH,
      enabled: false,
      approvedBy: null,
      approvedAt: null,
      effectiveFrom: null,
      handoffs: { activation: false, recurring: false, finalisation: false },
      recoveryEnabled: false,
    });
    expect(workflowDb.upsertFinancialWorkflowConfig).toHaveBeenCalledWith(
      STORAGE_RELEASE_KEY,
      prepared,
      expect.stringMatching(/disabled, no external changes/i),
      55,
    );
    expect(() => assertStorageRelease(prepared, "initial")).toThrow(/disabled/i);
  });

  it("refuses to replace an already enabled policy during preparation", async () => {
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([
      { configKey: STORAGE_RELEASE_KEY, configValue: releasedPolicy() },
    ] as any);

    await expect(prepareStorageReleasePolicy(55)).rejects.toThrow(/enabled storage policy cannot be replaced/i);
    expect(workflowDb.upsertFinancialWorkflowConfig).not.toHaveBeenCalled();
  });
});
