import { randomUUID } from "node:crypto";
import {
  MAIN_CUSTOMER_INVOICE_RULES_HASH,
  MAIN_CUSTOMER_INVOICE_RULES_VERSION,
  buildMainCustomerInvoice,
  type MainCustomerInvoiceFacts,
  type MainCustomerInvoicePreview,
} from "./financialMainCustomerInvoiceDrafts";
import {
  bindMainCustomerInvoicePayload,
  claimMainCustomerInvoicePreview,
  completeMainCustomerInvoiceDraft,
  getMainCustomerInvoiceEvent,
  getMainCustomerInvoiceEvents,
  holdMainCustomerInvoiceExecution,
  recordMainCustomerInvoicePreview,
} from "./financialMainCustomerInvoiceDb";
import { assertMainCustomerInvoiceRelease, getMainCustomerInvoiceReleasePolicy } from "./financialMainCustomerInvoiceRelease";
import { preflightFinancialXeroIntents, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";

export const MAIN_CUSTOMER_INVOICE_VTIGER_MODULE = "Potentials" as const;
export const MAIN_CUSTOMER_INVOICE_WEBHOOK_PATH = "/api/webhooks/vtiger/main-customer-invoice" as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
function recordId(value: unknown): string {
  const raw = text(value); return /^\d+x\d+$/i.test(raw) ? raw : "";
}
function number(value: unknown): number | null {
  const result = Number(text(value).replace(/[$,\s]/g, "")); return Number.isFinite(result) ? result : null;
}
function timestamp(value: unknown): Date | null {
  const date = new Date(text(value)); return Number.isFinite(date.getTime()) ? date : null;
}
function latestTimestamp(...values: unknown[]): string | null {
  const dates = values.map(timestamp).filter((value): value is Date => Boolean(value));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((value) => value.getTime()))).toISOString();
}
function lineSource(quote: Record<string, unknown>): Record<string, unknown>[] {
  const raw = quote.LineItems ?? quote.lineitems ?? quote.line_items;
  if (Array.isArray(raw)) return raw.filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === "object");
  if (raw && typeof raw === "object") return Object.values(raw).filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === "object");
  return [];
}
async function exactRecord(reference: string, description: string): Promise<Record<string, unknown>> {
  if (!recordId(reference)) throw new Error(`${description} must be an exact VTiger webservice id.`);
  const result = await retrieveCurrentVtigerFinancialRecord(reference);
  if (recordId(result.id) !== reference) throw new Error(`${description} retrieve did not return the exact requested record.`);
  return result;
}
async function nameForCustomer(reference: string, kind: "organisation" | "contact"): Promise<string> {
  const source = await exactRecord(reference, kind === "organisation" ? "Customer organisation" : "Customer contact");
  const name = kind === "organisation"
    ? text(source.accountname ?? source.organizationname ?? source.name)
    : text(source.contactname ?? [text(source.firstname), text(source.lastname)].filter(Boolean).join(" ") ?? source.name);
  if (!name) throw new Error(`Current VTiger ${kind} has no usable name.`);
  return name;
}

/** Re-reads the exact Deal, linked Quote and current Service descriptions. */
export async function readMainCustomerInvoiceFacts(dealId: string): Promise<MainCustomerInvoiceFacts> {
  const deal = await exactRecord(dealId, "Deal");
  const quoteId = recordId(deal.cf_potentials_quotereference ?? deal.quote_reference ?? deal.items_sync_with);
  if (!quoteId) throw new Error("Main Customer Invoice requires an exact linked VTiger Quote id.");
  const quote = await exactRecord(quoteId, "Linked Quote");

  const organisationId = recordId(quote.account_id ?? deal.related_to ?? deal.relatedto);
  const contactId = recordId(quote.contact_id ?? deal.contact_id);
  const customerKind = organisationId ? "organisation" : "contact";
  const customerVtigerId = organisationId || contactId;
  const customerName = customerVtigerId ? await nameForCustomer(customerVtigerId, customerKind) : "";
  const services = await Promise.all(lineSource(quote).map(async (line) => {
    const serviceId = recordId(line.productid ?? line.hdnProductId);
    const service = serviceId ? await exactRecord(serviceId, "Quote Service") : null;
    return {
      serviceVtigerId: serviceId,
      description: service ? text(service.servicename ?? service.productname ?? service.service_name) : "",
      quantity: number(line.quantity ?? line.qty) ?? 0,
      unitAmount: number(line.listprice ?? line.listPrice) ?? Number.NaN,
    };
  }));
  return {
    dealId,
    dealNumber: text(deal.potential_no ?? deal.deal_no),
    quoteId,
    quoteNumber: text(quote.quote_no) || quoteId,
    customerVtigerId,
    customerName,
    customerKind,
    sourceRefreshedAt: latestTimestamp(deal.modifiedtime ?? deal.modifiedTime ?? deal.createdtime, quote.modifiedtime ?? quote.modifiedTime ?? quote.createdtime),
    serviceLines: services,
  };
}

