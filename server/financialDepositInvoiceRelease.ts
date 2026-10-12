import { getFinancialWorkflowConfig } from "./financialWorkflowDb";
import { DEPOSIT_INVOICE_RULES_HASH } from "./financialDepositInvoiceDrafts";

export const DEPOSIT_INVOICE_RELEASE_KEY =
  "financial-automation.deposit-invoice-release" as const;
export type DepositInvoiceReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  depositOnlyVtigerBranch: boolean;
  operationsDepositHandoff: boolean;
  sourceMappingsConfirmed: boolean;
  isolatedDraftOnlyApproved: boolean;
  mainDraftDeductionApproved: boolean;
  migrationScope: "new_events_only";
};
export function resolveDepositInvoiceRelease(
  value: unknown
): DepositInvoiceReleasePolicy {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<DepositInvoiceReleasePolicy>)
      : {};
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash:
      typeof raw.rulesHash === "string"
        ? raw.rulesHash
        : DEPOSIT_INVOICE_RULES_HASH,
    enabled: raw.enabled === true,
    approvedBy:
      Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0
        ? Number(raw.approvedBy)
        : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom:
      typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    depositOnlyVtigerBranch: raw.depositOnlyVtigerBranch === true,
    operationsDepositHandoff: raw.operationsDepositHandoff === true,
    sourceMappingsConfirmed: raw.sourceMappingsConfirmed === true,
    isolatedDraftOnlyApproved: raw.isolatedDraftOnlyApproved === true,
    mainDraftDeductionApproved: raw.mainDraftDeductionApproved === true,
    // Invalid scopes must fail shut rather than silently coercing a historical import approval.
    migrationScope: "new_events_only",
    ...(raw.migrationScope !== undefined &&
    raw.migrationScope !== "new_events_only"
      ? { enabled: false }
      : {}),
  };
}
export async function getDepositInvoiceReleasePolicy(): Promise<DepositInvoiceReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveDepositInvoiceRelease(
    configs.find(item => item.configKey === DEPOSIT_INVOICE_RELEASE_KEY)
      ?.configValue
  );
}
export function assertDepositInvoiceRelease(
  policy: DepositInvoiceReleasePolicy
): void {
  if (
    process.env.FINANCIAL_DEPOSIT_INVOICE_AUTOMATIC_ENABLED !== "true" ||
    !policy.enabled ||
    !policy.releaseKey ||
    policy.rulesHash !== DEPOSIT_INVOICE_RULES_HASH ||
    !policy.approvedBy ||
    !policy.approvedAt ||
    !policy.effectiveFrom ||
    !Number.isFinite(Date.parse(policy.approvedAt)) ||
    !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.approvedAt) > Date.now() ||
    Date.parse(policy.effectiveFrom) > Date.now() ||
    policy.migrationScope !== "new_events_only"
  )
    throw new Error(
      "Automatic Deposit Invoice release is disabled or lacks a current approved new-events-only policy."
    );
  if (
    !policy.depositOnlyVtigerBranch ||
    !policy.operationsDepositHandoff ||
    !policy.sourceMappingsConfirmed ||
    !policy.isolatedDraftOnlyApproved
  )
    throw new Error(
      "Deposit-only branch, Operations handoff, confirmed source mappings and isolated-Draft-only approval are required."
    );
}

/** A separate release: Deposit creation must never imply a main-Draft amendment. */
export function assertDepositMainDeductionRelease(
  policy: DepositInvoiceReleasePolicy
): void {
  assertDepositInvoiceRelease(policy);
  if (
    process.env.FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED !== "true" ||
    !policy.mainDraftDeductionApproved
  ) {
    throw new Error(
      "Automatic Deposit-to-main Draft deduction is disabled or lacks its separate exact-Draft-only approval."
    );
  }
}
