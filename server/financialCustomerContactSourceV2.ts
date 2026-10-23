import { createHash } from "node:crypto";
import { retrieveCurrentVtigerFinancialRecord, withVtigerFinancialReadSession } from "./vtigerFinancialReadService";

export type CustomerBillingKind = "organisation" | "individual";

export type CustomerContactResolutionSource = {
  dealId: string;
  billingKind: CustomerBillingKind;
  customerVtigerId: string;
  organisationName: string | null;
  contactName: string | null;
  name: string;
  email: string | null;
  linkedAccountId: string | null;
  linkedContactId: string | null;
  /** Present only when a Main Invoice workflow validates its current linked Quote. */
  invoiceQuoteId?: string | null;
  sourceFieldsUsed: string[];
  resolvedAt: string;
  sourceSnapshotHash: string;
};

/** A workflow-selected party that the v2 contact resolver must re-read and preserve exactly. */
export type ExpectedCustomerBillingParty = {
  customerVtigerId: string;
  billingKind: CustomerBillingKind;
  name: string;
  /** The linked Quote is re-read and must remain unchanged when supplied. */
  quoteId?: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function exactId(value: unknown): string | null {
  const result = text(value);
  return /^\d+x\d+$/i.test(result) ? result : null;
}

export function normalizeCustomerName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-AU");
}

export function normalizeCustomerEmail(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase("en-AU") ?? "";
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function snapshot(input: Omit<CustomerContactResolutionSource, "sourceSnapshotHash">): string {
  return createHash("sha256").update(JSON.stringify({
    dealId: input.dealId,
    billingKind: input.billingKind,
    customerVtigerId: input.customerVtigerId,
    organisationName: input.organisationName ? normalizeCustomerName(input.organisationName) : null,
    contactName: input.contactName ? normalizeCustomerName(input.contactName) : null,
    name: normalizeCustomerName(input.name),
    email: normalizeCustomerEmail(input.email),
    linkedAccountId: input.linkedAccountId,
    linkedContactId: input.linkedContactId,
    invoiceQuoteId: input.invoiceQuoteId ?? null,
    sourceFieldsUsed: input.sourceFieldsUsed,
    resolvedAt: input.resolvedAt,
  })).digest("hex");
}

async function exactRecord(id: string, label: string): Promise<Record<string, unknown>> {
  const record = await retrieveCurrentVtigerFinancialRecord(id);
  if (exactId(record.id) !== id) throw new Error(`${label} retrieve did not return the requested exact VTiger record.`);
  return record;
}

function firstValue(record: Record<string, unknown>, fields: string[]): { value: string; field: string | null } {
  for (const field of fields) {
    const value = text(record[field]);
    if (value) return { value, field };
  }
  return { value: "", field: null };
}

function contactDisplayName(record: Record<string, unknown>): string {
  const direct = text(record.contactname);
  if (direct) return direct;
  return [text(record.firstname), text(record.lastname)].filter(Boolean).join(" ").trim();
}

function accountDisplayName(record: Record<string, unknown>): string {
  return firstValue(record, ["accountname", "organizationname", "name"]).value;
}

function timestamp(record: Record<string, unknown>): string {
  const candidate = text(record.modifiedtime ?? record.modifiedTime ?? record.createdtime ?? record.createdTime);
  const parsed = candidate ? new Date(candidate) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) throw new Error("Current Deal has no valid source timestamp for customer-contact evidence.");
  return parsed.toISOString();
}

/**
 * Re-reads the current Deal plus linked Account and Contact. If a Main Invoice
 * caller passes its linked Quote, the Quote link and the exact Deal-selected
 * party must still agree with the original preview. The Deal remains
 * organisation-first billing authority; the Quote remains service authority.
 */
export async function readCurrentCustomerContactResolution(
  dealId: string,
  expectedParty?: ExpectedCustomerBillingParty,
): Promise<CustomerContactResolutionSource> {
  return withVtigerFinancialReadSession(() => readCurrentCustomerContactResolutionInSession(dealId, expectedParty));
}

