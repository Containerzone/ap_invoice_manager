import { createHash } from "node:crypto";
import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";

export const FOR_HIRE_RELEASE_KEY = "financial-automation.for-hire-release" as const;
export const FOR_HIRE_RULES_VERSION = "for-hire-container-control-v2-standing-release" as const;
export const FOR_HIRE_RULES_HASH = createHash("sha256").update(FOR_HIRE_RULES_VERSION).digest("hex");

export type ForHireReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  /** Enables only the dedicated FOR HIRE Request receiver and first Draft PO. */
  initialEnabled: boolean;
  /** Enables AP-owned monthly extensions only after its separate legacy-job handover. */
  recurringEnabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  /** Confirmation that VTiger sends only the FOR HIRE Request branch to AP. */
  forHireOnlyVtigerBranch: boolean;
  /** The shared Operations action excludes FOR HIRE; Asset/Customer Sale remain operational. */
  initialOperationsHandoff: boolean;
  /** Operations `forHireMonthlyPo` has been paused before the AP task is enabled. */
  recurringOperationsHandoff: boolean;
  migrationScope: "new_events_only";
};

export function resolveForHireRelease(value: unknown): ForHireReleasePolicy {
  const raw = value && typeof value === "object" ? value as Partial<ForHireReleasePolicy> : {};
  const initialEnabled = raw.initialEnabled === true || (raw.initialEnabled === undefined && raw.enabled === true);
  const recurringEnabled = raw.recurringEnabled === true || (raw.recurringEnabled === undefined && raw.enabled === true && raw.recurringOperationsHandoff === true);
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : FOR_HIRE_RULES_HASH,
    enabled: initialEnabled || recurringEnabled,
    initialEnabled,
    recurringEnabled,
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom: typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    forHireOnlyVtigerBranch: raw.forHireOnlyVtigerBranch === true,
    initialOperationsHandoff: raw.initialOperationsHandoff === true,
    recurringOperationsHandoff: raw.recurringOperationsHandoff === true,
    migrationScope: "new_events_only",
  };
}

export async function getForHireReleasePolicy(): Promise<ForHireReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveForHireRelease(configs.find((item) => item.configKey === FOR_HIRE_RELEASE_KEY)?.configValue);
}

export function assertForHireRelease(policy: ForHireReleasePolicy, phase: "initial" | "recurring"): void {
  if (process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED !== "true" || !policy.enabled || !policy.releaseKey ||
    policy.rulesHash !== FOR_HIRE_RULES_HASH || !policy.approvedBy || !policy.approvedAt || !policy.effectiveFrom ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.approvedAt) > Date.now() || Date.parse(policy.effectiveFrom) > Date.now()) {
    throw new Error("Automatic For Hire release is disabled or lacks an approved current policy.");
  }
  if (!policy.forHireOnlyVtigerBranch || !policy.initialOperationsHandoff) {
    throw new Error("FOR HIRE-only VTiger branch and initial Operations handover are required.");
  }
  if (phase === "initial" && !policy.initialEnabled) {
    throw new Error("Initial For Hire Draft PO release is not enabled.");
  }
  if (phase === "recurring" && (!policy.recurringEnabled || !policy.recurringOperationsHandoff)) {
    throw new Error("Operations For Hire recurring schedule handover and recurring AP release are required.");
  }
}

/** AP-local preparation only; it never mounts a route, changes a flag or creates a job. */
export async function prepareForHireReleasePolicy(preparedBy: number): Promise<ForHireReleasePolicy> {
  const current = await getForHireReleasePolicy();
  if (current.enabled) throw new Error("An enabled For Hire policy cannot be replaced by preparation.");
  const policy = resolveForHireRelease({
    releaseKey: `FOR-HIRE-${FOR_HIRE_RULES_HASH.slice(0, 16)}`,
    rulesHash: FOR_HIRE_RULES_HASH,
  });
  await upsertFinancialWorkflowConfig(FOR_HIRE_RELEASE_KEY, policy, "Prepared For Hire standing release; disabled and non-writing.", preparedBy);
  return policy;
}

/** Records the separate approved cutover; caller must still deploy and create the AP Heartbeat independently. */
export async function approveForHireReleasePolicy(input: {
  approvedBy: number;
  effectiveFrom: string;
  forHireOnlyVtigerBranch: boolean;
  initialOperationsHandoff: boolean;
  recurringOperationsHandoff: boolean;
}): Promise<ForHireReleasePolicy> {
  if (!Number.isInteger(input.approvedBy) || input.approvedBy <= 0 || !Number.isFinite(Date.parse(input.effectiveFrom)) ||
    !input.forHireOnlyVtigerBranch || !input.initialOperationsHandoff) {
    throw new Error("For Hire initial release needs an administrator, effective time, independent VTiger branch, and initial Operations handover.");
  }
  const policy: ForHireReleasePolicy = {
    releaseKey: `FOR-HIRE-${FOR_HIRE_RULES_HASH.slice(0, 16)}`,
    rulesHash: FOR_HIRE_RULES_HASH,
    enabled: true,
    initialEnabled: true,
    recurringEnabled: input.recurringOperationsHandoff,
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
    effectiveFrom: input.effectiveFrom,
    forHireOnlyVtigerBranch: true,
    initialOperationsHandoff: true,
    recurringOperationsHandoff: input.recurringOperationsHandoff,
    migrationScope: "new_events_only",
  };
  await upsertFinancialWorkflowConfig(FOR_HIRE_RELEASE_KEY, policy, input.recurringOperationsHandoff
    ? "Approved For Hire initial and recurring release; separate AP deployment gate, receiver and recurring schedule required."
    : "Approved For Hire initial-only release; recurring AP scheduling remains disabled until the Operations recurring handover.", input.approvedBy);
  return policy;
}
