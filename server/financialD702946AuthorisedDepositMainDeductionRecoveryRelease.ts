import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";
import { financialSha256 } from "./financialProposalIntegrity";
import { D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY } from "./financialD702946AuthorisedDepositMainDeductionRecoveryScope";

export const D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY = "financial-automation.d702946-authorised-deposit-main-deduction-recovery-release";
export type D702946AuthorisedDepositMainDeductionRecoveryPolicy = {
  enabled: boolean; releaseKey: string; approvedBy: number | null; approvedAt: string | null; scope: unknown;
};
/** A V1 config cannot silently arm this V2 Authorised-Deposit exception. */
export function resolveD702946AuthorisedDepositMainDeductionRecoveryPolicy(value: unknown): D702946AuthorisedDepositMainDeductionRecoveryPolicy {
  const raw = value && typeof value === "object" ? value as Partial<D702946AuthorisedDepositMainDeductionRecoveryPolicy> : {};
  return { enabled: raw.enabled === true, releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null, scope: raw.scope ?? null };
}
export function assertD702946AuthorisedDepositMainDeductionRecoveryRelease(policy: D702946AuthorisedDepositMainDeductionRecoveryPolicy): void {
  if (process.env.FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED !== "true" || !policy.enabled ||
    policy.releaseKey !== D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY || !policy.approvedBy || !policy.approvedAt ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || Date.parse(policy.approvedAt) > Date.now() ||
    financialSha256(policy.scope) !== financialSha256(scope)) throw new Error("D702946 Authorised-Deposit deduction recovery is disabled or lacks its separate exact-scope approval.");
}
export async function getD702946AuthorisedDepositMainDeductionRecoveryPolicy(): Promise<D702946AuthorisedDepositMainDeductionRecoveryPolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveD702946AuthorisedDepositMainDeductionRecoveryPolicy(configs.find(row => row.configKey === D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY)?.configValue);
}
/** Server-only helper; it never sets the independent environment gate. */
export async function approveD702946AuthorisedDepositMainDeductionRecoveryPolicy(approvedBy: number): Promise<D702946AuthorisedDepositMainDeductionRecoveryPolicy> {
  if (!Number.isInteger(approvedBy) || approvedBy <= 0) throw new Error("Named AP approver is required for the fixed D702946 Authorised-Deposit recovery.");
  const policy = { enabled: true, releaseKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, approvedBy, approvedAt: new Date().toISOString(), scope };
  await upsertFinancialWorkflowConfig(D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY, policy,
    "Separately approved one bounded D702946 Authorised-Deposit deduction recovery; environment remains independently default-off.", approvedBy);
  return policy;
}
