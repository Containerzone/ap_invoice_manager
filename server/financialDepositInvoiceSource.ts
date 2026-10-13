import {
  describeVtigerFinancialModuleFields,
  queryCurrentVtigerFinancialRecords,
  retrieveCurrentVtigerFinancialRecord,
} from "./vtigerFinancialReadService";
import type { DepositInvoiceFacts } from "./financialDepositInvoiceDrafts";

export const DEPOSIT_INVOICE_VTIGER_MODULE = "Potentials" as const;
export const DEPOSIT_FIELD_LABELS = {
  depositStatus: "Deposit Status",
  depositAmountRequired: "Deposit Amount Required",
  emptyContainerSupplyDate: "Empty Container Supply Date",
  fullContainerCollectionDate: "Full Container Collection Date",
} as const;
const REQUIRED_DEPOSIT_FIELD_KEYS = [
  "depositStatus",
  "depositAmountRequired",
] as const;
const OPTIONAL_DEPOSIT_DATE_FIELD_KEYS = [
  "emptyContainerSupplyDate",
  "fullContainerCollectionDate",
] as const;
const OPERATIONS_FIELD_NAMES: Partial<Record<keyof typeof DEPOSIT_FIELD_LABELS, string>> = {
  depositAmountRequired: "cf_potentials_extras",
  emptyContainerSupplyDate: "cf_potentials_emptycontainersupplydate",
  fullContainerCollectionDate: "cf_potentials_fullcontainercollectiondate",
};
const text = (value: unknown) =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";
const id = (value: unknown) =>
  /^\d+x\d+$/i.test(text(value)) ? text(value) : "";
