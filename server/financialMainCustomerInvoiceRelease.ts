import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";
import { MAIN_CUSTOMER_INVOICE_RULES_HASH } from "./financialMainCustomerInvoiceDrafts";

export const MAIN_CUSTOMER_INVOICE_RELEASE_KEY = "financial-automation.main-customer-invoice-release" as const;

export type MainCustomerInvoiceReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  /** Dedicated VTiger main-invoice action, not a generic Deal webhook. */
  mainInvoiceOnlyVtigerBranch: boolean;
  /** The legacy Operations main-invoice writer has been paused for new events. */
  operationsMainInvoiceHandoff: boolean;
  migrationScope: "new_events_only";
};

export function resolveMainCustomerInvoiceRelease(value: unknown): MainCustomerInvoiceReleasePolicy {
  const raw = value && typeof value === "object" ? value as Partial<MainCustomerInvoiceReleasePolicy> : {};
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : MAIN_CUSTOMER_INVOICE_RULES_HASH,
    enabled: raw.enabled === true,
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom: typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    mainInvoiceOnlyVtigerBranch: raw.mainInvoiceOnlyVtigerBranch === true,
    operationsMainInvoiceHandoff: raw.operationsMainInvoiceHandoff === true,
    migrationScope: "new_events_only",
  };
}

export async function getMainCustomerInvoiceReleasePolicy(): Promise<MainCustomerInvoiceReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveMainCustomerInvoiceRelease(configs.find((item) => item.configKey === MAIN_CUSTOMER_INVOICE_RELEASE_KEY)?.configValue);
}

export function assertMainCustomerInvoiceRelease(policy: MainCustomerInvoiceReleasePolicy): void {
  if (process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED !== "true" || !policy.enabled || !policy.releaseKey ||
    policy.rulesHash !== MAIN_CUSTOMER_INVOICE_RULES_HASH || !policy.approvedBy || !policy.approvedAt || !policy.effectiveFrom ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.approvedAt) > Date.now() || Date.parse(policy.effectiveFrom) > Date.now()) {
    throw new Error("Automatic Main Customer Invoice release is disabled or lacks an approved current policy.");
  }
  if (!policy.mainInvoiceOnlyVtigerBranch || !policy.operationsMainInvoiceHandoff) {
    throw new Error("Dedicated Main Invoice VTiger branch and Operations Main Invoice handover are required.");
  }
}

/** AP-local preparation only; it cannot set a deployment flag or call Xero. */
export async function prepareMainCustomerInvoiceReleasePolicy(preparedBy: number): Promise<MainCustomerInvoiceReleasePolicy> {
  const current = await getMainCustomerInvoiceReleasePolicy();
  if (current.enabled) throw new Error("An enabled Main Customer Invoice policy cannot be replaced by preparation.");
  const policy = resolveMainCustomerInvoiceRelease({
    releaseKey: `MAIN-INV-${MAIN_CUSTOMER_INVOICE_RULES_HASH.slice(0, 16)}`,
    rulesHash: MAIN_CUSTOMER_INVOICE_RULES_HASH,
  });
  await upsertFinancialWorkflowConfig(MAIN_CUSTOMER_INVOICE_RELEASE_KEY, policy, "Prepared Main Customer Invoice release; disabled and non-writing.", preparedBy);
  return policy;
}

/** Records a separately approved, new-events-only Main Customer Invoice handover. */
export async function approveMainCustomerInvoiceReleasePolicy(input: {
  approvedBy: number;
  effectiveFrom: string;
  mainInvoiceOnlyVtigerBranch: boolean;
  operationsMainInvoiceHandoff: boolean;
}): Promise<MainCustomerInvoiceReleasePolicy> {
  if (!Number.isInteger(input.approvedBy) || input.approvedBy <= 0 || !Number.isFinite(Date.parse(input.effectiveFrom)) ||
    !input.mainInvoiceOnlyVtigerBranch || !input.operationsMainInvoiceHandoff) {
    throw new Error("Main Customer Invoice release needs an administrator, effective time, dedicated VTiger branch, and Operations Main Invoice handover.");
  }
  const policy: MainCustomerInvoiceReleasePolicy = {
    releaseKey: `MAIN-INV-${MAIN_CUSTOMER_INVOICE_RULES_HASH.slice(0, 16)}`,
    rulesHash: MAIN_CUSTOMER_INVOICE_RULES_HASH,
    enabled: true,
    approvedBy: input.approvedBy,
    approvedAt: new Date().toISOString(),
    effectiveFrom: input.effectiveFrom,
    mainInvoiceOnlyVtigerBranch: true,
    operationsMainInvoiceHandoff: true,
    migrationScope: "new_events_only",
  };
  await upsertFinancialWorkflowConfig(MAIN_CUSTOMER_INVOICE_RELEASE_KEY, policy, "Approved Main Customer Invoice release; AP can create one exact, current-source Xero Draft INV-reference.", input.approvedBy);
  return policy;
}
