import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";
import { financialSha256 } from "./financialProposalIntegrity";
import { D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY } from "./financialD702959AuthorisedDepositMainDeductionRecoveryScope";

export const D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY = "financial-automation.d702959-authorised-deposit-main-deduction-recovery-release";
export type D702959AuthorisedDepositMainDeductionRecoveryPolicy = {
  enabled: boolean; releaseKey: string; approvedBy: number | null; approvedAt: string | null; scope: unknown;
};

/** No generic, D702946, Deposit, or Main release can arm this isolated exception. */
export function resolveD702959AuthorisedDepositMainDeductionRecoveryPolicy(value: unknown): D702959AuthorisedDepositMainDeductionRecoveryPolicy {
  const raw = value && typeof value === "object" ? value as Partial<D702959AuthorisedDepositMainDeductionRecoveryPolicy> : {};
  return {
    enabled: raw.enabled === true,
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    scope: raw.scope ?? null,
  };
}
export function assertD702959AuthorisedDepositMainDeductionRecoveryRelease(policy: D702959AuthorisedDepositMainDeductionRecoveryPolicy): void {
  if (process.env.FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED !== "true" || !policy.enabled ||
    policy.releaseKey !== D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY || !policy.approvedBy || !policy.approvedAt ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || Date.parse(policy.approvedAt) > Date.now() ||
    financialSha256(policy.scope) !== financialSha256(scope)) {
    throw new Error("D702959 Authorised-Deposit deduction recovery is disabled or lacks its separate exact-scope named approval.");
  }
}
export async function getD702959AuthorisedDepositMainDeductionRecoveryPolicy(): Promise<D702959AuthorisedDepositMainDeductionRecoveryPolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveD702959AuthorisedDepositMainDeductionRecoveryPolicy(configs.find(row => row.configKey === D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY)?.configValue);
}
/** Server-only configuration helper. It never enables the independent environment gate. */
export async function approveD702959AuthorisedDepositMainDeductionRecoveryPolicy(approvedBy: number): Promise<D702959AuthorisedDepositMainDeductionRecoveryPolicy> {
  if (!Number.isInteger(approvedBy) || approvedBy <= 0) throw new Error("A named AP approver is required for D702959 recovery.");
  const policy: D702959AuthorisedDepositMainDeductionRecoveryPolicy = { enabled: true, releaseKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY,
    approvedBy, approvedAt: new Date().toISOString(), scope };
  await upsertFinancialWorkflowConfig(D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY, policy,
    "Separately named one-document D702959 Authorised-Deposit deduction recovery; environment remains independently default-off.", approvedBy);
  return policy;
}
