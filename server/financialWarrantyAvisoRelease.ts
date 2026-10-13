import { getFinancialWorkflowConfig } from "./financialWorkflowDb";
import { financialSha256 } from "./financialProposalIntegrity";
import { AVISO_ACCOUNT, AVISO_NAME, WARRANTY_ADDED_SERVICES_MAPPINGS, WARRANTY_RULES_HASH, type WarrantySourceConfig } from "./financialWarrantyAvisoRules";
export const WARRANTY_RELEASE_KEY = "financial-automation.warranty-aviso-release";
export type WarrantyReleasePolicy = {
  enabled: boolean; releaseKey: string; rulesHash: string; approvedBy: number | null; approvedAt: string | null; effectiveFrom: string | null;
  migrationScope: string | null; warrantyOnlyVtigerBranch: boolean; operationsMakeHandoverAcknowledged: boolean;
  mainInvoiceCoordinationAcknowledged: boolean; isolatedDraftOnlyScope: boolean; draftAmendmentAcknowledged: boolean; enableDraftMainAmendment: boolean;
  sourceConfig: WarrantySourceConfig | null; sourceMappingsHash: string; addedServicesMappingHash: string; xeroConfigurationHashes: Record<string, string>;
  avisoSupplierName: string; avisoAccountCode: string; avisoContactId: string; noCrmPostSuccessMutation: boolean;
};
export function resolveWarrantyRelease(value: unknown): WarrantyReleasePolicy {
  const r = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
  const str = (k: string) => typeof r[k] === "string" ? r[k] : "";
  const hashes = r.xeroConfigurationHashes && typeof r.xeroConfigurationHashes === "object" && !Array.isArray(r.xeroConfigurationHashes) ? r.xeroConfigurationHashes as Record<string, unknown> : {};
  return { enabled: r.enabled === true, releaseKey: str("releaseKey"), rulesHash: str("rulesHash"), approvedBy: Number.isInteger(r.approvedBy) && r.approvedBy > 0 ? r.approvedBy : null,
    approvedAt: str("approvedAt") || null, effectiveFrom: str("effectiveFrom") || null, migrationScope: str("migrationScope") || null,
    warrantyOnlyVtigerBranch: r.warrantyOnlyVtigerBranch === true, operationsMakeHandoverAcknowledged: r.operationsMakeHandoverAcknowledged === true,
    mainInvoiceCoordinationAcknowledged: r.mainInvoiceCoordinationAcknowledged === true, isolatedDraftOnlyScope: r.isolatedDraftOnlyScope === true,
    draftAmendmentAcknowledged: r.draftAmendmentAcknowledged === true, enableDraftMainAmendment: r.enableDraftMainAmendment === true,
    sourceConfig: r.sourceConfig && typeof r.sourceConfig === "object" && !Array.isArray(r.sourceConfig) ? r.sourceConfig : null,
    sourceMappingsHash: str("sourceMappingsHash"), addedServicesMappingHash: str("addedServicesMappingHash"), xeroConfigurationHashes: Object.fromEntries(Object.entries(hashes).filter(([, value]) => typeof value === "string")) as Record<string, string>,
    avisoSupplierName: str("avisoSupplierName"), avisoAccountCode: str("avisoAccountCode"), avisoContactId: str("avisoContactId"), noCrmPostSuccessMutation: r.noCrmPostSuccessMutation === true };
}
export function warrantySourceConfigHash(c: WarrantySourceConfig): string { const { addedServicesMappings: _, ...source } = c; return financialSha256(source); }
export async function getWarrantyReleasePolicy(): Promise<WarrantyReleasePolicy> {
  const rows = await getFinancialWorkflowConfig();
  return resolveWarrantyRelease(rows.find(r => r.configKey === WARRANTY_RELEASE_KEY)?.configValue);
}
export function assertWarrantyRelease(p: WarrantyReleasePolicy): void {
  const expectedCodes = WARRANTY_ADDED_SERVICES_MAPPINGS.map(mapping => mapping.itemCode).sort();
  const approvedCodes = Object.keys(p.xeroConfigurationHashes).sort();
  const allConfigurationHashesValid = expectedCodes.length === approvedCodes.length && expectedCodes.every((code, index) => code === approvedCodes[index] && /^[a-f0-9]{64}$/.test(p.xeroConfigurationHashes[code]!));
  if (process.env.FINANCIAL_WARRANTY_AUTOMATIC_ENABLED !== "true" || !p.enabled || p.releaseKey !== WARRANTY_RELEASE_KEY || p.rulesHash !== WARRANTY_RULES_HASH ||
    !p.approvedBy || !p.approvedAt || !p.effectiveFrom || !Number.isFinite(Date.parse(p.approvedAt)) || !Number.isFinite(Date.parse(p.effectiveFrom)) ||
    Date.parse(p.approvedAt) > Date.now() || Date.parse(p.effectiveFrom) > Date.now() || p.migrationScope !== "new_events_only" ||
    !p.warrantyOnlyVtigerBranch || !p.operationsMakeHandoverAcknowledged || !p.mainInvoiceCoordinationAcknowledged || !p.isolatedDraftOnlyScope ||
    !p.draftAmendmentAcknowledged || !p.enableDraftMainAmendment || !p.noCrmPostSuccessMutation || !p.sourceConfig || !allConfigurationHashesValid ||
    !p.avisoContactId || p.avisoSupplierName !== AVISO_NAME || p.avisoAccountCode !== AVISO_ACCOUNT ||
    p.sourceMappingsHash !== warrantySourceConfigHash(p.sourceConfig) || p.addedServicesMappingHash !== financialSha256(p.sourceConfig.addedServicesMappings))
    throw new Error("Warranty & Aviso automatic release disabled or missing exact approved New Events/Draft amendment/source/item/tax/handover policy.");
}
