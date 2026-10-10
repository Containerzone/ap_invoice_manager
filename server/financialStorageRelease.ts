import { createHash } from "node:crypto";
import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";

export const STORAGE_RELEASE_KEY = "financial-automation.loaded-storage-release";
export const STORAGE_RULES_VERSION = "loaded-storage-v2-monthly-final-inclusive";
export const STORAGE_RULES_HASH = createHash("sha256").update(STORAGE_RULES_VERSION).digest("hex");
export type StorageReleasePolicy = {
  releaseKey: string; rulesHash: string; enabled: boolean; approvedBy: number | null;
  approvedAt: string | null; effectiveFrom: string | null;
  handoffs: { activation: boolean; recurring: boolean; finalisation: boolean };
  recoveryEnabled: boolean;
};
export function resolveStorageRelease(value: unknown): StorageReleasePolicy {
  const v = (value && typeof value === "object" ? value : {}) as Partial<StorageReleasePolicy>;
  return { releaseKey: v.releaseKey ?? "", rulesHash: v.rulesHash ?? STORAGE_RULES_HASH, enabled: v.enabled === true,
    approvedBy: v.approvedBy ?? null, approvedAt: v.approvedAt ?? null, effectiveFrom: v.effectiveFrom ?? null,
    handoffs: { activation: v.handoffs?.activation === true, recurring: v.handoffs?.recurring === true, finalisation: v.handoffs?.finalisation === true },
    recoveryEnabled: v.recoveryEnabled === true };
}
export async function getStorageReleasePolicy(): Promise<StorageReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveStorageRelease(configs.find(c => c.configKey === STORAGE_RELEASE_KEY)?.configValue);
}
export function assertStorageRelease(policy: StorageReleasePolicy, kind: "initial" | "recurring" | "finalisation" | "recovery"): void {
  if (process.env.FINANCIAL_STORAGE_AUTOMATIC_ENABLED !== "true" || !policy.enabled || !policy.releaseKey ||
    policy.rulesHash !== STORAGE_RULES_HASH || !Number.isInteger(policy.approvedBy) || !policy.approvedBy || !policy.approvedAt ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || Date.parse(policy.approvedAt) > Date.now() ||
    !policy.effectiveFrom || !Number.isFinite(Date.parse(policy.effectiveFrom)) || Date.parse(policy.effectiveFrom) > Date.now()) {
    throw new Error("Automatic loaded-storage release is disabled or has no approved current rules policy.");
  }
  const handoff = kind === "initial" || kind === "recovery" ? "activation" : kind;
  if (!policy.handoffs[handoff]) throw new Error(`Legacy ${handoff} storage writer handover is not confirmed.`);
  if (kind === "recovery" && (!policy.recoveryEnabled || !policy.handoffs.finalisation)) throw new Error("Missing-document recovery is not released.");
}
/** AP-local preparation only; enabling is intentionally a separate deployment/cutover action. */
export async function prepareStorageReleasePolicy(preparedBy: number) {
  const old = await getStorageReleasePolicy();
  if (old.enabled) throw new Error("An enabled storage policy cannot be replaced by preparation.");
  const policy: StorageReleasePolicy = { ...resolveStorageRelease(null), releaseKey: `STORAGE-${STORAGE_RULES_HASH.slice(0, 16)}`, rulesHash: STORAGE_RULES_HASH };
  await upsertFinancialWorkflowConfig(STORAGE_RELEASE_KEY, policy, "Prepared loaded-storage standing release; disabled, no external changes.", preparedBy);
  return policy;
}

/** Call only after the exact storage-only standing-release scope is approved; never changes deployment flags or external workflows. */
export async function approveStorageReleasePolicy(input: {
  approvedBy: number; effectiveFrom: string;
  handoffs: StorageReleasePolicy["handoffs"]; recoveryEnabled: boolean;
}) {
  if (!Number.isInteger(input.approvedBy) || input.approvedBy <= 0 || !Number.isFinite(Date.parse(input.effectiveFrom)) ||
    !input.handoffs.activation || !input.handoffs.recurring || !input.handoffs.finalisation) throw new Error("Storage release requires an exact effective time, administrator and all three handovers.");
  const policy: StorageReleasePolicy = { releaseKey: `STORAGE-${STORAGE_RULES_HASH.slice(0,16)}`, rulesHash: STORAGE_RULES_HASH,
    enabled: true, approvedBy: input.approvedBy, approvedAt: new Date().toISOString(), effectiveFrom: input.effectiveFrom,
    handoffs: input.handoffs, recoveryEnabled: input.recoveryEnabled };
  await upsertFinancialWorkflowConfig(STORAGE_RELEASE_KEY, policy, "Approved storage-only standing policy; separate deployment gate and source/schedule cutover required.", input.approvedBy);
  return policy;
}
