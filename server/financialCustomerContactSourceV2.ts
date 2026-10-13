import { createHash } from "node:crypto";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";

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
  sourceFieldsUsed: string[];
  resolvedAt: string;
  sourceSnapshotHash: string;
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

function timestamp(record: Record<string, unknown>): string {
  const candidate = text(record.modifiedtime ?? record.modifiedTime ?? record.createdtime ?? record.createdTime);
  const parsed = candidate ? new Date(candidate) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) throw new Error("Current Deal has no valid source timestamp for customer-contact evidence.");
  return parsed.toISOString();
}

/**
 * Re-reads the current Deal plus linked Account and Contact. It deliberately
 * resolves the billing party before any Xero lookup and returns only the
 * minimal non-secret source data permitted for customer contact matching.
 */
export async function readCurrentCustomerContactResolution(dealId: string): Promise<CustomerContactResolutionSource> {
  if (!exactId(dealId)) throw new Error("Customer contact resolution requires an exact VTiger Deal webservice ID.");
  const deal = await exactRecord(dealId, "Deal");
  const linkedAccountId = exactId(deal.related_to ?? deal.relatedto);
  const linkedContactId = exactId(deal.contact_id);
  const [account, contact] = await Promise.all([
    linkedAccountId ? exactRecord(linkedAccountId, "Linked Account") : Promise.resolve(null),
    linkedContactId ? exactRecord(linkedContactId, "Linked Contact") : Promise.resolve(null),
  ]);

  const used: string[] = [];
  const directOrganisation = firstValue(deal, ["organizationname", "accountname", "cf_potentials_organizationname"]);
  let organisationName = directOrganisation.value || (account ? text(account.accountname) : "");
  if (directOrganisation.field) used.push(`Deal.${directOrganisation.field}`);
  else if (organisationName) used.push("Accounts.accountname");

  const directContact = firstValue(deal, ["contactname", "cf_potentials_contactname"]);
  let contactName = directContact.value || (contact ? contactDisplayName(contact) : "");
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
    sourceFieldsUsed: used,
    resolvedAt,
  };
  return { ...source, sourceSnapshotHash: snapshot(source) };
}
