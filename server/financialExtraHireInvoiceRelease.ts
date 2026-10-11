import { getFinancialWorkflowConfig } from "./financialWorkflowDb";
import {
  EXTRA_HIRE_RULES_HASH,
  EXTRA_HIRE_SUFFIX_SCHEME,
} from "./financialExtraHireInvoiceRules";
export const EXTRA_HIRE_RELEASE_KEY =
  "financial-automation.extra-hire-invoice-release";
export type ExtraHireReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  extraHireOnlyVtigerBranch: boolean;
  operationsExtraHireHandoff: boolean;
  sourceMappingsConfirmed: boolean;
  sourceMappingsHash: string;
  invoiceSuffixCollisionSchemeConfirmed: boolean;
  suffixScheme: string | null;
  isolatedDraftOnlyApproved: boolean;
  postSuccessHireEndDateAcknowledged: boolean;
  dateSemantics: string | null;
  migrationScope: "new_events_only";
};
export function resolveExtraHireRelease(
  value: unknown
): ExtraHireReleasePolicy {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ExtraHireReleasePolicy>)
      : {};
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : "",
    enabled: raw.enabled === true && raw.migrationScope === "new_events_only",
    approvedBy:
      Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0
        ? Number(raw.approvedBy)
        : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom:
      typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    extraHireOnlyVtigerBranch: raw.extraHireOnlyVtigerBranch === true,
    operationsExtraHireHandoff: raw.operationsExtraHireHandoff === true,
    sourceMappingsConfirmed: raw.sourceMappingsConfirmed === true,
    sourceMappingsHash:
      typeof raw.sourceMappingsHash === "string" ? raw.sourceMappingsHash : "",
    invoiceSuffixCollisionSchemeConfirmed:
      raw.invoiceSuffixCollisionSchemeConfirmed === true,
    suffixScheme:
      typeof raw.suffixScheme === "string" ? raw.suffixScheme : null,
    isolatedDraftOnlyApproved: raw.isolatedDraftOnlyApproved === true,
    postSuccessHireEndDateAcknowledged:
      raw.postSuccessHireEndDateAcknowledged === true,
    dateSemantics:
      typeof raw.dateSemantics === "string" ? raw.dateSemantics : null,
    migrationScope: "new_events_only",
  };
}
export async function getExtraHireReleasePolicy() {
  const rows = await getFinancialWorkflowConfig();
  return resolveExtraHireRelease(
    rows.find(r => r.configKey === EXTRA_HIRE_RELEASE_KEY)?.configValue
  );
}
export function assertExtraHireRelease(policy: ExtraHireReleasePolicy) {
  if (
    process.env.FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED !== "true" ||
    !policy.enabled ||
    policy.releaseKey !== EXTRA_HIRE_RELEASE_KEY ||
    policy.rulesHash !== EXTRA_HIRE_RULES_HASH ||
    !policy.approvedBy ||
    !policy.approvedAt ||
    !policy.effectiveFrom ||
    !Number.isFinite(Date.parse(policy.approvedAt)) ||
    !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.approvedAt) > Date.now() ||
    Date.parse(policy.effectiveFrom) > Date.now() ||
    policy.migrationScope !== "new_events_only" ||
    !policy.extraHireOnlyVtigerBranch ||
    !policy.operationsExtraHireHandoff ||
    !policy.sourceMappingsConfirmed ||
    !/^[a-f0-9]{64}$/.test(policy.sourceMappingsHash) ||
    !policy.invoiceSuffixCollisionSchemeConfirmed ||
    policy.suffixScheme !== EXTRA_HIRE_SUFFIX_SCHEME ||
    !policy.isolatedDraftOnlyApproved ||
    !policy.postSuccessHireEndDateAcknowledged ||
    policy.dateSemantics !== "CURRENT_HIRE_END_DATE_NO_DUE_DATE"
  ) {
    throw new Error(
      "Extra Hire release disabled: independent branch/handover, exact mappings, suffix/collision scheme, source date semantics, isolated Draft and separate Hire End Date acknowledgment required."
    );
  }
}
