import { createHash } from "node:crypto";
import type { FinancialAutomationRules } from "./financialAutomationRules";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import type { FinancialXeroPreflight } from "./financialReadOnlyXeroService";

export const FINANCIAL_PROPOSAL_VERSION = "2026-09-29" as const;

/** Stable object serialisation for audit and approval hashes. */
export function stableFinancialJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableFinancialJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableFinancialJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function financialSha256(value: unknown): string {
  return createHash("sha256").update(stableFinancialJson(value)).digest("hex");
}

export function sourceSnapshotHash(sourceData: Record<string, unknown>): string {
  return financialSha256({ sourceData, proposalVersion: FINANCIAL_PROPOSAL_VERSION });
}

export function rulesSnapshotHash(rules: FinancialAutomationRules): string {
  return financialSha256({ rules, proposalVersion: FINANCIAL_PROPOSAL_VERSION });
}

export function proposalHash(document: ProposedFinancialDocument): string {
  return financialSha256({
    proposalVersion: FINANCIAL_PROPOSAL_VERSION,
    documentFamily: document.documentFamily,
    documentType: document.documentType,
    proposedAction: document.proposedAction,
    proposedDocumentNumber: document.proposedDocumentNumber,
    reference: document.reference,
    partyName: document.partyName,
    partySourceId: document.partySourceId,
    accountCode: document.accountCode,
    gstTreatment: document.gstTreatment,
    currency: document.currency,
    subtotal: document.subtotal,
    taxAmount: document.taxAmount,
    total: document.total,
    issueDate: document.issueDate?.toISOString() ?? null,
    dueDate: document.dueDate?.toISOString() ?? null,
    lineItems: document.lineItems,
    sourceWorkflow: document.sourceWorkflow,
    sourceRecordId: document.sourceRecordId,
  });
}

/** Includes exact Xero ID/status/contact/items evidence used before a Draft action. */
export function xeroPreflightHash(preflight: FinancialXeroPreflight): string {
  return financialSha256({
    documentNumber: preflight.documentNumber,
    documentFamily: preflight.documentFamily,
    duplicateState: preflight.duplicateState,
    xeroDocumentId: preflight.xeroDocumentId,
    status: preflight.status,
    partyName: preflight.partyName,
    itemChecks: preflight.itemChecks,
    contactCheck: preflight.contactCheck,
    error: preflight.error,
  });
}

export function materialProposalDifferences(input: {
  sourceHash: string;
  rulesHash: string;
  proposalHashValue: string;
  preflightHash: string;
  approval: { sourceSnapshotHash: string; rulesSnapshotHash: string; proposalHash: string; xeroPreflightHash: string };
}): string[] {
  const changed: string[] = [];
  if (input.approval.sourceSnapshotHash !== input.sourceHash) changed.push("the current VTiger source snapshot");
  if (input.approval.rulesSnapshotHash !== input.rulesHash) changed.push("the effective AP automation rules");
  if (input.approval.proposalHash !== input.proposalHashValue) changed.push("the proposed Xero Draft payload");
  if (input.approval.xeroPreflightHash !== input.preflightHash) changed.push("the exact Xero duplicate/contact/item/Draft preflight");
  return changed;
}