function preflightReason(document: NonNullable<MainCustomerInvoicePreview["document"]>, preflight: FinancialXeroPreflight | null): string | null {
  if (!preflight) return "No valid Main Customer Invoice proposal is available for Xero preflight.";
  if (preflight.duplicateState !== "not_found") return `Exact Xero invoice ${document.proposedDocumentNumber} is ${preflight.duplicateState}${preflight.status ? ` (${preflight.status})` : ""}; AP will not bypass or adopt it.`;
  if (!preflight.contactCheck.found || !preflight.contactCheck.contactId) return "Xero customer contact is missing, ambiguous or not an exact match.";
  return null;
}
async function savePreview(input: { facts: MainCustomerInvoiceFacts; preview: MainCustomerInvoicePreview; sourceHash: string; preflight: FinancialXeroPreflight | null; state: "previewed" | "held"; reason: string | null }) {
  return recordMainCustomerInvoicePreview({
    dealId: input.facts.dealId,
    dealNumber: input.facts.dealNumber || input.facts.dealId,
    quoteId: input.facts.quoteId || null,
    quoteNumber: input.facts.quoteNumber || null,
    proposedInvoiceNumber: input.preview.proposedInvoiceNumber ?? `UNRESOLVED-MAIN-${input.facts.dealId}`,
    customerVtigerId: input.facts.customerVtigerId || null,
    customerName: input.facts.customerName || null,
    sourceRefreshedAt: input.facts.sourceRefreshedAt ? new Date(input.facts.sourceRefreshedAt) : null,
    sourceSnapshotHash: input.sourceHash,
    rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH,
    xeroPreflightHash: input.preflight ? financialSha256(input.preflight) : null,
    proposal: input.preview.document,
    xeroPreflight: input.preflight,
    status: input.state,
    holdReason: input.reason,
  });
}

export type MainCustomerInvoicePreviewResult = {
  facts: MainCustomerInvoiceFacts;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  preview: MainCustomerInvoicePreview;
  preflight: FinancialXeroPreflight | null;
  state: "previewed" | "held";
  holdReason: string | null;
  noWrites: true;
};

/** Administrator invoked or webhook invoked source/Xero GET-only evidence step. */
export async function previewMainCustomerInvoice(dealId: string): Promise<MainCustomerInvoicePreviewResult> {
  const facts = await readMainCustomerInvoiceFacts(dealId);
  const sourceHash = sourceSnapshotHash({ ...facts, rulesVersion: MAIN_CUSTOMER_INVOICE_RULES_VERSION });
  const preview = buildMainCustomerInvoice(facts);
  if (!preview.eligible || !preview.document) {
    const reason = preview.holdReason ?? "Main Customer Invoice source eligibility is incomplete.";
    await savePreview({ facts, preview, sourceHash, preflight: null, state: "held", reason });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, noWrites: true };
  }
  try {
    const [preflight] = await preflightFinancialXeroIntents([preview.document]);
    const reason = preflightReason(preview.document, preflight ?? null);
    if (!preflight || reason) {
      const hold = reason ?? "Xero GET-only preflight was not completed.";
      await savePreview({ facts, preview, sourceHash, preflight: preflight ?? null, state: "held", reason: hold });
      return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: preflight ? financialSha256(preflight) : null, preview, preflight: preflight ?? null, state: "held", holdReason: hold, noWrites: true };
    }
    preview.document.partySourceId = preflight.contactCheck.contactId!;
    await savePreview({ facts, preview, sourceHash, preflight, state: "previewed", reason: null });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: financialSha256(preflight), preview, preflight, state: "previewed", holdReason: null, noWrites: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Xero GET-only preflight could not be completed.";
    await savePreview({ facts, preview, sourceHash, preflight: null, state: "held", reason });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, noWrites: true };
  }
}

