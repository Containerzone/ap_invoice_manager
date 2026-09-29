import { TRPCError } from "@trpc/server";
import { getFinancialWorkflowConfig, getFinancialDocumentIntentDetail, createFinancialExecutionApproval } from "./financialWorkflowDb";
import { FINANCIAL_AUTOMATION_RULE_CONFIG_KEY, FINANCIAL_VTIGER_SOURCE_MAPPING_CONFIG_KEY, resolveFinancialAutomationRules } from "./financialAutomationRules";
import { evaluateFinancialWorkflow, type FinancialWorkflowType, type ProposedFinancialDocument } from "./financialWorkflowEngine";
import { mapVtigerFinancialSource } from "./financialShadowValidation";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { preflightFinancialXeroIntents, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import {
  materialProposalDifferences,
  proposalHash,
  rulesSnapshotHash,
  sourceSnapshotHash,
  xeroPreflightHash,
} from "./financialProposalIntegrity";

const APPROVAL_EXPIRY_MS = 20 * 60_000;

export type FinancialApprovalPreview = {
  intentId: number;
  workflowRunId: number;
  workflowType: string;
  proposedDocumentNumber: string;
  documentFamily: "purchase_order" | "customer_invoice";
  proposedAction: "create_draft" | "update_draft";
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  proposalHash: string;
  xeroPreflightHash: string;
  preflight: FinancialXeroPreflight;
  approvalEligible: boolean;
  blockers: string[];
};

function blocker(message: string): never {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message });
}

function eligiblePreflight(document: ProposedFinancialDocument, preflight: FinancialXeroPreflight): string[] {
  const blockers: string[] = [];
  if (document.gstTreatment === "PENDING_CONFIGURATION") blockers.push("GST treatment is pending configuration.");
  if (!document.partyName?.trim() && !document.partySourceId?.trim()) blockers.push("No Xero contact is identified for the proposal.");
  if (preflight.contactCheck.found !== true || !preflight.contactCheck.contactId) blockers.push("Xero contact matching is not exact, unique and ID-resolved; contact creation remains a separate held action.");
  if (preflight.itemChecks.some((item) => !item.found)) blockers.push("One or more required Xero item codes is missing.");
  if (document.proposedAction === "create_draft" && preflight.duplicateState !== "not_found") blockers.push("The current Xero duplicate check did not prove that this new Draft reference is unused.");
  if (document.proposedAction === "update_draft" && (preflight.duplicateState !== "found" || preflight.status?.toUpperCase() !== "DRAFT" || !preflight.xeroDocumentId)) {
    blockers.push("The current Xero target is not one exact existing Draft document.");
  }
  if (preflight.duplicateState === "blocked" || preflight.duplicateState === "error") blockers.push("The current Xero preflight could not be completed.");
  return blockers;
}

