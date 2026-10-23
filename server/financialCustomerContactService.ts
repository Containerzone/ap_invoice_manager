import axios from "axios";
import { createHash } from "node:crypto";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { runBoundedXeroGet, runXeroRequest } from "./xeroRequestManager";
import {
  getFinancialCustomerContactEvent,
  reserveFinancialCustomerContactEvent,
  completeFinancialCustomerContactEvent,
  holdFinancialCustomerContactEvent,
  requireFinancialCustomerContactLedger,
} from "./financialCustomerContactDb";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const EXPECTED_AP_TENANT_LABEL = "CONTAINERZONE";

export type CustomerContactSource = {
  customerVtigerId: string;
  customerKind: "organisation" | "contact";
  name: string;
  email: string | null;
  phone: string | null;
  sourceSnapshotHash: string;
};

type XeroCustomerContact = {
  contactId: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
};

export type CustomerContactResolution =
  | { status: "matched"; contactId: string; contactEventId: number | null; reason: null; contactWritesAttempted: 0 }
  | { status: "created"; contactId: string; contactEventId: number; reason: null; contactWritesAttempted: 0 | 1 }
  | { status: "held" | "reconciliation_required"; contactId: null; contactEventId: number | null; reason: string; contactWritesAttempted: 0 | 1 };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function literal(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
function normalEmail(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}
function normalPhone(value: string | null | undefined): string {
  return value?.replace(/\D/g, "") ?? "";
}
function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function sourceKey(input: CustomerContactSource): string {
  return createHash("sha256").update(JSON.stringify({
    customerVtigerId: input.customerVtigerId.trim(),
    customerKind: input.customerKind,
    name: literal(input.name),
    email: normalEmail(input.email),
    phone: normalPhone(input.phone),
  })).digest("hex");
}
function safeHeaders(auth: { token: string; tenantId: string }) {
  return { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" };
}
function toXeroCustomerContact(value: any): XeroCustomerContact | null {
  const contactId = text(value?.ContactID);
  if (!contactId) return null;
  const phones = Array.isArray(value?.Phones) ? value.Phones : [];
  const mobile = phones.find((phone: any) => text(phone?.PhoneType).toUpperCase() === "MOBILE")
    ?? phones[0]
    ?? null;
  return {
    contactId,
    name: text(value?.Name),
    email: text(value?.EmailAddress) || null,
    phone: text(mobile?.PhoneNumber) || null,
    status: text(value?.ContactStatus).toUpperCase() || null,
  };
}
function matchesSource(contact: XeroCustomerContact, source: CustomerContactSource): boolean {
  return literal(contact.name) === literal(source.name)
    && (!normalEmail(source.email) || normalEmail(contact.email) === normalEmail(source.email));
}
function hasInvalidSource(source: CustomerContactSource): string | null {
  if (!/^\d+x\d+$/i.test(source.customerVtigerId.trim())) return "Current VTiger customer identity is invalid; no Xero contact can be created.";
  if (!literal(source.name)) return "Current VTiger customer has no usable exact name; no Xero contact can be created.";
  if (normalEmail(source.email) && !validEmail(normalEmail(source.email))) return "Current VTiger customer email is malformed; no Xero contact can be created.";
  return null;
}

/** Exact literal customer identity only. Supplier first-token/fuzzy rules are deliberately not reused. */
export function classifyExactCustomerContactMatches(input: {
  source: CustomerContactSource;
  nameMatches: XeroCustomerContact[];
  emailMatches: XeroCustomerContact[];
}): CustomerContactResolution {
  const invalid = hasInvalidSource(input.source);
  if (invalid) return { status: "held", contactId: null, contactEventId: null, reason: invalid, contactWritesAttempted: 0 };
  const candidates = Array.from(new Map([...input.nameMatches, ...input.emailMatches].map(candidate => [candidate.contactId, candidate])).values());
  if (candidates.some(candidate => candidate.status !== "ACTIVE")) {
    return { status: "held", contactId: null, contactEventId: null, reason: "A matching Xero customer contact is inactive or archived; no contact will be adopted or created.", contactWritesAttempted: 0 };
  }
  const sourceEmail = normalEmail(input.source.email);
  if (input.nameMatches.length > 1 || input.emailMatches.length > 1) {
    return { status: "held", contactId: null, contactEventId: null, reason: "More than one exact Xero customer name or email match exists; manual selection is required.", contactWritesAttempted: 0 };
  }
  const nameMatch = input.nameMatches[0] ?? null;
  const emailMatch = input.emailMatches[0] ?? null;
  if (sourceEmail) {
    if (nameMatch && emailMatch && nameMatch.contactId === emailMatch.contactId && matchesSource(nameMatch, input.source)) {
      return { status: "matched", contactId: nameMatch.contactId, contactEventId: null, reason: null, contactWritesAttempted: 0 };
    }
    if (nameMatch || emailMatch) {
      return { status: "held", contactId: null, contactEventId: null, reason: "Exact Xero customer name and email do not resolve to the same active contact; manual selection is required.", contactWritesAttempted: 0 };
    }
  } else if (nameMatch && matchesSource(nameMatch, input.source)) {
    return { status: "matched", contactId: nameMatch.contactId, contactEventId: null, reason: null, contactWritesAttempted: 0 };
  } else if (emailMatch || nameMatch) {
    return { status: "held", contactId: null, contactEventId: null, reason: "An exact Xero customer match conflicts with the current source identity; manual selection is required.", contactWritesAttempted: 0 };
  }
  return { status: "held", contactId: null, contactEventId: null, reason: "No exact Xero customer contact exists and automatic customer-contact creation is disabled.", contactWritesAttempted: 0 };
}

async function assertExpectedTenant(auth: { token: string; tenantId: string }): Promise<void> {
  const response = await runBoundedXeroGet(auth, "GET financial-customer-contact-tenant", `${XERO_API_BASE}/Organisation`, { headers: safeHeaders(auth) });
  const name = text(response.data?.Organisations?.[0]?.Name).toUpperCase();
  if (!name.includes(EXPECTED_AP_TENANT_LABEL)) throw new Error("Connected Xero organisation does not match the expected AP tenant.");
}

async function findExactCustomerMatches(auth: { token: string; tenantId: string }, source: CustomerContactSource): Promise<{ nameMatches: XeroCustomerContact[]; emailMatches: XeroCustomerContact[] }> {
  const headers = safeHeaders(auth);
  const nameResponse = await runBoundedXeroGet(auth, "GET financial-customer-contact-name", `${XERO_API_BASE}/Contacts`, { headers, params: { searchTerm: source.name.trim() } });
  const nameMatches = (Array.isArray(nameResponse.data?.Contacts) ? nameResponse.data.Contacts : [])
    .map(toXeroCustomerContact)
    .filter((contact: XeroCustomerContact | null): contact is XeroCustomerContact => Boolean(contact))
    .filter((contact: XeroCustomerContact) => literal(contact.name) === literal(source.name));
  const email = normalEmail(source.email);
  if (!email) return { nameMatches, emailMatches: [] };
  const emailResponse = await runBoundedXeroGet(auth, "GET financial-customer-contact-email", `${XERO_API_BASE}/Contacts`, { headers, params: { searchTerm: email } });
  const emailMatches = (Array.isArray(emailResponse.data?.Contacts) ? emailResponse.data.Contacts : [])
    .map(toXeroCustomerContact)
    .filter((contact: XeroCustomerContact | null): contact is XeroCustomerContact => Boolean(contact))
    .filter((contact: XeroCustomerContact) => normalEmail(contact.email) === email);
  return { nameMatches, emailMatches };
}

function contactPayload(source: CustomerContactSource) {
  const phone = source.phone?.trim() || null;
  return {
    Contacts: [{
      Name: source.name.trim(),
      ...(source.email?.trim() ? { EmailAddress: source.email.trim() } : {}),
      ...(phone ? { Phones: [{ PhoneType: "MOBILE", PhoneNumber: phone }] } : {}),
    }],
  };
}

async function readBackCreatedContact(auth: { token: string; tenantId: string }, source: CustomerContactSource, contactId: string): Promise<XeroCustomerContact> {
  const response = await runBoundedXeroGet(auth, "GET financial-customer-contact-readback", `${XERO_API_BASE}/Contacts/${encodeURIComponent(contactId)}`, { headers: safeHeaders(auth) });
  const contact = toXeroCustomerContact(response.data?.Contacts?.[0]);
  if (!contact || contact.contactId !== contactId || contact.status !== "ACTIVE" || !matchesSource(contact, source)) {
    throw new Error("Xero customer contact read-back did not confirm the exact active source identity.");
  }
  if (normalPhone(source.phone) && normalPhone(contact.phone) !== normalPhone(source.phone)) {
    throw new Error("Xero customer contact read-back did not confirm the source mobile number.");
  }
  return contact;
}

/**
 * Used only from the protected automatic Main/Deposit paths. It always searches
 * Xero fresh. A POST is permitted only after a shared local reservation, no exact
 * name/email matches, an explicitly enabled contact gate, and a forced read-back.
 */
export async function resolveOrCreateAutomaticCustomerContact(source: CustomerContactSource): Promise<CustomerContactResolution> {
  const invalid = hasInvalidSource(source);
  if (invalid) return { status: "held", contactId: null, contactEventId: null, reason: invalid, contactWritesAttempted: 0 };
  const auth = await getXeroReadAuthWithRefresh();
  await assertExpectedTenant(auth);
  const firstMatches = await findExactCustomerMatches(auth, source);
  const classification = classifyExactCustomerContactMatches({ source, ...firstMatches });
  if (classification.status === "matched") return classification;
  // Name/email conflicts and ambiguity are never eligible for a create attempt.
  if (firstMatches.nameMatches.length || firstMatches.emailMatches.length) return classification;
  if (process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED !== "true") return classification;

  await requireFinancialCustomerContactLedger();
  const customerKey = sourceKey(source);
  const idempotencyKey = createHash("sha256").update(`customer-contact:${auth.tenantId}:${customerKey}`).digest("hex");
  const reservation = await reserveFinancialCustomerContactEvent({
    customerKey,
    source,
    tenantIdHash: createHash("sha256").update(auth.tenantId).digest("hex"),
    idempotencyKey,
  });
  if (reservation.kind === "existing") {
    if ((reservation.event.status === "created" || reservation.event.status === "matched") && reservation.event.xeroContactId) {
      if (reservation.event.status === "created") {
        return { status: "created", contactId: reservation.event.xeroContactId, contactEventId: reservation.event.id, reason: null, contactWritesAttempted: 0 };
      }
      return { status: "matched", contactId: reservation.event.xeroContactId, contactEventId: reservation.event.id, reason: null, contactWritesAttempted: 0 };
    }
    if (reservation.event.status === "reconciliation_required") {
      return { status: "reconciliation_required", contactId: null, contactEventId: reservation.event.id, reason: "A previous Xero customer contact create outcome is uncertain; reconcile by the local contact event before any retry.", contactWritesAttempted: 0 };
    }
    return { status: "held", contactId: null, contactEventId: reservation.event.id, reason: "This Xero customer contact is already being processed or is held; no duplicate create will be sent.", contactWritesAttempted: 0 };
  }

  try {
    // Force a fresh second lookup after the local reservation. A contact created
    // manually in the small interval is adopted only when it passes the same exact rules.
    const freshMatches = await findExactCustomerMatches(auth, source);
    const fresh = classifyExactCustomerContactMatches({ source, ...freshMatches });
    if (fresh.status === "matched") {
      await completeFinancialCustomerContactEvent(reservation.event.id, { status: "matched", xeroContactId: fresh.contactId, evidence: { match: "exact_name_and_email_or_name_only" } });
      return { ...fresh, contactEventId: reservation.event.id };
    }
    if (freshMatches.nameMatches.length || freshMatches.emailMatches.length) {
      await holdFinancialCustomerContactEvent(reservation.event.id, fresh.reason ?? "Xero customer contact resolution held.");
      return { status: "held", contactId: null, contactEventId: reservation.event.id, reason: fresh.reason ?? "Xero customer contact resolution held.", contactWritesAttempted: 0 };
    }

    const payload = contactPayload(source);
    const response = await runXeroRequest(auth, "POST financial-customer-contact", () => axios.post(`${XERO_API_BASE}/Contacts`, payload, {
      headers: { ...safeHeaders(auth), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    }), { retryTransientGatewayFailures: false });
    const created = toXeroCustomerContact(response.data?.Contacts?.[0]);
    const errors = Array.isArray(response.data?.Contacts?.[0]?.ValidationErrors) ? response.data.Contacts[0].ValidationErrors : [];
    if (!created?.contactId || errors.length) throw new Error("Xero customer contact creation did not return one contact ID without validation errors.");
    const readBack = await readBackCreatedContact(auth, source, created.contactId);
    await completeFinancialCustomerContactEvent(reservation.event.id, { status: "created", xeroContactId: readBack.contactId, evidence: { payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), readBackHash: createHash("sha256").update(JSON.stringify({ id: readBack.contactId, name: readBack.name, email: readBack.email, phone: normalPhone(readBack.phone), status: readBack.status })).digest("hex") } });
    return { status: "created", contactId: readBack.contactId, contactEventId: reservation.event.id, reason: null, contactWritesAttempted: 1 };
  } catch (error: any) {
    const status = error?.response?.status;
    const reason = status && [502, 503, 504].includes(status)
      ? "Xero customer contact creation returned an uncertain gateway outcome; reconcile by the local contact event before any retry."
      : "Xero customer contact creation could not be completed.";
    await holdFinancialCustomerContactEvent(reservation.event.id, reason, status && [502, 503, 504].includes(status));
    return { status: status && [502, 503, 504].includes(status) ? "reconciliation_required" : "held", contactId: null, contactEventId: reservation.event.id, reason, contactWritesAttempted: 0 };
  }
}

export async function getAutomaticCustomerContactEvent(eventId: number) {
  return getFinancialCustomerContactEvent(eventId);
}
