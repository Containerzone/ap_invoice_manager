import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";
import { CUSTOMER_SALE_PURCHASE_RULES_HASH } from "./financialCustomerSalePurchaseDrafts";

export const CUSTOMER_SALE_PURCHASE_RELEASE_KEY = "financial-automation.customer-sale-purchase-release" as const;

export type CustomerSalePurchaseReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  /** VTiger action contains only Customer Sale / REQUEST records for this AP route. */
  customerSaleOnlyVtigerBranch: boolean;
  /** Operations Customer Sale writer is paused before the AP receiver is armed. */
  operationsCustomerSaleHandoff: boolean;
  migrationScope: "new_events_only";
};

export function resolveCustomerSalePurchaseRelease(value: unknown): CustomerSalePurchaseReleasePolicy {
  const raw = value && typeof value === "object" ? value as Partial<CustomerSalePurchaseReleasePolicy> : {};
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : CUSTOMER_SALE_PURCHASE_RULES_HASH,
    enabled: raw.enabled === true,
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom: typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    customerSaleOnlyVtigerBranch: raw.customerSaleOnlyVtigerBranch === true,
    operationsCustomerSaleHandoff: raw.operationsCustomerSaleHandoff === true,
    migrationScope: "new_events_only",
  };
}

export async function getCustomerSalePurchaseReleasePolicy(): Promise<CustomerSalePurchaseReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveCustomerSalePurchaseRelease(configs.find((item) => item.configKey === CUSTOMER_SALE_PURCHASE_RELEASE_KEY)?.configValue);
}

export function assertCustomerSalePurchaseRelease(policy: CustomerSalePurchaseReleasePolicy): void {
  if (process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED !== "true" || !policy.enabled || !policy.releaseKey ||
    policy.rulesHash !== CUSTOMER_SALE_PURCHASE_RULES_HASH || !policy.approvedBy || !policy.approvedAt || !policy.effectiveFrom ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.approvedAt) > Date.now() || Date.parse(policy.effectiveFrom) > Date.now()) {
    throw new Error("Automatic Customer Sale purchase release is disabled or lacks an approved current policy.");
  }
  if (!policy.customerSaleOnlyVtigerBranch || !policy.operationsCustomerSaleHandoff) {
    throw new Error("Customer Sale-only VTiger branch and Operations Customer Sale handover are required.");
  }
}

/** AP-local preparation only; it never changes an environment flag, route or external system. */
export async function prepareCustomerSalePurchaseReleasePolicy(preparedBy: number): Promise<CustomerSalePurchaseReleasePolicy> {
  const current = await getCustomerSalePurchaseReleasePolicy();
  if (current.enabled) throw new Error("An enabled Customer Sale purchase policy cannot be replaced by preparation.");
  const policy = resolveCustomerSalePurchaseRelease({
    releaseKey: `CUSTOMER-SALE-PO-${CUSTOMER_SALE_PURCHASE_RULES_HASH.slice(0, 16)}`,
    rulesHash: CUSTOMER_SALE_PURCHASE_RULES_HASH,
  });
  await upsertFinancialWorkflowConfig(CUSTOMER_SALE_PURCHASE_RELEASE_KEY, policy, "Prepared Customer Sale purchase release; disabled and non-writing.", preparedBy);
  return policy;
}

/** Records an explicitly approved, new-events-only Customer Sale Purchase PO cutover. */
export async function approveCustomerSalePurchaseReleasePolicy(input: {
  approvedBy: number;
  effectiveFrom: string;
  customerSaleOnlyVtigerBranch: boolean;
  operationsCustomerSaleHandoff: boolean;
}): Promise<CustomerSalePurchaseReleasePolicy> {
  if (!Number.isInteger(input.approvedBy) || input.approvedBy <= 0 || !Number.isFinite(Date.parse(input.effectiveFrom)) ||
    !input.customerSaleOnlyVtigerBranch || !input.operationsCustomerSaleHandoff) {
    throw new Error("Customer Sale purchase release needs an administrator, effective time, Customer Sale-only VTiger branch, and Operations Customer Sale handover.");
  }
  const policy: CustomerSalePurchaseReleasePolicy = {
    releaseKey: `CUSTOMER-SALE-PO-${CUSTOMER_SALE_PURCHASE_RULES_HASH.slice(0, 16)}`,
    rulesHash: CUSTOMER_SALE_PURCHASE_RULES_HASH,
    enabled: true,
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
    effectiveFrom: input.effectiveFrom,
    customerSaleOnlyVtigerBranch: true,
    operationsCustomerSaleHandoff: true,
    migrationScope: "new_events_only",
  };
  await upsertFinancialWorkflowConfig(CUSTOMER_SALE_PURCHASE_RELEASE_KEY, policy, "Approved Customer Sale purchase release; AP can create a new, exact Xero Draft S-reference after current source/Xero validation.", input.approvedBy);
  return policy;
}