async function refreshExactProposal(intentId: number): Promise<FinancialApprovalPreview> {
  const detail = await getFinancialDocumentIntentDetail(intentId);
  if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Financial proposal intent was not found." });
  const { intent, run } = detail;
  if (!run.sourceRecordId || !/^\d+x\d+$/i.test(run.sourceRecordId)) blocker("A live approval requires an exact VTiger source-record ID from a current read.");
  if (!intent.proposedDocumentNumber || !intent.proposalHash || !intent.sourceSnapshotHash || !intent.rulesSnapshotHash || !intent.xeroPreflightHash) {
    blocker("This proposal predates immutable approval evidence. Refresh it from the current VTiger source and create a new proposal.");
  }
  if (!["create_draft", "update_draft"].includes(intent.proposedAction)) blocker("Only an exact create-Draft or update-Draft proposal can be approved.");
  if (!["valid", "warning"].includes(intent.validationStatus)) blocker("This proposal is held or invalid and cannot be approved.");

  const [rawSource, config] = await Promise.all([retrieveCurrentVtigerFinancialRecord(run.sourceRecordId), getFinancialWorkflowConfig()]);
  const mapping = config.find((entry) => entry.configKey === FINANCIAL_VTIGER_SOURCE_MAPPING_CONFIG_KEY)?.configValue;
  const rules = resolveFinancialAutomationRules(config.find((entry) => entry.configKey === FINANCIAL_AUTOMATION_RULE_CONFIG_KEY)?.configValue);
  const mapped = mapVtigerFinancialSource(rawSource, mapping as Record<string, unknown> | undefined, run.workflowType as FinancialWorkflowType);
  const currentSourceData = {
    ...mapped.sourceData,
    _shadowRawSource: rawSource,
    _shadowAppliedMappings: mapped.appliedMappings,
  };
  const evaluation = evaluateFinancialWorkflow({
    workflowType: run.workflowType as FinancialWorkflowType,
    triggerType: "re_evaluation",
    sourceRecordId: run.sourceRecordId,
    sourceRecordNumber: run.sourceRecordNumber ?? undefined,
    sourceRecordType: run.sourceRecordType ?? undefined,
    sourceData: currentSourceData,
    rules,
  });
  const candidates = evaluation.intents.filter((candidate) =>
    candidate.documentType === intent.documentType
    && candidate.proposedDocumentNumber?.toUpperCase() === intent.proposedDocumentNumber!.toUpperCase()
    && candidate.proposedAction === intent.proposedAction,
  );
  if (candidates.length !== 1) blocker("The current VTiger source no longer produces exactly one matching proposed document. A new review is required.");
  const currentDocument = candidates[0]!;
  const preflight = (await preflightFinancialXeroIntents([currentDocument]))[0];
  if (!preflight) blocker("The current Xero preflight did not return evidence for the proposal.");
  const currentSourceHash = sourceSnapshotHash(currentSourceData);
  const currentRulesHash = rulesSnapshotHash(rules);
  const currentProposalHash = proposalHash(currentDocument);
  const currentPreflightHash = xeroPreflightHash(preflight);
  const changed = materialProposalDifferences({
    sourceHash: currentSourceHash,
    rulesHash: currentRulesHash,
    proposalHashValue: currentProposalHash,
    preflightHash: currentPreflightHash,
    approval: {
      sourceSnapshotHash: intent.sourceSnapshotHash,
      rulesSnapshotHash: intent.rulesSnapshotHash,
      proposalHash: intent.proposalHash,
      xeroPreflightHash: intent.xeroPreflightHash,
    },
  });
  const blockers = [
    ...changed.map((value) => `Approval invalidated because ${value} changed.`),
    ...eligiblePreflight(currentDocument, preflight),
  ];
  return {
    intentId,
    workflowRunId: run.id,
    workflowType: run.workflowType,
    proposedDocumentNumber: currentDocument.proposedDocumentNumber!,
    documentFamily: currentDocument.documentFamily,
    proposedAction: currentDocument.proposedAction as "create_draft" | "update_draft",
    sourceSnapshotHash: currentSourceHash,
    rulesSnapshotHash: currentRulesHash,
    proposalHash: currentProposalHash,
    xeroPreflightHash: currentPreflightHash,
    preflight,
    approvalEligible: blockers.length === 0,
    blockers,
  };
}

/** Shows the exact freshly sourced document state to an administrator without writing. */
export async function previewFinancialExecutionApproval(intentId: number): Promise<FinancialApprovalPreview> {
  return refreshExactProposal(intentId);
}

/**
 * Stores a time-bounded, single-use approval only when a fresh source refresh,
 * exact proposal re-evaluation and GET-only Xero preflight are all unchanged.
 */
export async function approveFinancialExecution(input: {
  intentId: number;
  releaseManifestId?: number | null;
  releaseFamilyId?: number | null;
  cutoverPackId?: number | null;
  approvalReference: string;
  acknowledgement: string;
  actorId: number;
}) {
  const preview = await refreshExactProposal(input.intentId);
  if (!preview.approvalEligible) blocker(`This financial proposal cannot be approved. ${preview.blockers.join(" ")}`);
  const detail = await getFinancialDocumentIntentDetail(input.intentId);
  if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Financial proposal intent was not found." });
  const approval = await createFinancialExecutionApproval({
    workflowRunId: preview.workflowRunId,
    documentIntentId: input.intentId,
    releaseManifestId: input.releaseManifestId ?? null,
    releaseFamilyId: input.releaseFamilyId ?? null,
    cutoverPackId: input.cutoverPackId ?? null,
    workflowType: preview.workflowType,
    documentFamily: preview.documentFamily,
    proposedAction: preview.proposedAction,
    proposalHash: preview.proposalHash,
    sourceSnapshotHash: preview.sourceSnapshotHash,
    rulesSnapshotHash: preview.rulesSnapshotHash,
    xeroPreflightHash: preview.xeroPreflightHash,
    sourceRecordId: detail.run.sourceRecordId,
    sourceRecordNumber: detail.run.sourceRecordNumber,
    proposedDocumentNumber: preview.proposedDocumentNumber,
    counterpartyName: detail.intent.partyName,
    approvalReference: input.approvalReference,
    acknowledgement: input.acknowledgement,
    approvalSummary: {
      proposalHash: preview.proposalHash,
      sourceSnapshotHash: preview.sourceSnapshotHash,
      rulesSnapshotHash: preview.rulesSnapshotHash,
      xeroPreflight: preview.preflight,
      executionRequiresFreshSourceAndPreflight: true,
      writerRouteRegistered: false,
    },
    approvedBy: input.actorId,
    expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_MS),
  });
  return { approval, preview, xeroWritePermitted: false as const, mode: "approved_but_unroutable" as const };
}
