import { getFinancialWorkflowConfig, upsertFinancialWorkflowConfig } from "./financialWorkflowDb";
import { financialSha256 } from "./financialProposalIntegrity";
import { D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_RECOVERY_RELEASE_KEY } from "./financialD702946DepositMainDeductionRecoveryScope";

export const D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY = "financial-automation.d702946-deposit-main-deduction-recovery-release";
export type D702946DepositMainDeductionRecoveryPolicy = {
  enabled: boolean; releaseKey: string; approvedBy: number | null; approvedAt: string | null;
  scope: unknown;
};
/** Missing/other-family config cannot silently supply the fixed recovery scope or approval. */
export function resolveD702946DepositMainDeductionRecoveryPolicy(value: unknown): D702946DepositMainDeductionRecoveryPolicy {
  const raw = value && typeof value === "object" ? value as Partial<D702946DepositMainDeductionRecoveryPolicy> : {};
  return { enabled: raw.enabled === true, releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null, scope: raw.scope ?? null };
}
export function assertD702946DepositMainDeductionRecoveryRelease(policy: D702946DepositMainDeductionRecoveryPolicy): void {
  if (process.env.FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED !== "true" || !policy.enabled ||
    policy.releaseKey !== D702946_RECOVERY_RELEASE_KEY || !policy.approvedBy || !policy.approvedAt ||
    !Number.isFinite(Date.parse(policy.approvedAt)) || Date.parse(policy.approvedAt) > Date.now() ||
    financialSha256(policy.scope) !== financialSha256(scope)) throw new Error("D702946 Deposit-to-main deduction recovery is disabled or lacks its separate exact-scope approval.");
}
export async function getD702946DepositMainDeductionRecoveryPolicy(): Promise<D702946DepositMainDeductionRecoveryPolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveD702946DepositMainDeductionRecoveryPolicy(configs.find(row => row.configKey === D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY)?.configValue);
}
/** AP-local helper only; never imported by a route and never sets an environment gate. */
export async function approveD702946DepositMainDeductionRecoveryPolicy(approvedBy: number): Promise<D702946DepositMainDeductionRecoveryPolicy> {
  if (!Number.isInteger(approvedBy) || approvedBy <= 0) throw new Error("Named AP approver is required for the fixed D702946 recovery.");
  const policy = { enabled: true, releaseKey: D702946_RECOVERY_RELEASE_KEY, approvedBy, approvedAt: new Date().toISOString(), scope };
  await upsertFinancialWorkflowConfig(D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_CONFIG_KEY, policy,
    "Separately approved one bounded D702946 Deposit-to-main deduction recovery; environment remains independently default-off.", approvedBy);
  return policy;
}