function timestamp(value: unknown): string | null {
  const date = text(value) ? new Date(text(value)) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function amount(value: unknown): number | null {
  const raw = text(value);
  if (!raw || !/^\$?\d+(?:,\d{3})*(?:\.\d+)?$/.test(raw)) return null;
  const result = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(result) ? result : null;
}
async function exactRecord(reference: string, description: string) {
  if (!/^\d+x\d+$/i.test(reference))
    throw new Error(`${description} requires an exact VTiger webservice ID.`);
  const result = await retrieveCurrentVtigerFinancialRecord(reference);
  if (id(result.id) !== reference)
    throw new Error(
      `${description} retrieve did not return the exact requested record.`
    );
  return result;
}

function quoteReference(value: unknown): string { return text(value); }

async function resolveQuote(reference: string): Promise<{ quote: Record<string, unknown> | null; quoteId: string; quoteNumber: string; hold: string | null }> {
  if (!reference) return { quote: null, quoteId: "", quoteNumber: "", hold: "A current linked VTiger Quote is required for the Deposit Invoice." };
  if (id(reference)) {
    const quote = await exactRecord(reference, "Deposit Quote");
    return { quote, quoteId: reference, quoteNumber: text(quote.quote_no) || reference, hold: null };
  }
  const matches = await queryCurrentVtigerFinancialRecords("Quotes", "quote_no", reference);
  const exact = matches.filter((row) => id(row.id) && text(row.quote_no).toUpperCase() === reference.toUpperCase());
  if (exact.length !== 1) return { quote: null, quoteId: "", quoteNumber: reference, hold: "The current Deposit Quote number is absent or ambiguous; no Quote will be guessed." };
  return { quote: exact[0]!, quoteId: id(exact[0]!.id), quoteNumber: text(exact[0]!.quote_no) || reference, hold: null };
}

/** Read-only metadata plus the exact Deal, linked Quote and current customer. */
export async function readDepositInvoiceFacts(
  dealId: string
): Promise<DepositInvoiceFacts> {
  const deal = await exactRecord(dealId, "Deposit Deal");
  const metadata = await describeVtigerFinancialModuleFields(
    DEPOSIT_INVOICE_VTIGER_MODULE
  );
  const mappingEvidence: Record<string, string> = {};
  const holds: string[] = [];
  if (
    metadata.name !== DEPOSIT_INVOICE_VTIGER_MODULE ||
    !metadata.fields.some(field => field.name === "potential_no")
  )
    holds.push("Current metadata does not confirm the Potentials Deal schema.");
  for (const key of REQUIRED_DEPOSIT_FIELD_KEYS) {
    const label = DEPOSIT_FIELD_LABELS[key];
    const expectedName = OPERATIONS_FIELD_NAMES[key];
    const fields = metadata.fields.filter(field => expectedName ? field.name === expectedName : field.label.trim().toLowerCase() === label.toLowerCase());
    if (fields.length !== 1) {
      holds.push(
        `Deal field mapping for ${label} is absent or ambiguous; no alias will be guessed.`
      );
      continue;
    }
    const name = fields[0]!.name;
    mappingEvidence[key] = name;
    if (
      !Object.prototype.hasOwnProperty.call(deal, name) ||
      deal[name] === null ||
      deal[name] === undefined ||
      !["string", "number"].includes(typeof deal[name])
    )
      holds.push(
        `Current Deal retrieve does not supply a scalar ${label} field.`
      );
  }
  // The historical Operations action sent no date value when neither optional
  // scheduling field was available. Preserve that semantics: neither missing
  // nor ambiguous optional date metadata may block an otherwise valid Deposit
  // Draft. A date is used only when one uniquely mapped scalar is present;
  // buildDepositInvoice still rejects a populated malformed or conflicting date.
  for (const key of OPTIONAL_DEPOSIT_DATE_FIELD_KEYS) {
    const label = DEPOSIT_FIELD_LABELS[key];
    const expectedName = OPERATIONS_FIELD_NAMES[key];
    const fields = metadata.fields.filter(field => expectedName ? field.name === expectedName : field.label.trim().toLowerCase() === label.toLowerCase());
    if (fields.length !== 1) continue;
    const name = fields[0]!.name;
    const value = deal[name];
    if (
      Object.prototype.hasOwnProperty.call(deal, name) &&
      value !== null &&
      value !== undefined &&
      ["string", "number"].includes(typeof value)
    ) {
      mappingEvidence[key] = name;
    }
  }
  const quoteResolution = await resolveQuote(quoteReference(deal.cf_potentials_quotereference ?? deal.quote_reference));
  if (quoteResolution.hold) holds.push(quoteResolution.hold);
  // Organisation on the linked Quote takes precedence, then the current Deal.
  const organisationRaw = text(quoteResolution.quote?.account_id ?? deal.related_to ?? deal.relatedto);
  const contactRaw = text(quoteResolution.quote?.contact_id ?? deal.contact_id);
  if (organisationRaw && !id(organisationRaw))
    holds.push(
      "Current Deal organisation reference is not an exact VTiger ID; contact fallback cannot bypass it."
    );
  if (!organisationRaw && contactRaw && !id(contactRaw))
    holds.push("Current Deal contact reference is not an exact VTiger ID.");
  const customerKind = organisationRaw ? "organisation" : "contact";
  const customerVtigerId = id(organisationRaw || contactRaw);
  const customer = customerVtigerId
    ? await exactRecord(customerVtigerId, `Deal customer ${customerKind}`)
    : null;
  const customerName = customer
    ? customerKind === "organisation"
      ? text(customer.accountname ?? customer.organizationname ?? customer.name)
      : [text(customer.firstname), text(customer.lastname)]
          .filter(Boolean)
          .join(" ")
    : "";
  if (customer && !customerName)
    holds.push(
      `Exact Deal customer ${customerKind} has no schema-confirmed usable name.`
    );
  const field = (key: keyof typeof DEPOSIT_FIELD_LABELS) =>
    mappingEvidence[key] ? deal[mappingEvidence[key]!] : undefined;
  const dealNumber = text(deal.potential_no);
  if (!/^D\d{1,12}$/i.test(dealNumber) || !text(deal.potentialname))
    holds.push(
      "The exact retrieved source is not a named current Deal with a D-prefixed potential_no."
    );
  return {
    dealId,
    dealNumber,
    quoteId: quoteResolution.quoteId,
    quoteNumber: quoteResolution.quoteNumber,
    depositStatus: text(field("depositStatus")),
    depositAmountRequiredInclusive: amount(field("depositAmountRequired")),
    customerVtigerId,
    customerName,
    customerKind,
    emptyContainerSupplyDate: text(field("emptyContainerSupplyDate")),
    fullContainerCollectionDate: text(field("fullContainerCollectionDate")),
    // New-events-only checks the Deal itself; a customer change cannot make an old Deal new.
    sourceRefreshedAt: timestamp(deal.modifiedtime),
    customerRefreshedAt: customer ? timestamp(customer.modifiedtime) : null,
    mappingEvidence,
    sourceHoldReason: holds.length ? holds.join(" ") : null,
  };
}
