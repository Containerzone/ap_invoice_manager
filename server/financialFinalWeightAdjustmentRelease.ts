import { getFinancialWorkflowConfig } from "./financialWorkflowDb";
import { FINAL_WEIGHT_RULES_HASH, type FinalWeightDirection } from "./financialFinalWeightAdjustmentRules";
export const FINAL_WEIGHT_RELEASE_KEY = "financial-automation.final-weight-adjustment-release";
export type FinalWeightReleasePolicy = {
  releaseKey: string; rulesHash: string; enabled: boolean; approvedBy: number | null; approvedAt: string | null; effectiveFrom: string | null;
  overweightVtigerBranch: boolean; underweightVtigerBranch: boolean; operationsOverweightHandoff: boolean; operationsUnderweightHandoff: boolean;
  sourceMappingsConfirmed: boolean; draftOnlyUpdateApproved: boolean; migrationScope: "new_events_only";
};
export function resolveFinalWeightRelease(value: unknown): FinalWeightReleasePolicy {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<FinalWeightReleasePolicy> : {};
  return { releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "", rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : "",
    enabled: raw.enabled === true && raw.migrationScope === "new_events_only", approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null, effectiveFrom: typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    overweightVtigerBranch: raw.overweightVtigerBranch === true, underweightVtigerBranch: raw.underweightVtigerBranch === true,
    operationsOverweightHandoff: raw.operationsOverweightHandoff === true, operationsUnderweightHandoff: raw.operationsUnderweightHandoff === true,
    sourceMappingsConfirmed: raw.sourceMappingsConfirmed === true, draftOnlyUpdateApproved: raw.draftOnlyUpdateApproved === true, migrationScope: "new_events_only" };
}
export async function getFinalWeightReleasePolicy() {
  const configs = await getFinancialWorkflowConfig();
  return resolveFinalWeightRelease(configs.find(row => row.configKey === FINAL_WEIGHT_RELEASE_KEY)?.configValue);
}
export function assertFinalWeightRelease(policy: FinalWeightReleasePolicy, direction: FinalWeightDirection) {
  if (!["overweight", "underweight"].includes(direction) || process.env.FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED !== "true" ||
    policy.releaseKey !== FINAL_WEIGHT_RELEASE_KEY || policy.rulesHash !== FINAL_WEIGHT_RULES_HASH || !policy.enabled || !policy.approvedBy ||
    !policy.approvedAt || !policy.effectiveFrom || !Number.isFinite(Date.parse(policy.approvedAt)) || !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.approvedAt) > Date.now() || Date.parse(policy.effectiveFrom) > Date.now() || policy.migrationScope !== "new_events_only" ||
    !policy.overweightVtigerBranch || !policy.underweightVtigerBranch || !policy.operationsOverweightHandoff || !policy.operationsUnderweightHandoff ||
    !policy.sourceMappingsConfirmed || !policy.draftOnlyUpdateApproved) throw new Error(`Final Weight ${direction} release disabled: independent dual branch/handover, exact source mappings and new-events-only Draft PUT approval required.`);
}
