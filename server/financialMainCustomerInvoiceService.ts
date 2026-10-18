import { randomUUID } from "node:crypto";
import {
  MAIN_CUSTOMER_INVOICE_RULES_HASH,
  MAIN_CUSTOMER_INVOICE_RULES_VERSION,
  applyMainCustomerInvoiceXeroTransportDescription,
  buildMainCustomerInvoice,
  mainCustomerInvoiceBusinessDate,
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
import { describeVtigerFinancialModuleFields, retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { readCurrentCustomerContactSource } from "./financialCustomerContactSource";
import { resolveOrCreateAutomaticCustomerContact } from "./financialCustomerContactService";
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";
import { executeCustomerContactCreationV2, previewCustomerContactResolution, type CustomerContactPlan } from "./financialCustomerContactServiceV2";
import { processAutomaticDepositMainDeduction } from "./financialDepositMainDeductionService";

export const MAIN_CUSTOMER_INVOICE_VTIGER_MODULE = "Potentials" as const;
export const MAIN_CUSTOMER_INVOICE_WEBHOOK_PATH = "/api/webhooks/vtiger/main-customer-invoice" as const;
export const MAIN_CUSTOMER_INVOICE_SOURCE_FIELDS = {
  fullContainerPickupDate: {
    label: "Full Container Pickup DATE",
    apiName: "cf_potentials_fullcontainercollectiondate",
    type: "date",
  },
  depositStatus: {
    label: "Deposit Status",
    apiName: "cf_potentials_depositstatus",
    type: "picklist",
  },
} as const;

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

type MainCustomerInvoiceMetadata = Awaited<ReturnType<typeof describeVtigerFinancialModuleFields>>;
type MainCustomerInvoiceSourceFieldKey = keyof typeof MAIN_CUSTOMER_INVOICE_SOURCE_FIELDS;

/**
 * Confirms the actual Potentials API field names from current metadata instead
 * of using a historical alias. Exact labels, names and types are all required
 * because both source values control the dates of a financial document.
 */
export function resolveMainCustomerInvoiceSourceMappings(metadata: MainCustomerInvoiceMetadata): {
  mappingEvidence: Record<string, string>;
  holdReason: string | null;
} {
  const mappingEvidence: Record<string, string> = {};
  const holds: string[] = [];
  if (metadata.name !== MAIN_CUSTOMER_INVOICE_VTIGER_MODULE) {
    holds.push("Current metadata does not describe Potentials exactly.");
  }
  for (const key of Object.keys(MAIN_CUSTOMER_INVOICE_SOURCE_FIELDS) as MainCustomerInvoiceSourceFieldKey[]) {
    const expected = MAIN_CUSTOMER_INVOICE_SOURCE_FIELDS[key];
    const fields = metadata.fields.filter((field) => field.label === expected.label);
    if (fields.length !== 1) {
      holds.push(`Deal field mapping for ${expected.label} is missing or ambiguous; no alias will be guessed.`);
      continue;
    }
    const field = fields[0]!;
    if (field.name !== expected.apiName || metadata.fields.filter((candidate) => candidate.name === field.name).length !== 1) {
      holds.push(`Deal field mapping for ${expected.label} does not confirm its approved VTiger API field.`);
      continue;
    }
    mappingEvidence[key] = field.name;
    if (field.type.name !== expected.type) {
      holds.push(`Deal field mapping for ${expected.label} has an unverified field type.`);
    }
  }
  return { mappingEvidence, holdReason: holds.length ? holds.join(" ") : null };
}

function mappedScalar(
  deal: Record<string, unknown>,
  mappingEvidence: Record<string, string>,
  key: MainCustomerInvoiceSourceFieldKey,
  holds: string[],
  allowBlank = false,
): string {
  const expected = MAIN_CUSTOMER_INVOICE_SOURCE_FIELDS[key];
  const name = mappingEvidence[key];
  if (!name) return "";
  const value = deal[name];
  if (!Object.prototype.hasOwnProperty.call(deal, name) || typeof value !== "string") {
    holds.push(`Current Deal retrieve does not supply a scalar ${expected.label} field.`);
    return "";
  }
  const scalar = text(value);
  if (!scalar && !allowBlank) {
    holds.push(`Current Deal retrieve does not supply a populated scalar ${expected.label} field.`);
  }
  return scalar;
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
  const mapping = resolveMainCustomerInvoiceSourceMappings(
    await describeVtigerFinancialModuleFields(MAIN_CUSTOMER_INVOICE_VTIGER_MODULE),
  );
  const sourceHolds = mapping.holdReason ? [mapping.holdReason] : [];
  const fullContainerPickupDate = mappedScalar(deal, mapping.mappingEvidence, "fullContainerPickupDate", sourceHolds);
  // A blank Deposit Status is the normal/default two-day case. Its current
  // metadata-backed scalar is still required so a missing/wrong-type source
  // cannot silently be treated as blank.
  const depositStatus = mappedScalar(deal, mapping.mappingEvidence, "depositStatus", sourceHolds, true);
  if (!mainCustomerInvoiceBusinessDate(fullContainerPickupDate)) {
    sourceHolds.push("Current Deal Full Container Pickup DATE must be a valid YYYY-MM-DD business date.");
  }
  // These two fields determine the financial document's IssueDate/DueDate.
  // A mapping, scalar or calendar-date failure holds before any unrelated
  // Quote/customer lookup or Xero preflight can turn it into a Draft.
  if (sourceHolds.length) {
    return {
      dealId,
      dealNumber: text(deal.potential_no ?? deal.deal_no),
      quoteId: "",
      quoteNumber: "",
      customerVtigerId: "",
      customerName: "",
      customerKind: "contact",
      containerSituation: text(deal.cf_potentials_containersituationselectone),
      originSuburb: text(deal.cf_potentials_pickuplocation),
      destinationSuburb: text(deal.cf_potentials_deliverylocation),
      fullContainerPickupDate,
      depositStatus,
      mappingEvidence: mapping.mappingEvidence,
      sourceHoldReason: sourceHolds.join(" "),
      sourceRefreshedAt: latestTimestamp(deal.modifiedtime ?? deal.modifiedTime ?? deal.createdtime),
      serviceLines: [],
    };
  }
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
    containerSituation: text(deal.cf_potentials_containersituationselectone),
    originSuburb: text(deal.cf_potentials_pickuplocation),
    destinationSuburb: text(deal.cf_potentials_deliverylocation),
    fullContainerPickupDate,
    depositStatus,
    mappingEvidence: mapping.mappingEvidence,
    sourceHoldReason: sourceHolds.length ? sourceHolds.join(" ") : null,
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

function bindVerifiedMainTransportDescription(input: {
  facts: MainCustomerInvoiceFacts;
  document: NonNullable<MainCustomerInvoicePreview["document"]>;
  preflight: FinancialXeroPreflight | null;
}): { document: NonNullable<MainCustomerInvoicePreview["document"]> | null; reason: string | null } {
  const transportCodes = Array.from(new Set(input.document.lineItems
    .map((line) => line.itemCode.trim().toUpperCase())
    .filter((itemCode) => itemCode === "SER9" || itemCode === "SER60")));
  if (transportCodes.length > 1) {
    return { document: null, reason: "Main Invoice contains conflicting current Xero transport item selections." };
  }
  const quoteItemCodes = Array.from(new Set(input.document.lineItems
    .map((line) => line.itemCode.trim())
    .filter((itemCode) => ["20' Sale", "40' Sale", "20' Hire", "40' Hire"].includes(itemCode))));
  const checks = new Map((input.preflight?.itemChecks ?? []).map((check) => [check.itemCode.trim().toUpperCase(), check]));

  let document = input.document;
  if (transportCodes.length === 1) {
    const itemCode = transportCodes[0]!;
    const item = checks.get(itemCode);
    if (!item?.found || item.isSold !== true || item.salesAccountCode !== "200" || item.salesTaxType !== "OUTPUT" || !item.nativeDescription) {
      return { document: null, reason: `Current Xero sales item ${itemCode} must be active for sale with account 200, OUTPUT GST and its native route description.` };
    }
    const rendered = applyMainCustomerInvoiceXeroTransportDescription({
    document: input.document,
    nativeDescription: item.nativeDescription,
    originSuburb: input.facts.originSuburb,
    destinationSuburb: input.facts.destinationSuburb,
    });
    if (!rendered) return { document: null, reason: `Current Xero ${itemCode} description does not expose one safe from <> to <> route template.` };
    document = rendered;
  }

  for (const itemCode of quoteItemCodes) {
    const item = checks.get(itemCode.toUpperCase());
    if (!item?.found || item.isSold !== true || !item.salesAccountCode || item.salesTaxType !== "OUTPUT") {
      return { document: null, reason: `Current Xero sales item ${itemCode} must be active for sale with an OUTPUT GST sales account.` };
    }
    // The exact current Quote service name remains the container-sale/hire line
    // description. Only its verified native sales account is taken from Xero.
    document = {
      ...document,
      lineItems: document.lineItems.map((line) => line.itemCode === itemCode ? { ...line, accountCode: item.salesAccountCode! } : line),
    };
  }
  return document
    ? { document, reason: null }
    : { document: null, reason: "Main Invoice item preflight did not produce a write-eligible proposal." };
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
  customerContactPlan: CustomerContactPlan | null;
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
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, customerContactPlan: null, noWrites: true };
  }
  try {
    const customerContactPlan = process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED === "true"
      ? await previewCustomerContactResolution(await readCurrentCustomerContactResolution(dealId))
      : null;
    if (customerContactPlan?.status === "matched" && customerContactPlan.contactId) {
      preview.document.partySourceId = customerContactPlan.contactId;
    }
    const [itemPreflight] = await preflightFinancialXeroIntents([preview.document]);
    const transport = bindVerifiedMainTransportDescription({ facts, document: preview.document, preflight: itemPreflight ?? null });
    if (!transport.document || transport.reason) {
      const reason = transport.reason ?? "Current Main Invoice transport item preflight was not completed.";
      await savePreview({ facts, preview, sourceHash, preflight: itemPreflight ?? null, state: "held", reason });
      return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: itemPreflight ? financialSha256(itemPreflight) : null, preview, preflight: itemPreflight ?? null, state: "held", holdReason: reason, customerContactPlan, noWrites: true };
    }
    preview.document = transport.document;
    // The native Xero item description becomes part of the immutable payload;
    // refresh the full contact/collision/item preflight before saving or writing.
    const [preflight] = await preflightFinancialXeroIntents([preview.document]);
    const reason = customerContactPlan?.status === "held"
      ? customerContactPlan.holdReason ?? "Xero customer-contact resolution is held."
      : customerContactPlan?.status === "would_create"
        ? "Xero customer contact is absent; preview proposes one guarded contact creation and no Draft write."
        : preflightReason(preview.document, preflight ?? null);
    if (!preflight || reason) {
      const hold = reason ?? "Xero GET-only preflight was not completed.";
      await savePreview({ facts, preview, sourceHash, preflight: preflight ?? null, state: "held", reason: hold });
      return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: preflight ? financialSha256(preflight) : null, preview, preflight: preflight ?? null, state: "held", holdReason: hold, customerContactPlan, noWrites: true };
    }
    preview.document.partySourceId = preflight.contactCheck.contactId!;
    await savePreview({ facts, preview, sourceHash, preflight, state: "previewed", reason: null });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: financialSha256(preflight), preview, preflight, state: "previewed", holdReason: null, customerContactPlan, noWrites: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Xero GET-only preflight could not be completed.";
    await savePreview({ facts, preview, sourceHash, preflight: null, state: "held", reason });
    return { facts, sourceSnapshotHash: sourceHash, rulesSnapshotHash: MAIN_CUSTOMER_INVOICE_RULES_HASH, xeroPreflightHash: null, preview, preflight: null, state: "held", holdReason: reason, customerContactPlan: null, noWrites: true };
  }
}

