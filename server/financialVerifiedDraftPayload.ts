import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import type { FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import {
  prepareFinancialDraftPayload,
  prepareFinancialDraftUpdatePayload,
  type FinancialDraftPayload,
} from "./financialProductionWriter";

/**
 * Binds a Draft payload to the exact ContactID and (for updates) Draft target
 * returned by the freshly approved GET-only Xero preflight. It never accepts a
 * name-only contact, missing target ID, or non-Draft target.
 */
export function prepareVerifiedFinancialDraftPayload(input: {
  document: ProposedFinancialDocument;
  workflowIdempotencyKey: string;
  preflight: FinancialXeroPreflight;
}): FinancialDraftPayload {
  const { document, preflight } = input;
  if (!preflight.contactCheck.found || !preflight.contactCheck.contactId) {
    throw new Error("Cannot prepare financial Draft payload: exact Xero ContactID preflight evidence is required.");
  }
  if (document.proposedDocumentNumber?.trim().toUpperCase() !== preflight.documentNumber?.trim().toUpperCase()) {
    throw new Error("Cannot prepare financial Draft payload: preflight document number does not match the immutable proposal.");
  }
  const contactBoundDocument: ProposedFinancialDocument = {
    ...document,
    partySourceId: preflight.contactCheck.contactId,
  };
  if (document.proposedAction === "create_draft") {
    if (preflight.duplicateState !== "not_found") throw new Error("Cannot prepare create Draft payload: current duplicate preflight is not not_found.");
    return prepareFinancialDraftPayload(contactBoundDocument, input.workflowIdempotencyKey);
  }
  if (document.proposedAction === "update_draft") {
    if (preflight.duplicateState !== "found" || !preflight.xeroDocumentId || preflight.status?.toUpperCase() !== "DRAFT") {
      throw new Error("Cannot prepare update Draft payload: current Xero preflight is not one exact DRAFT target.");
    }
    return prepareFinancialDraftUpdatePayload(contactBoundDocument, input.workflowIdempotencyKey, {
      xeroDocumentId: preflight.xeroDocumentId,
      documentNumber: preflight.documentNumber!,
      status: "DRAFT",
    });
  }
  throw new Error(`Cannot prepare financial Draft payload for action ${document.proposedAction}.`);
}
