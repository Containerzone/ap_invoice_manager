import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";
import { ASSET_PURCHASE_RULES_HASH } from "./financialAssetPurchaseDrafts";

export const ASSET_PURCHASE_RELEASE_KEY = "financial-automation.asset-purchase-release" as const;

export type AssetPurchaseReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  /** VTiger action contains only Asset / REQUEST records for this AP route. */
  assetOnlyVtigerBranch: boolean;
  /** Operations Asset writer is paused before the AP receiver is armed. */
  operationsAssetHandoff: boolean;
  migrationScope: "new_events_only";
};

export function resolveAssetPurchaseRelease(value: unknown): AssetPurchaseReleasePolicy {
  const raw = value && typeof value === "object" ? value as Partial<AssetPurchaseReleasePolicy> : {};
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : ASSET_PURCHASE_RULES_HASH,
    enabled: raw.enabled === true,
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom: typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    assetOnlyVtigerBranch: raw.assetOnlyVtigerBranch === true,
    operationsAssetHandoff: raw.operationsAssetHandoff === true,
    migrationScope: "new_events_only",
  };
}

export async function getAssetPurchaseReleasePolicy(): Promise<AssetPurchaseReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveAssetPurchaseRelease(configs.find((item) => item.configKey === ASSET_PURCHASE_RELEASE_KEY)?.configValue);
}

export function assertAssetPurchaseRelease(policy: AssetPurchaseReleasePolicy): void {
  if (process.env.FINANCIAL_ASSET_PURCHASE_AUTOMATIC_ENABLED !== "true" || !policy.enabled || !policy.releaseKey ||
    policy.rulesHash !== ASSET_PURCHASE_RULES_HASH || !policy.approvedBy || !policy.approvedAt || !policy.effectiveFrom ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.approvedAt) > Date.now() || Date.parse(policy.effectiveFrom) > Date.now()) {
    throw new Error("Automatic Asset purchase release is disabled or lacks an approved current policy.");
  }
  if (!policy.assetOnlyVtigerBranch || !policy.operationsAssetHandoff) {
    throw new Error("Asset-only VTiger branch and Operations Asset handover are required.");
  }
}

/** AP-local preparation only; it never changes an environment flag, route or external system. */
export async function prepareAssetPurchaseReleasePolicy(preparedBy: number): Promise<AssetPurchaseReleasePolicy> {
  const current = await getAssetPurchaseReleasePolicy();
  if (current.enabled) throw new Error("An enabled Asset purchase policy cannot be replaced by preparation.");
  const policy = resolveAssetPurchaseRelease({
    releaseKey: `ASSET-PO-${ASSET_PURCHASE_RULES_HASH.slice(0, 16)}`,
    rulesHash: ASSET_PURCHASE_RULES_HASH,
  });
  await upsertFinancialWorkflowConfig(ASSET_PURCHASE_RELEASE_KEY, policy, "Prepared Asset purchase release; disabled and non-writing.", preparedBy);
  return policy;
}

/** Records an explicitly approved, new-events-only Asset Purchase PO cutover. */
export async function approveAssetPurchaseReleasePolicy(input: {
  approvedBy: number;
  effectiveFrom: string;
  assetOnlyVtigerBranch: boolean;
  operationsAssetHandoff: boolean;
}): Promise<AssetPurchaseReleasePolicy> {
  if (!Number.isInteger(input.approvedBy) || input.approvedBy <= 0 || !Number.isFinite(Date.parse(input.effectiveFrom)) ||
    !input.assetOnlyVtigerBranch || !input.operationsAssetHandoff) {
    throw new Error("Asset purchase release needs an administrator, effective time, Asset-only VTiger branch, and Operations Asset handover.");
  }
  const policy: AssetPurchaseReleasePolicy = {
    releaseKey: `ASSET-PO-${ASSET_PURCHASE_RULES_HASH.slice(0, 16)}`,
    rulesHash: ASSET_PURCHASE_RULES_HASH,
    enabled: true,
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
    effectiveFrom: input.effectiveFrom,
    assetOnlyVtigerBranch: true,
    operationsAssetHandoff: true,
    migrationScope: "new_events_only",
  };
  await upsertFinancialWorkflowConfig(ASSET_PURCHASE_RELEASE_KEY, policy, "Approved Asset purchase release; AP can create a new, exact Xero Draft A-reference after current source/Xero validation.", input.approvedBy);
  return policy;
}
