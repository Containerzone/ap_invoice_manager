import { createHash } from "node:crypto";
import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";

export const FOR_HIRE_RELEASE_KEY = "financial-automation.for-hire-release" as const;
export const FOR_HIRE_RULES_VERSION = "for-hire-container-control-v2-standing-release" as const;
export const FOR_HIRE_RULES_HASH = createHash("sha256").update(FOR_HIRE_RULES_VERSION).digest("hex");
/** Separate recurring authority: changing it never invalidates initial Request POs. */
export const FOR_HIRE_RECURRING_RULES_HASH = createHash("sha256").update("for-hire-recurring-v3-scoped-mixed-history-opening").digest("hex");

export type ForHireReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  initialEnabled: boolean;
  recurringEnabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  forHireOnlyVtigerBranch: boolean;
  initialOperationsHandoff: boolean;
  /** Legacy/manual creation is stopped for every explicitly released control. */
  recurringOperationsHandoff: boolean;
  migrationScope: "new_events_only";
  recurringRulesHash: string | null;
  recurringControlIds: string[];
  recurringApprovedAt: string | null;
  recurringEffectiveFrom: string | null;
};

function validControlScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200 || value.some(id => typeof id !== "string" || !/^\d+x\d+$/.test(id))) return [];
  return Array.from(new Set<string>(value)).sort();
}
export function resolveForHireRelease(value: unknown): ForHireReleasePolicy {
  const raw = value && typeof value === "object" ? value as Partial<ForHireReleasePolicy> : {};
  const initialEnabled = raw.initialEnabled === true || (raw.initialEnabled === undefined && raw.enabled === true);
  const recurringEnabled = raw.recurringEnabled === true || (raw.recurringEnabled === undefined && raw.enabled === true && raw.recurringOperationsHandoff === true);
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : FOR_HIRE_RULES_HASH,
    enabled: initialEnabled || recurringEnabled,
    initialEnabled, recurringEnabled,
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom: typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    forHireOnlyVtigerBranch: raw.forHireOnlyVtigerBranch === true,
    initialOperationsHandoff: raw.initialOperationsHandoff === true,
    recurringOperationsHandoff: raw.recurringOperationsHandoff === true,
    migrationScope: "new_events_only",
    recurringRulesHash: typeof raw.recurringRulesHash === "string" ? raw.recurringRulesHash : null,
    recurringControlIds: validControlScope(raw.recurringControlIds),
    recurringApprovedAt: typeof raw.recurringApprovedAt === "string" ? raw.recurringApprovedAt : null,
    recurringEffectiveFrom: typeof raw.recurringEffectiveFrom === "string" ? raw.recurringEffectiveFrom : null,
  };
}
export async function getForHireReleasePolicy(): Promise<ForHireReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveForHireRelease(configs.find(item => item.configKey === FOR_HIRE_RELEASE_KEY)?.configValue);
}
export function assertForHireRelease(policy: ForHireReleasePolicy, phase: "initial" | "recurring"): void {
  if (process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED !== "true" || !policy.enabled || !policy.releaseKey ||
      policy.rulesHash !== FOR_HIRE_RULES_HASH || !policy.approvedBy || !policy.approvedAt || !policy.effectiveFrom ||
      !Number.isFinite(Date.parse(policy.approvedAt)) || !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
      Date.parse(policy.approvedAt) > Date.now() || Date.parse(policy.effectiveFrom) > Date.now()) {
    throw new Error("Automatic For Hire release is disabled or lacks an approved current policy.");
  }
  if (!policy.forHireOnlyVtigerBranch || !policy.initialOperationsHandoff) throw new Error("FOR HIRE-only VTiger branch and initial Operations handover are required.");
  if (phase === "initial" && !policy.initialEnabled) throw new Error("Initial For Hire Draft PO release is not enabled.");
  if (phase === "recurring") {
    if (!policy.recurringEnabled || !policy.recurringOperationsHandoff) throw new Error("Operations For Hire recurring schedule handover and recurring AP release are required.");
    if (policy.recurringRulesHash !== FOR_HIRE_RECURRING_RULES_HASH || validControlScope(policy.recurringControlIds).length === 0 ||
        !policy.recurringApprovedAt || !policy.recurringEffectiveFrom || !Number.isFinite(Date.parse(policy.recurringApprovedAt)) ||
        !Number.isFinite(Date.parse(policy.recurringEffectiveFrom)) || Date.parse(policy.recurringApprovedAt) > Date.now() || Date.parse(policy.recurringEffectiveFrom) > Date.now()) {
      throw new Error("Recurring For Hire requires a current scoped release, explicit controls and effective handover approval.");
    }
  }
}
export function assertForHireRecurringControlAllowed(policy: ForHireReleasePolicy, recordId: string): void {
  assertForHireRelease(policy, "recurring");
  if (!/^\d+x\d+$/.test(recordId) || !policy.recurringControlIds.includes(recordId)) throw new Error("This Container Control is outside the explicitly approved recurring For Hire scope.");
}
/** Local preparation only, never activation or scheduler creation. */
export async function prepareForHireReleasePolicy(preparedBy: number): Promise<ForHireReleasePolicy> {
  const current = await getForHireReleasePolicy();
  if (current.enabled) throw new Error("An enabled For Hire policy cannot be replaced by preparation.");
  const policy = resolveForHireRelease({ releaseKey: `FOR-HIRE-${FOR_HIRE_RULES_HASH.slice(0, 16)}`, rulesHash: FOR_HIRE_RULES_HASH });
  await upsertFinancialWorkflowConfig(FOR_HIRE_RELEASE_KEY, policy, "Prepared For Hire standing release; disabled and non-writing.", preparedBy);
  return policy;
}
/** Initial cutover remains independent; legacy recurring flags cannot grant unscoped authority. */
export async function approveForHireReleasePolicy(input: { approvedBy: number; effectiveFrom: string; forHireOnlyVtigerBranch: boolean; initialOperationsHandoff: boolean; recurringOperationsHandoff: boolean }): Promise<ForHireReleasePolicy> {
  if (!Number.isInteger(input.approvedBy) || input.approvedBy <= 0 || !Number.isFinite(Date.parse(input.effectiveFrom)) || !input.forHireOnlyVtigerBranch || !input.initialOperationsHandoff) throw new Error("For Hire initial release needs an administrator, effective time, independent VTiger branch, and initial Operations handover.");
  const policy = resolveForHireRelease({
    releaseKey: `FOR-HIRE-${FOR_HIRE_RULES_HASH.slice(0, 16)}`, rulesHash: FOR_HIRE_RULES_HASH,
    enabled: true, initialEnabled: true, recurringEnabled: input.recurringOperationsHandoff,
    approvedBy: input.approvedBy, approvedAt: new Date().toISOString(), effectiveFrom: input.effectiveFrom,
    forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: input.recurringOperationsHandoff,
  });
  await upsertFinancialWorkflowConfig(FOR_HIRE_RELEASE_KEY, policy, "Approved For Hire initial release; recurring additionally requires a separately approved exact-control scope and managed schedule.", input.approvedBy);
  return policy;
}
/** Explicit scoped cutover, preserving the original initial approval/time and every unrelated family. */
export async function approveRecurringForHireRelease(input: { approvedBy: number; effectiveFrom: string; approvedControlIds: string[]; recurringOperationsHandoff: true }): Promise<ForHireReleasePolicy> {
  const current = await getForHireReleasePolicy();
  assertForHireRelease(current, "initial");
  const controls = validControlScope(input.approvedControlIds);
  if (input.approvedBy !== current.approvedBy || input.recurringOperationsHandoff !== true || !Number.isFinite(Date.parse(input.effectiveFrom)) || controls.length === 0) throw new Error("Recurring approval requires the existing release administrator, exact controls, effective time and stopped legacy/manual creation for those controls.");
  const policy: ForHireReleasePolicy = {
    ...current, recurringEnabled: true, recurringOperationsHandoff: true,
    recurringRulesHash: FOR_HIRE_RECURRING_RULES_HASH, recurringControlIds: controls,
    recurringApprovedAt: new Date().toISOString(), recurringEffectiveFrom: input.effectiveFrom,
  };
  await upsertFinancialWorkflowConfig(FOR_HIRE_RELEASE_KEY, policy, "Scoped future-only recurring For Hire handover approved; initial cutover preserved. Separate published daily Heartbeat and exact container opening evidence required.", input.approvedBy);
  return policy;
}