/** Called only by the dedicated Main Customer Invoice route after its own release is armed. */
export async function processAutomaticMainCustomerInvoice(dealId: string) {
  const policy = await getMainCustomerInvoiceReleasePolicy();
  assertMainCustomerInvoiceRelease(policy);
  let preview = await previewMainCustomerInvoice(dealId);
  if (!preview.preview.document) return { ok: false, status: "held" as const, recordId: dealId, warning: preview.holdReason ?? "Main Customer Invoice source/Xero preflight is not ready.", xeroWritesAttempted: 0 };
  const event = await getMainCustomerInvoiceEvent(dealId);
  if (!event) throw new Error("Main Customer Invoice current preflight was not recorded in the AP ledger.");
  if (event.status === "drafts_created") {
    const deduction = await processAutomaticDepositMainDeduction(dealId);
    return { ok: true, status: "duplicate_replay" as const, recordId: dealId, eventId: event.id, invoiceNumber: event.proposedInvoiceNumber, xeroWritesAttempted: deduction.xeroWritesAttempted, mainDeduction: deduction };
  }
  if (event.status === "reconciliation_required") return { ok: false, status: "reconciliation_required" as const, recordId: dealId, eventId: event.id, warning: event.holdReason ?? "Main Customer Invoice is awaiting reconciliation.", xeroWritesAttempted: 0 };
  const effectiveFrom = Date.parse(policy.effectiveFrom!);
  const sourceRefreshedAt = preview.facts.sourceRefreshedAt ? Date.parse(preview.facts.sourceRefreshedAt) : Number.NaN;
  if (!Number.isFinite(sourceRefreshedAt) || sourceRefreshedAt < effectiveFrom) {
    const reason = "Main Customer Invoice source predates the approved new-events-only cutover; it is held for reconciliation.";
    await holdMainCustomerInvoiceExecution(event.id, reason);
    return { ok: false, status: "held" as const, recordId: dealId, eventId: event.id, warning: reason, xeroWritesAttempted: 0 };
  }
  const initialReason = preflightReason(preview.preview.document, preview.preflight);
  const missingContactOnly = initialReason === "Xero customer contact is missing, ambiguous or not an exact match."
    || preview.customerContactPlan?.status === "would_create";
  if (preview.state !== "previewed" && !missingContactOnly) return { ok: false, status: "held" as const, recordId: dealId, warning: preview.holdReason ?? "Main Customer Invoice source/Xero preflight is not ready.", xeroWritesAttempted: 0 };
  let customerContactWrites = 0;
  if (process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED === "true") {
    const plan = preview.customerContactPlan;
    if (!plan) return { ok: false, status: "held" as const, recordId: dealId, warning: "Customer-contact v2 evidence is unavailable; no invoice Draft will be created.", xeroWritesAttempted: 0 };
    if (plan.status === "held") return { ok: false, status: "held" as const, recordId: dealId, warning: plan.holdReason ?? "Customer-contact v2 is held.", xeroWritesAttempted: 0 };
    if (plan.status === "would_create") {
      const created = await executeCustomerContactCreationV2(plan);
      customerContactWrites = created.contactWritesAttempted;
      if (created.status === "would_create" || created.status === "held" || created.status === "reconciliation_required") {
        return { ok: false, status: created.status === "reconciliation_required" ? "reconciliation_required" as const : "held" as const, recordId: dealId, warning: created.holdReason ?? "Customer contact creation remains held by its independent release gate.", xeroWritesAttempted: customerContactWrites };
      }
      preview = await previewMainCustomerInvoice(dealId);
    }
    if (preview.state !== "previewed" || !preview.preview.document || !preview.preflight?.contactCheck.contactId) {
      return { ok: false, status: "held" as const, recordId: dealId, warning: preview.holdReason ?? "Current customer-contact preflight changed before Draft creation.", xeroWritesAttempted: customerContactWrites };
    }
  } else {
  const source = await readCurrentCustomerContactSource({
    customerVtigerId: preview.facts.customerVtigerId,
    customerKind: preview.facts.customerKind,
    expectedCustomerName: preview.facts.customerName,
  });
  const contact = await resolveOrCreateAutomaticCustomerContact(source);
  if (contact.status === "held" || contact.status === "reconciliation_required") {
    return { ok: false, status: contact.status, recordId: dealId, warning: contact.reason, xeroWritesAttempted: contact.contactWritesAttempted };
  }
  // A contact write invalidates first-pass accounting evidence. Refresh all
  // current source and Xero checks, then bind the immutable ContactID only when
  // the second exact preflight agrees with the contact resolution.
  preview = await previewMainCustomerInvoice(dealId);
  const refreshedSource = await readCurrentCustomerContactSource({
    customerVtigerId: preview.facts.customerVtigerId,
    customerKind: preview.facts.customerKind,
    expectedCustomerName: preview.facts.customerName,
  });
  if (refreshedSource.sourceSnapshotHash !== source.sourceSnapshotHash || preview.state !== "previewed" || !preview.preview.document || preview.preflight?.contactCheck.contactId !== contact.contactId) {
    return { ok: false, status: "held" as const, recordId: dealId, warning: "Current source or Xero customer contact changed after customer-contact resolution; no invoice Draft will be created.", xeroWritesAttempted: contact.contactWritesAttempted };
  }
  customerContactWrites = contact.contactWritesAttempted;
  }
  const token = randomUUID();
  if (!(await claimMainCustomerInvoicePreview(event.id, token))) return { ok: false, status: "held" as const, recordId: dealId, eventId: event.id, warning: "Main Customer Invoice is already processing or was not freshly preflighted.", xeroWritesAttempted: customerContactWrites };
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
      return { ok: false, status: "reconciliation_required" as const, recordId: dealId, eventId: event.id, warning: "Main Customer Invoice Xero result is awaiting reconciliation; no blind retry will occur.", xeroWritesAttempted: customerContactWrites + (outcome.outcome === "reconciliation_required" ? 1 : 0) };
    }
    await completeMainCustomerInvoiceDraft({ eventId: event.id, executionId: outcome.executionId, xeroInvoiceId: outcome.result.xeroDocumentId });
    const deduction = await processAutomaticDepositMainDeduction(dealId);
    return { ok: true, status: "drafts_created" as const, recordId: dealId, eventId: event.id, invoiceNumber: outcome.result.documentNumber, xeroInvoiceId: outcome.result.xeroDocumentId, xeroWritesAttempted: customerContactWrites + 1 + deduction.xeroWritesAttempted, mainDeduction: deduction };
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
    customerContactAutomationEnabled: process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED === "true",
    customerContactV2Enabled: process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED === "true",
    policy: { enabled: policy.enabled, effectiveFrom: policy.effectiveFrom, mainInvoiceOnlyVtigerBranch: policy.mainInvoiceOnlyVtigerBranch, operationsMainInvoiceHandoff: policy.operationsMainInvoiceHandoff, migrationScope: policy.migrationScope }, noWrites: true as const };
}

export { getMainCustomerInvoiceEvents };