async function readCurrentCustomerContactResolutionInSession(
  dealId: string,
  expectedParty?: ExpectedCustomerBillingParty,
): Promise<CustomerContactResolutionSource> {
  if (!exactId(dealId)) throw new Error("Customer contact resolution requires an exact VTiger Deal webservice ID.");
  const deal = await exactRecord(dealId, "Deal");
  const linkedAccountId = exactId(deal.related_to ?? deal.relatedto);
  const linkedContactId = exactId(deal.contact_id);

  if (expectedParty) {
    const expectedId = exactId(expectedParty.customerVtigerId);
    const expectedName = normalizeCustomerName(text(expectedParty.name));
    if (!expectedId || !expectedName) {
      throw new Error("Main Invoice customer-contact resolution requires one exact current Deal customer identity.");
    }
    const currentKind: CustomerBillingKind = linkedAccountId ? "organisation" : "individual";
    const currentCustomerId = linkedAccountId ?? linkedContactId;
    if (!currentCustomerId || currentKind !== expectedParty.billingKind || currentCustomerId !== expectedId) {
      throw new Error("Current Deal billing party changed after Main Invoice customer preflight; no Xero contact or Draft will be created.");
    }
    if (expectedParty.quoteId) {
      const quoteId = exactId(deal.cf_potentials_quotereference ?? deal.quote_reference ?? deal.items_sync_with);
      if (!quoteId || quoteId !== expectedParty.quoteId) {
        throw new Error("Current Deal Quote reference changed after Main Invoice customer preflight; no Xero contact or Draft will be created.");
      }
      await exactRecord(quoteId, "Current Main Invoice Quote");
    }
    const party = await exactRecord(
      expectedId,
      expectedParty.billingKind === "organisation" ? "Current Main Invoice Deal organisation" : "Current Main Invoice Deal contact",
    );
    const name = expectedParty.billingKind === "organisation" ? accountDisplayName(party) : contactDisplayName(party);
    if (normalizeCustomerName(name) !== expectedName) {
      throw new Error("Current Deal customer identity changed after Main Invoice customer preflight; no Xero contact or Draft will be created.");
    }
    const partyEmail = firstValue(party, ["email", "email1"]);
    const dealEmail = expectedParty.billingKind === "individual" && linkedContactId === expectedId
      ? firstValue(deal, ["email", "cf_potentials_contactemail"])
      : { value: "", field: null };
    const rawEmail = partyEmail.value || dealEmail.value;
    const email = rawEmail && validEmail(rawEmail) ? rawEmail : null;
    const source: Omit<CustomerContactResolutionSource, "sourceSnapshotHash"> = {
      dealId,
      billingKind: expectedParty.billingKind,
      customerVtigerId: expectedId,
      organisationName: expectedParty.billingKind === "organisation" ? name : null,
      contactName: expectedParty.billingKind === "individual" ? name : null,
      name,
      email,
      linkedAccountId,
      linkedContactId,
      invoiceQuoteId: expectedParty.quoteId ?? null,
      sourceFieldsUsed: [
        expectedParty.quoteId ? "Deal.currentQuote+Deal.billingParty" : "MainInvoice.billingParty",
        expectedParty.billingKind === "organisation" ? "Accounts.accountname" : "Contacts.firstname+lastname",
        ...(partyEmail.field ? [`CurrentQuoteCustomer.${partyEmail.field}`] : dealEmail.field ? [`Deal.${dealEmail.field}`] : []),
      ],
      resolvedAt: timestamp(deal),
    };
    return { ...source, sourceSnapshotHash: snapshot(source) };
  }

  const [account, contact] = await Promise.all([
    linkedAccountId ? exactRecord(linkedAccountId, "Linked Account") : Promise.resolve(null),
    linkedContactId ? exactRecord(linkedContactId, "Linked Contact") : Promise.resolve(null),
  ]);

  const used: string[] = [];
  const directOrganisation = firstValue(deal, ["organizationname", "accountname", "cf_potentials_organizationname"]);
  const organisationName = directOrganisation.value || (account ? text(account.accountname) : "");
  if (directOrganisation.field) used.push(`Deal.${directOrganisation.field}`);
  else if (organisationName) used.push("Accounts.accountname");

  const directContact = firstValue(deal, ["contactname", "cf_potentials_contactname"]);
  const contactName = directContact.value || (contact ? contactDisplayName(contact) : "");
  if (directContact.field) used.push(`Deal.${directContact.field}`);
  else if (contactName) used.push("Contacts.firstname+lastname");

  const linkedEmail = contact ? firstValue(contact, ["email", "email1"]) : { value: "", field: null };
  const dealEmail = firstValue(deal, ["email", "cf_potentials_contactemail"]);
  const rawEmail = linkedEmail.value || dealEmail.value;
  if (linkedEmail.field) used.push(`Contacts.${linkedEmail.field}`);
  else if (dealEmail.field) used.push(`Deal.${dealEmail.field}`);
  const email = rawEmail && validEmail(rawEmail) ? rawEmail : null;
  if (rawEmail && !email) used.push("email_ignored_invalid");

  const billingKind: CustomerBillingKind = organisationName ? "organisation" : "individual";
  const name = organisationName || contactName;
  if (!name.trim()) {
    throw new Error("held_missing_customer_identity: current Deal has no usable organisation or individual customer name.");
  }
  const customerVtigerId = billingKind === "organisation" ? linkedAccountId ?? dealId : linkedContactId ?? dealId;
  const resolvedAt = timestamp(deal);
  const source: Omit<CustomerContactResolutionSource, "sourceSnapshotHash"> = {
    dealId,
    billingKind,
    customerVtigerId,
    organisationName: organisationName || null,
    contactName: contactName || null,
    name,
    email,
    linkedAccountId,
    linkedContactId,
    invoiceQuoteId: null,
    sourceFieldsUsed: used,
    resolvedAt,
  };
  return { ...source, sourceSnapshotHash: snapshot(source) };
}
