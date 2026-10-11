import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./financialWorkflowDb", () => ({
  getFinancialWorkflowConfig: vi.fn(),
  upsertFinancialWorkflowConfig: vi.fn(),
}));

import {
  FOR_HIRE_RELEASE_KEY,
  FOR_HIRE_RULES_HASH,
  assertForHireRelease,
  approveForHireReleasePolicy,
  getForHireReleasePolicy,
  prepareForHireReleasePolicy,
  resolveForHireRelease,
  type ForHireReleasePolicy,
} from "./financialForHireRelease";
import * as workflowDb from "./financialWorkflowDb";

function released(overrides: Partial<ForHireReleasePolicy> = {}): ForHireReleasePolicy {
  return {
    releaseKey: "FOR-HIRE-UNIT-TEST",
    rulesHash: FOR_HIRE_RULES_HASH,
    enabled: true,
    initialEnabled: true,
    recurringEnabled: true,
    approvedBy: 9,
    approvedAt: "2026-10-01T00:00:00.000Z",
    effectiveFrom: "2026-10-02T00:00:00.000Z",
    forHireOnlyVtigerBranch: true,
    initialOperationsHandoff: true,
    recurringOperationsHandoff: true,
    migrationScope: "new_events_only",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "false");
  vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([] as any);
  vi.mocked(workflowDb.upsertFinancialWorkflowConfig).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("For Hire standing release policy", () => {
  it("defaults off with no VTiger or Operations handover", () => {
    expect(resolveForHireRelease(null)).toEqual({
      releaseKey: "", rulesHash: FOR_HIRE_RULES_HASH, enabled: false, approvedBy: null, approvedAt: null, effectiveFrom: null,
      initialEnabled: false, recurringEnabled: false,
      forHireOnlyVtigerBranch: false, initialOperationsHandoff: false, recurringOperationsHandoff: false, migrationScope: "new_events_only",
    });
    expect(() => assertForHireRelease(resolveForHireRelease(null), "initial")).toThrow(/disabled/i);
  });

  it("does not mistake an unrelated configuration for a release", async () => {
    vi.mocked(workflowDb.getFinancialWorkflowConfig).mockResolvedValue([{ configKey: "other", configValue: released() }] as any);
    await expect(getForHireReleasePolicy()).resolves.toMatchObject({ enabled: false });
  });

  it.each([
    ["a missing For Hire-only branch", { forHireOnlyVtigerBranch: false }, "FOR HIRE-only"],
    ["a missing initial Operations handover", { initialOperationsHandoff: false }, "initial Operations"],
    ["a missing recurring Operations handover", { recurringOperationsHandoff: false }, "recurring schedule"],
  ] as const)("rejects %s", (_label, override, message) => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() => assertForHireRelease(released(override), "recurring")).toThrow(message);
  });

  it("keeps preparation local and disabled", async () => {
    const policy = await prepareForHireReleasePolicy(9);
    expect(policy).toMatchObject({ enabled: false, approvedBy: null, migrationScope: "new_events_only" });
    expect(workflowDb.upsertFinancialWorkflowConfig).toHaveBeenCalledWith(FOR_HIRE_RELEASE_KEY, policy, expect.stringMatching(/disabled/i), 9);
  });

  it("permits an initial-only release while recurring remains disabled", async () => {
    await expect(approveForHireReleasePolicy({ approvedBy: 9, effectiveFrom: "2026-10-02T00:00:00.000Z", forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: false })).resolves.toMatchObject({ enabled: true, initialEnabled: true, recurringEnabled: false, approvedBy: 9 });
    await expect(approveForHireReleasePolicy({ approvedBy: 9, effectiveFrom: "2026-10-02T00:00:00.000Z", forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: true })).resolves.toMatchObject({ enabled: true, initialEnabled: true, recurringEnabled: true, approvedBy: 9 });
  });

  it("rejects recurring processing even when the initial-only policy is active", () => {
    vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() => assertForHireRelease(released({ recurringEnabled: false, recurringOperationsHandoff: false }), "initial")).not.toThrow();
    expect(() => assertForHireRelease(released({ recurringEnabled: false, recurringOperationsHandoff: false }), "recurring")).toThrow(/recurring/i);
  });
});
