import { createHash } from "node:crypto";
import {
  findCurrentFinancialCandidates,
  type CurrentFinancialCandidateLookup,
  type CurrentFinancialCandidateQuery,
  type FinancialCandidateCategory,
} from "./vtigerFinancialCandidateService";
import { resolveFinancialAutomationRules, type FinancialAutomationRules } from "./financialAutomationRules";
import { mapVtigerFinancialSource, sourceRecordNumberFromVtiger } from "./financialShadowValidation";
import { evaluateFinancialWorkflow, type FinancialWorkflowType, type ProposedFinancialDocument } from "./financialWorkflowEngine";
import { preflightFinancialXeroIntents, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import { financialSha256, rulesSnapshotHash, sourceSnapshotHash } from "./financialProposalIntegrity";

export const FINANCIAL_CURRENT_CANDIDATE_DISCOVERY_CONFIG_KEY = "financial-automation.current-candidate-discovery" as const;

export type FinancialReleaseFamilyKey =
  | "initial_container_control_asset"
  | "initial_container_control_customer_sale"
  | "initial_container_control_for_hire"
  | "recurring_for_hire"
  | "origin_storage_activation"
  | "destination_storage_activation"
  | "recurring_storage"
  | "storage_finalisation_recovery"
  | "main_customer_invoice"
  | "deposit_invoice"
  | "final_weight_overweight"
  | "final_weight_underweight"
  | "extra_hire"
  | "warranty_customer_invoice_and_aviso_po";

export type FamilyCandidateProfile = {
  familyKey: FinancialReleaseFamilyKey;
  displayName: string;
  workflowType: FinancialWorkflowType;
  branch: string;
  sourceCategory: FinancialCandidateCategory | "storage_billing_event";
  criteria: string[];
  holdReasons: string[];
};

/**
 * The profiles are a documented deterministic boundary. Field aliases and
 * positive query predicates remain AP-side configuration because inventing
 * unverified custom VTiger field names would turn a readiness result into an
 * unsupported claim about the source system.
 */
export const FINANCIAL_FAMILY_CANDIDATE_PROFILES: readonly FamilyCandidateProfile[] = [
  { familyKey: "initial_container_control_asset", displayName: "Initial CC — Asset", workflowType: "container_control_acquisition", branch: "Initial Container Control — Asset", sourceCategory: "container_control", criteria: ["REQUEST Container Control", "Acquisition Asset/ASSETT", "positive resolved cost", "supplier/contact mapping", "A<CC> preflight clear"], holdReasons: ["supplier or cost missing", "existing conflicting or non-Draft PO", "notes/HTML description input"] },
  { familyKey: "initial_container_control_customer_sale", displayName: "Initial CC — Customer Sale", workflowType: "container_control_acquisition", branch: "Initial Container Control — Customer Sale", sourceCategory: "container_control", criteria: ["REQUEST Container Control", "Acquisition Customer Sale", "positive resolved cost", "supplier/contact mapping", "S<CC> preflight clear"], holdReasons: ["supplier or cost missing", "existing conflicting or non-Draft PO", "notes/HTML description input"] },
  { familyKey: "initial_container_control_for_hire", displayName: "Initial CC — For Hire", workflowType: "container_control_acquisition", branch: "Initial Container Control — For Hire", sourceCategory: "container_control", criteria: ["REQUEST Container Control", "Acquisition FOR HIRE", "20/40 foot type", "Collection Date", "supplier and monthly cost/default"], holdReasons: ["collection date/type/supplier missing", "HC 20/HC 40 preflight unavailable"] },
  { familyKey: "recurring_for_hire", displayName: "Recurring For Hire", workflowType: "recurring_for_hire", branch: "Recurring For Hire", sourceCategory: "container_control", criteria: ["FOR HIRE", "ON HIRE or IDLE only", "20/40 foot type", "supplier", "next consecutive 30-day period due", "HC 20 E / HC 40 E purchase price"], holdReasons: ["REQUEST/READY/DEHIRED or unsupported acquisition", "gap/catch-up/ambiguous earlier period", "matching or non-Draft PO conflict"] },
  { familyKey: "origin_storage_activation", displayName: "Origin Storage Activation", workflowType: "storage_activation", branch: "Origin Storage Activation", sourceCategory: "deal", criteria: ["current origin-storage data", "Date In", "container 20/40 foot", "customer", "driver and storage supplier"], holdReasons: ["JD/GD/customer mapping missing", "existing incompatible document"] },
  { familyKey: "destination_storage_activation", displayName: "Destination Storage Activation", workflowType: "storage_activation", branch: "Destination Storage Activation", sourceCategory: "deal", criteria: ["current destination-storage data", "Date In", "container 20/40 foot", "customer", "driver and storage supplier"], holdReasons: ["JD/GD/customer mapping missing", "existing incompatible document"] },
  { familyKey: "recurring_storage", displayName: "Recurring Storage", workflowType: "recurring_storage", branch: "Recurring Storage", sourceCategory: "storage_billing_event", criteria: ["verified active AP storage event", "specific next billing period", "current customer/storage supplier", "GD-only preflight"], holdReasons: ["no verified active AP event", "finalised event or collision", "no current GD preflight"] },
  { familyKey: "storage_finalisation_recovery", displayName: "Storage Finalisation / Recovery", workflowType: "storage_finalisation", branch: "Storage Finalisation / Recovery", sourceCategory: "storage_billing_event", criteria: ["verified AP storage event", "Date Out/FCD final date", "matching Draft documents or defined zero-document recovery"], holdReasons: ["non-Draft document", "ambiguous final date/period", "incomplete recovery inputs"] },
  { familyKey: "main_customer_invoice", displayName: "Main Customer Invoice", workflowType: "main_customer_invoice", branch: "Main Customer Invoice", sourceCategory: "deal", criteria: ["current Deal", "valid Quote reference/source lines", "customer", "exact INV preflight"], holdReasons: ["quote/service/contact unresolved", "exact invoice collision"] },
  { familyKey: "deposit_invoice", displayName: "Deposit Invoice", workflowType: "deposit_invoice", branch: "Deposit Invoice", sourceCategory: "deal", criteria: ["Deposit Status blank/Pending", "positive Deposit Required", "valid contact", "exact -D preflight"], holdReasons: ["invalid deposit amount/source data", "existing conflict"] },
  { familyKey: "final_weight_overweight", displayName: "Final Weight — Overweight", workflowType: "final_weight_adjustment", branch: "Final Weight — Overweight", sourceCategory: "deal", criteria: ["existing Draft INV", "Actual > Estimated", "positive per-extra-tonne"], holdReasons: ["invoice not Draft", "weights/rate invalid"] },
  { familyKey: "final_weight_underweight", displayName: "Final Weight — Underweight", workflowType: "final_weight_adjustment", branch: "Final Weight — Underweight", sourceCategory: "deal", criteria: ["existing Draft INV", "Actual < Estimated", "Full Container Pickup/due-date fallback"], holdReasons: ["invoice not Draft", "source missing"] },
  { familyKey: "extra_hire", displayName: "Extra Hire", workflowType: "extra_hire", branch: "Extra Hire", sourceCategory: "deal", criteria: ["Hire Duration 30", "prior Hire End Date", "container/type", "next suffix clear"], holdReasons: ["date/type/container missing", "suffix conflict", "prior post-success update pending"] },
  { familyKey: "warranty_customer_invoice_and_aviso_po", displayName: "Warranty/Aviso", workflowType: "warranty_reconciliation", branch: "Warranty Customer Invoice and Aviso PO", sourceCategory: "deal", criteria: ["one supported Added Services warranty", "correct main invoice state", "native WAR and Aviso PO preflight"], holdReasons: ["multiple/unmapped warranty", "$150k/$200k/$250k", "non-Draft warranty PO", "missing main invoice"] },
] as const;

export type CurrentCandidateDiscoveryConfig = Partial<Record<FinancialReleaseFamilyKey, {
  sourceCategory?: FinancialCandidateCategory;
  queries?: CurrentFinancialCandidateQuery[];
}>>;

export type CurrentFamilyCandidate = {
  recordId: string;
  sourceCategory: FinancialCandidateCategory;
  businessNumber: string;
  stageOrStatus: string | null;
  sourceRefreshedAt: Date | null;
  eligibilityReasons: string[];
  expectedDocumentNumbers: string[];
  proposalSummary: Array<{ documentNumber: string | null; documentFamily: string; accountCode: string | null; total: number; validationStatus: string }>;
  collisionState: string;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  xeroPreflight: FinancialXeroPreflight[];
  sourceData: Record<string, unknown>;
};

export type CurrentFamilyCandidateDiscovery = {
  family: FamilyCandidateProfile;
  outcome: "found" | "no_current_candidate" | "blocked";
  searchedAt: Date;
  candidates: CurrentFamilyCandidate[];
  message: string;
  sourceSnapshotHash: string | null;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
};

function configuredQueries(
  familyKey: FinancialReleaseFamilyKey,
  profile: FamilyCandidateProfile,
  value: unknown,
): CurrentFinancialCandidateQuery[] {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value as CurrentCandidateDiscoveryConfig : {};
  const entry = config[familyKey];
  if (!entry || entry.sourceCategory !== profile.sourceCategory || !Array.isArray(entry.queries)) return [];
  return entry.queries;
}

function stageOrStatus(source: Record<string, unknown>): string | null {
  for (const key of ["sales_stage", "stage", "status", "containerControlStatus", "container_status", "storageStage", "storage_stage"]) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function candidateDocuments(
  workflowType: FinancialWorkflowType,
  source: Record<string, unknown>,
  recordNumber: string,
  rules: FinancialAutomationRules,
): ProposedFinancialDocument[] {
  const evaluation = evaluateFinancialWorkflow({
    workflowType,
    triggerType: "re_evaluation",
    sourceRecordId: String(source.id ?? "candidate"),
    sourceRecordNumber: recordNumber,
    sourceData: source,
    rules,
    idempotencySalt: `candidate-discovery:${recordNumber}`,
  });
  return evaluation.intents;
}

function collisionState(preflight: FinancialXeroPreflight[]): string {
  if (preflight.length === 0) return "not_checked";
  if (preflight.some((entry) => entry.duplicateState === "found" && String(entry.status ?? "").toUpperCase() !== "DRAFT")) return "non_draft_conflict";
  if (preflight.some((entry) => ["found", "ambiguous"].includes(entry.duplicateState))) return "collision_or_review";
  if (preflight.some((entry) => ["blocked", "error"].includes(entry.duplicateState))) return "preflight_blocked";
  return "clear_or_not_found";
}

/**
 * Executes one family’s bounded discovery. Storage families are deliberately
 * not sourced from VTiger: their discovery returns NO_CURRENT_CANDIDATE until a
 * verified AP activation/finalisation event exists in the local storage ledger.
 */
export async function discoverCurrentFamilyCandidates(input: {
  familyKey: FinancialReleaseFamilyKey;
  discoveryConfig?: unknown;
  sourceMapping?: Record<string, unknown>;
  rules?: FinancialAutomationRules;
}): Promise<CurrentFamilyCandidateDiscovery> {
  const family = FINANCIAL_FAMILY_CANDIDATE_PROFILES.find((entry) => entry.familyKey === input.familyKey);
  if (!family) throw new Error("Unknown financial release family.");
  const rules = input.rules ?? resolveFinancialAutomationRules();
  const searchedAt = new Date();
  const ruleHash = rulesSnapshotHash(rules);
  if (family.sourceCategory === "storage_billing_event") {
    return {
      family, outcome: "no_current_candidate", searchedAt, candidates: [],
      message: "NO_CURRENT_CANDIDATE: this family is sourced only from verified AP storage activation/finalisation execution state. No VTiger history was scanned.",
      sourceSnapshotHash: null, rulesSnapshotHash: ruleHash, xeroPreflightHash: null,
    };
  }
  const lookup: CurrentFinancialCandidateLookup = await findCurrentFinancialCandidates({
    sourceCategory: family.sourceCategory,
    queries: configuredQueries(family.familyKey, family, input.discoveryConfig),
  });
  if (lookup.outcome !== "found") {
    return {
      family, outcome: lookup.outcome, searchedAt, candidates: [], message: lookup.message,
      sourceSnapshotHash: null, rulesSnapshotHash: ruleHash, xeroPreflightHash: null,
    };
  }
  const candidates: CurrentFamilyCandidate[] = [];
  for (const candidate of lookup.candidates.slice(0, 10)) {
    const mapped = mapVtigerFinancialSource(candidate.summary, input.sourceMapping, family.workflowType);
    const sourceData = { ...mapped.sourceData, _candidateDiscovery: { familyKey: family.familyKey, reviewOnly: true } };
    const recordNumber = sourceRecordNumberFromVtiger(sourceData) ?? candidate.businessNumber;
    const intents = candidateDocuments(family.workflowType, sourceData, recordNumber, rules);
    let xeroPreflight: FinancialXeroPreflight[] = [];
    try {
      // At most ten current candidates and each evaluator has a bounded document
      // count; this remains far below the financial preflight cap.
      xeroPreflight = await preflightFinancialXeroIntents(intents);
    } catch (error) {
      xeroPreflight = intents.map((intent) => ({
        documentNumber: intent.proposedDocumentNumber,
        documentFamily: intent.documentFamily,
        duplicateState: "blocked" as const,
        xeroDocumentId: null,
        status: null,
        partyName: null,
        itemChecks: [],
        contactCheck: { partyName: intent.partyName, found: null, count: null, contactId: null },
        error: error instanceof Error ? error.message : "Xero GET-only preflight was not completed.",
      }));
    }
    const preflightHash = xeroPreflight.length > 0 ? financialSha256(xeroPreflight) : null;
    candidates.push({
      recordId: candidate.recordId,
      sourceCategory: candidate.sourceCategory,
      businessNumber: recordNumber,
      stageOrStatus: stageOrStatus(sourceData),
      sourceRefreshedAt: candidate.sourceRefreshedAt,
      eligibilityReasons: candidate.eligibilityReasons,
      expectedDocumentNumbers: intents.map((intent) => intent.proposedDocumentNumber).filter((value): value is string => Boolean(value)),
      proposalSummary: intents.map((intent) => ({ documentNumber: intent.proposedDocumentNumber, documentFamily: intent.documentFamily, accountCode: intent.accountCode, total: intent.total, validationStatus: intent.validationStatus })),
      collisionState: collisionState(xeroPreflight),
      sourceSnapshotHash: sourceSnapshotHash(sourceData),
      rulesSnapshotHash: ruleHash,
      xeroPreflightHash: preflightHash,
      xeroPreflight,
      sourceData,
    });
  }
  const combinedHash = candidates.length > 0 ? createHash("sha256").update(JSON.stringify(candidates.map((candidate) => candidate.sourceSnapshotHash))).digest("hex") : null;
  const combinedPreflightHash = candidates.length > 0 ? financialSha256(candidates.map((candidate) => candidate.xeroPreflightHash)) : null;
  return { family, outcome: "found", searchedAt, candidates, message: lookup.message, sourceSnapshotHash: combinedHash, rulesSnapshotHash: ruleHash, xeroPreflightHash: combinedPreflightHash };
}