/** Called only by the dedicated Main Customer Invoice route after its own release is armed. */
export async function processAutomaticMainCustomerInvoice(dealId: string) {
  const policy = await getMainCustomerInvoiceReleasePolicy();
  assertMainCustomerInvoiceRelease(policy);
  const preview = await previewMainCustomerInvoice(dealId);
  if (preview.state !== "previewed" || !preview.preview.document) return { ok: false, status: "held" as const, recordId: dealId, warning: preview.holdReason ?? "Main Customer Invoice source/Xero preflight is not ready.", xeroWritesAttempted: 0 };
  const event = await getMainCustomerInvoiceEvent(dealId);
  if (!event) throw new Error("Main Customer Invoice current preflight was not recorded in the AP ledger.");
  const effectiveFrom = Date.parse(policy.effectiveFrom!);
  const sourceRefreshedAt = preview.facts.sourceRefreshedAt ? Date.parse(preview.facts.sourceRefreshedAt) : Number.NaN;
  if (!Number.isFinite(sourceRefreshedAt) || sourceRefreshedAt < effectiveFrom) {
    const reason = "Main Customer Invoice source predates the approved new-events-only cutover; it is held for reconciliation.";
    await holdMainCustomerInvoiceExecution(event.id, reason);
    return { ok: false, status: "held" as const, recordId: dealId, eventId: event.id, warning: reason, xeroWritesAttempted: 0 };
  }
  if (event.status === "drafts_created") return { ok: true, status: "duplicate_replay" as const, recordId: dealId, eventId: event.id, invoiceNumber: event.proposedInvoiceNumber, xeroWritesAttempted: 0 };
  if (event.status === "reconciliation_required") return { ok: false, status: "reconciliation_required" as const, recordId: dealId, eventId: event.id, warning: event.holdReason ?? "Main Customer Invoice is awaiting reconciliation.", xeroWritesAttempted: 0 };
  const token = randomUUID();
  if (!(await claimMainCustomerInvoicePreview(event.id, token))) return { ok: false, status: "held" as const, recordId: dealId, eventId: event.id, warning: "Main Customer Invoice is already processing or was not freshly preflighted.", xeroWritesAttempted: 0 };
  try {
    const payload = prepareFinancialDraftPayload(preview.preview.document, `${dealId}:main_customer_invoice:${preview.sourceSnapshotHash}`);
    const row = (payload.body.Invoices as Record<string, unknown>[] | undefined)?.[0];
    if (!row) throw new Error("Main Customer Invoice transport payload is missing its customer invoice.");
    row.CurrencyCode = "AUD";
    await bindMainCustomerInvoicePayload(event.id, policy.releaseKey, payload);
    const outcome = await executeGuardedFinancialWriterCommand({
      workflowType: "main_customer_invoice", proposedAction: "create_draft", payload, expectedDraftDocument: preview.preview.document,
      preparedBy: policy.approvedBy!, sourceRecordId: dealId, verifiedSourceData: { dealId, sourceSnapshotHash: preview.sourceSnapshotHash },
      authorisation: { workflowType: "main_customer_invoice", approvalReference: policy.releaseKey, globalShadowMode: false, familyLiveEnabled: true,
        releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true,
        mainCustomerInvoiceAutomaticEventId: event.id, mainCustomerInvoiceReleaseKey: policy.releaseKey, mainCustomerInvoiceApprovedBy: policy.approvedBy! },
    });
    if (outcome.outcome === "reconciliation_required" || outcome.outcome === "duplicate") {
      await holdMainCustomerInvoiceExecution(event.id, "Main Customer Invoice Xero execution requires exact reconciliation before any retry.", true);
      return { ok: false, status: "reconciliation_required" as const, recordId: dealId, eventId: event.id, warning: "Main Customer Invoice Xero result is awaiting reconciliation; no blind retry will occur.", xeroWritesAttempted: outcome.outcome === "reconciliation_required" ? 1 : 0 };
    }
    await completeMainCustomerInvoiceDraft({ eventId: event.id, executionId: outcome.executionId, xeroInvoiceId: outcome.result.xeroDocumentId });
    return { ok: true, status: "drafts_created" as const, recordId: dealId, eventId: event.id, invoiceNumber: outcome.result.documentNumber, xeroInvoiceId: outcome.result.xeroDocumentId, xeroWritesAttempted: 1 };
  } catch (error) {
    await holdMainCustomerInvoiceExecution(event.id, error instanceof Error ? error.message : "Main Customer Invoice execution failed.");
    throw error;
  }
}

export async function getMainCustomerInvoiceReadiness() {
  const policy = await getMainCustomerInvoiceReleasePolicy();
  return { module: MAIN_CUSTOMER_INVOICE_VTIGER_MODULE, webhookPath: MAIN_CUSTOMER_INVOICE_WEBHOOK_PATH, routeRegistered: true,
    webhookAuthenticationConfigured: Boolean(process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim()),
    writerEnabled: process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED === "true" && policy.enabled,
    policy: { enabled: policy.enabled, effectiveFrom: policy.effectiveFrom, mainInvoiceOnlyVtigerBranch: policy.mainInvoiceOnlyVtigerBranch, operationsMainInvoiceHandoff: policy.operationsMainInvoiceHandoff, migrationScope: policy.migrationScope }, noWrites: true as const };
}

export { getMainCustomerInvoiceEvents };
