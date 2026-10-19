import axios from "axios";
import { createHash } from "node:crypto";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { runXeroRequest } from "./xeroRequestManager";
import {
  completeFinancialCustomerContactEvent,
  holdFinancialCustomerContactEvent,
  reserveFinancialCustomerContactEvent,
  requireFinancialCustomerContactLedger,
} from "./financialCustomerContactDb";
import {
  normalizeCustomerEmail,
  normalizeCustomerName,
  readCurrentCustomerContactResolution,
  type CustomerContactResolutionSource,
} from "./financialCustomerContactSourceV2";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const EXPECTED_AP_TENANT_LABEL = "CONTAINERZONE";

export type CustomerContactAuditOutcome =
  | "matched_by_name"
  | "matched_by_email"
  | "would_create_contact"
  | "created_contact"
  | "held_missing_customer_identity"
  | "held_duplicate_or_ambiguous"
  | "held_xero_contact_creation_failed"
  | "reconciled_existing";

export type XeroCustomerContactCandidate = {
  contactId: string;
  name: string;
  email: string | null;
  status: string | null;
};

export type CustomerContactPlan = {
  source: CustomerContactResolutionSource;
  status: "matched" | "would_create" | "held";
  outcome: CustomerContactAuditOutcome;
  contactId: string | null;
  contactName: string | null;
  includeEmailOnCreate: boolean;
  lookupOrder: string[];
  nameMatchCount: number;
  emailMatchCount: number;
  holdReason: string | null;
};

export type CustomerContactExecution = Omit<CustomerContactPlan, "status"> & {
  status: "matched" | "created" | "would_create" | "held" | "reconciliation_required";
  contactEventId: number | null;
  contactWritesAttempted: 0 | 1;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function headers(auth: { token: string; tenantId: string }) {
  return { Authorization: `Bearer ${auth.token}`, "Xero-tenant-id": auth.tenantId, Accept: "application/json" };
}

function candidate(value: unknown): XeroCustomerContactCandidate | null {
  const record = value as Record<string, unknown> | null;
  const contactId = text(record?.ContactID);
  if (!contactId) return null;
  return {
    contactId,
    name: text(record?.Name),
    email: text(record?.EmailAddress) || null,
    status: text(record?.ContactStatus).toUpperCase() || null,
  };
}

function dedupe(candidates: XeroCustomerContactCandidate[]): XeroCustomerContactCandidate[] {
  return Array.from(new Map(candidates.map(item => [item.contactId, item])).values());
}

function exactName(candidates: XeroCustomerContactCandidate[], name: string) {
  const desired = normalizeCustomerName(name);
  return candidates.filter(item => normalizeCustomerName(item.name) === desired);
}

function active(candidate: XeroCustomerContactCandidate): boolean {
  return candidate.status === "ACTIVE";
}

function held(source: CustomerContactResolutionSource, lookupOrder: string[], reason: string, nameMatchCount = 0, emailMatchCount = 0, outcome: CustomerContactAuditOutcome = "held_duplicate_or_ambiguous"): CustomerContactPlan {
  return { source, status: "held", outcome, contactId: null, contactName: null, includeEmailOnCreate: false, lookupOrder, nameMatchCount, emailMatchCount, holdReason: reason };
}

function matched(source: CustomerContactResolutionSource, lookupOrder: string[], result: XeroCustomerContactCandidate, outcome: Extract<CustomerContactAuditOutcome, "matched_by_name" | "matched_by_email">, nameMatchCount: number, emailMatchCount: number): CustomerContactPlan {
  if (!active(result)) return held(source, lookupOrder, "A resolved Xero customer contact is inactive or archived; no contact will be adopted or created.", nameMatchCount, emailMatchCount);
  return { source, status: "matched", outcome, contactId: result.contactId, contactName: result.name, includeEmailOnCreate: false, lookupOrder, nameMatchCount, emailMatchCount, holdReason: null };
}

function wouldCreate(source: CustomerContactResolutionSource, lookupOrder: string[], nameMatchCount: number, emailMatchCount: number, emailAlreadyExists: boolean): CustomerContactPlan {
  return { source, status: "would_create", outcome: "would_create_contact", contactId: null, contactName: source.name, includeEmailOnCreate: Boolean(source.email && !emailAlreadyExists), lookupOrder, nameMatchCount, emailMatchCount, holdReason: null };
}

/** Pure organisation-first / individual-email-first decision function. */
export function planCustomerContactResolution(input: {
  source: CustomerContactResolutionSource;
  nameResults: XeroCustomerContactCandidate[];
  emailResults: XeroCustomerContactCandidate[];
  lookupOrder?: string[];
}): CustomerContactPlan {
  const { source } = input;
  const lookupOrder = input.lookupOrder ?? (source.billingKind === "organisation" ? ["name", "email"] : ["email", "name"]);
  if (!source.name.trim()) return held(source, lookupOrder, "Current Deal has no usable customer identity; no Xero contact or Draft may be created.", 0, 0, "held_missing_customer_identity");
  const nameResults = dedupe(input.nameResults);
  const emailResults = dedupe(input.emailResults);
  const nameMatches = exactName(nameResults, source.name);
  const email = normalizeCustomerEmail(source.email);
  const emailMatches = email ? emailResults.filter(item => normalizeCustomerEmail(item.email) === email) : [];

  if (source.billingKind === "organisation") {
    if (nameMatches.length > 1) return held(source, lookupOrder, "More than one exact active or inactive Xero organisation-name match exists; AP will not choose one.", nameMatches.length, emailMatches.length);
    if (nameMatches.length === 1) return matched(source, lookupOrder, nameMatches[0]!, "matched_by_name", nameMatches.length, emailMatches.length);
    // An email hit is evidence only for an organisation: do not adopt a linked person.
    if (emailMatches.some(item => !active(item))) return held(source, lookupOrder, "The organisation email is associated with an inactive Xero contact; AP will not adopt or duplicate it.", nameMatches.length, emailMatches.length);
    return wouldCreate(source, lookupOrder, nameMatches.length, emailMatches.length, emailMatches.length > 0);
  }

  if (email) {
    const activeEmail = emailMatches.filter(active);
    if (emailMatches.length !== activeEmail.length) return held(source, lookupOrder, "An exact Xero customer email match is inactive or archived; AP will not adopt or duplicate it.", nameMatches.length, emailMatches.length);
    if (activeEmail.length) {
      const named = activeEmail.filter(item => normalizeCustomerName(item.name) === normalizeCustomerName(source.name));
      if (named.length === 1) return matched(source, lookupOrder, named[0]!, "matched_by_email", nameMatches.length, emailMatches.length);
      if (named.length > 1) return held(source, lookupOrder, "More than one Xero email result has the same intended customer name; AP will not choose one.", nameMatches.length, emailMatches.length);
      return held(source, lookupOrder, "An exact Xero customer email belongs to a different name; AP will not choose or duplicate it.", nameMatches.length, emailMatches.length);
    }
  }

  if (nameMatches.length > 1) return held(source, lookupOrder, "More than one exact Xero customer-name match exists; AP will not choose one.", nameMatches.length, emailMatches.length);
  if (nameMatches.length === 1) return matched(source, lookupOrder, nameMatches[0]!, "matched_by_name", nameMatches.length, emailMatches.length);
  return wouldCreate(source, lookupOrder, nameMatches.length, emailMatches.length, false);
}

async function assertExpectedTenant(auth: { token: string; tenantId: string }): Promise<void> {
  const response = await runXeroRequest(auth, "GET customer-contact-v2-tenant", () => axios.get(`${XERO_API_BASE}/Organisation`, { headers: headers(auth) }));
  if (!text(response.data?.Organisations?.[0]?.Name).toUpperCase().includes(EXPECTED_AP_TENANT_LABEL)) {
    throw new Error("Connected Xero organisation does not match the expected AP tenant.");
  }
}

async function search(auth: { token: string; tenantId: string }, value: string, field: "name" | "email"): Promise<XeroCustomerContactCandidate[]> {
  const response = await runXeroRequest(auth, `GET customer-contact-v2-${field}`, () => axios.get(`${XERO_API_BASE}/Contacts`, { headers: headers(auth), params: { searchTerm: value } }));
  return (Array.isArray(response.data?.Contacts) ? response.data.Contacts : [])
    .map(candidate)
    .filter((item: XeroCustomerContactCandidate | null): item is XeroCustomerContactCandidate => Boolean(item));
}

/** GET-only decision. It never reserves a contact event and never writes Xero. */
export async function previewCustomerContactResolution(source: CustomerContactResolutionSource): Promise<CustomerContactPlan> {
  if (!source.name.trim()) return held(source, [], "Current Deal has no usable customer identity; no Xero contact or Draft may be created.", 0, 0, "held_missing_customer_identity");
  const auth = await getXeroReadAuthWithRefresh();
  await assertExpectedTenant(auth);
  if (source.billingKind === "organisation") {
    const nameResults = await search(auth, source.name, "name");
    const nameMatches = exactName(nameResults, source.name);
    if (nameMatches.length) return planCustomerContactResolution({ source, nameResults, emailResults: [], lookupOrder: ["name"] });
    const emailResults = source.email ? await search(auth, source.email, "email") : [];
    return planCustomerContactResolution({ source, nameResults, emailResults, lookupOrder: source.email ? ["name", "email"] : ["name"] });
  }
  const emailResults = source.email ? await search(auth, source.email, "email") : [];
  if (source.email && emailResults.length) return planCustomerContactResolution({ source, nameResults: [], emailResults, lookupOrder: ["email"] });
  const nameResults = await search(auth, source.name, "name");
  return planCustomerContactResolution({ source, nameResults, emailResults, lookupOrder: source.email ? ["email", "name"] : ["name"] });
}

function sourceKey(plan: CustomerContactPlan): string {
  return createHash("sha256").update(JSON.stringify({ source: plan.source.sourceSnapshotHash, billingKind: plan.source.billingKind, name: normalizeCustomerName(plan.source.name), includeEmail: plan.includeEmailOnCreate, email: plan.includeEmailOnCreate ? normalizeCustomerEmail(plan.source.email) : "" })).digest("hex");
}

function payload(plan: CustomerContactPlan) {
  return { Contacts: [{ Name: plan.source.name.trim(), ...(plan.includeEmailOnCreate && plan.source.email ? { EmailAddress: plan.source.email.trim() } : {}) }] };
}

/**
 * Executes only an already reviewed v2 would-create decision. The caller must
 * force-refresh its invoice preflight after a successful result. This remains
 * default-off under both the v2 and automatic-contact gates.
 */
export async function executeCustomerContactCreationV2(plan: CustomerContactPlan): Promise<CustomerContactExecution> {
  if (plan.status === "matched") return { ...plan, status: "matched", contactEventId: null, contactWritesAttempted: 0 };
  if (plan.status === "held") return { ...plan, status: "held", contactEventId: null, contactWritesAttempted: 0 };
  if (process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED !== "true" || process.env.FINANCIAL_CUSTOMER_CONTACT_AUTOMATIC_ENABLED !== "true") {
    return { ...plan, status: "would_create", contactEventId: null, contactWritesAttempted: 0 };
  }
  const currentSource = await readCurrentCustomerContactResolution(
    plan.source.dealId,
    plan.source.invoiceQuoteId
      ? {
        customerVtigerId: plan.source.customerVtigerId,
        billingKind: plan.source.billingKind,
        name: plan.source.name,
        quoteId: plan.source.invoiceQuoteId,
      }
      : undefined,
  );
  if (currentSource.sourceSnapshotHash !== plan.source.sourceSnapshotHash) {
    return { ...plan, status: "held", outcome: "held_duplicate_or_ambiguous", contactEventId: null, contactWritesAttempted: 0, holdReason: "Current VTiger customer identity changed after preview; no Xero contact will be created." };
  }
  const auth = await getXeroReadAuthWithRefresh();
  await assertExpectedTenant(auth);
  await requireFinancialCustomerContactLedger();
  const customerKey = sourceKey(plan);
  const idempotencyKey = createHash("sha256").update(`customer-contact-v2:${auth.tenantId}:${customerKey}`).digest("hex");
  const reservation = await reserveFinancialCustomerContactEvent({
    customerKey,
    source: { customerVtigerId: plan.source.customerVtigerId, customerKind: plan.source.billingKind === "organisation" ? "organisation" : "contact", name: plan.source.name, email: plan.source.email, phone: null, sourceSnapshotHash: plan.source.sourceSnapshotHash },
    tenantIdHash: createHash("sha256").update(auth.tenantId).digest("hex"),
    idempotencyKey,
    workflowFamily: "customer_contact_v2",
    sourceSummary: {
      dealId: plan.source.dealId,
      billingKind: plan.source.billingKind,
      organisationName: plan.source.organisationName,
      contactName: plan.source.contactName,
      linkedAccountId: plan.source.linkedAccountId,
      linkedContactId: plan.source.linkedContactId,
      sourceFieldsUsed: plan.source.sourceFieldsUsed,
      resolvedAt: plan.source.resolvedAt,
    },
    lookupSummary: { lookupOrder: plan.lookupOrder, nameMatchCount: plan.nameMatchCount, emailMatchCount: plan.emailMatchCount, includeEmailOnCreate: plan.includeEmailOnCreate },
    outcome: plan.outcome,
  });
  if (reservation.kind === "existing") {
    if (reservation.event.xeroContactId && ["matched", "created"].includes(reservation.event.status)) {
      return { ...plan, status: reservation.event.status === "created" ? "created" : "matched", outcome: "reconciled_existing", contactId: reservation.event.xeroContactId, contactEventId: reservation.event.id, contactWritesAttempted: 0 };
    }
    return { ...plan, status: reservation.event.status === "reconciliation_required" ? "reconciliation_required" : "held", outcome: reservation.event.status === "reconciliation_required" ? "reconciled_existing" : "held_xero_contact_creation_failed", contactEventId: reservation.event.id, contactWritesAttempted: 0, holdReason: "Customer-contact creation is already held or requires reconciliation; no second contact will be created." };
  }
  let contactPostAttempted = false;
  try {
    const fresh = await previewCustomerContactResolution(plan.source);
    if (fresh.status === "matched") {
      await completeFinancialCustomerContactEvent(reservation.event.id, { status: "matched", xeroContactId: fresh.contactId!, evidence: { outcome: fresh.outcome, lookupOrder: fresh.lookupOrder.join(">"), matchedName: fresh.contactName ?? "" }, outcome: fresh.outcome });
      return { ...fresh, status: "matched", contactEventId: reservation.event.id, contactWritesAttempted: 0 };
    }
    if (fresh.status !== "would_create" || fresh.includeEmailOnCreate !== plan.includeEmailOnCreate) {
      await holdFinancialCustomerContactEvent(reservation.event.id, fresh.holdReason ?? "Xero customer contact evidence changed before creation.", false, "held_duplicate_or_ambiguous");
      return { ...fresh, status: "held", outcome: "held_duplicate_or_ambiguous", contactEventId: reservation.event.id, contactWritesAttempted: 0, holdReason: fresh.holdReason ?? "Xero customer contact evidence changed before creation." };
    }
    const body = payload(fresh);
    const response = await runXeroRequest(auth, "POST customer-contact-v2", () => {
      contactPostAttempted = true;
      return axios.post(`${XERO_API_BASE}/Contacts`, body, { headers: { ...headers(auth), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey } });
    }, { retryTransientGatewayFailures: false });
    const created = candidate(response.data?.Contacts?.[0]);
    const errors = Array.isArray(response.data?.Contacts?.[0]?.ValidationErrors) ? response.data.Contacts[0].ValidationErrors : [];
    if (!created?.contactId || errors.length) throw new Error("Xero customer contact creation did not return one ContactID without validation errors.");
    const readback = await runXeroRequest(auth, "GET customer-contact-v2-readback", () => axios.get(`${XERO_API_BASE}/Contacts/${encodeURIComponent(created.contactId)}`, { headers: headers(auth) }));
    const confirmed = candidate(readback.data?.Contacts?.[0]);
    if (!confirmed || confirmed.contactId !== created.contactId || !active(confirmed) || normalizeCustomerName(confirmed.name) !== normalizeCustomerName(fresh.source.name) || (fresh.includeEmailOnCreate && normalizeCustomerEmail(confirmed.email) !== normalizeCustomerEmail(fresh.source.email))) {
      throw new Error("Xero customer contact read-back did not confirm the expected active contact identity.");
    }
    await completeFinancialCustomerContactEvent(reservation.event.id, { status: "created", xeroContactId: confirmed.contactId, evidence: { outcome: "created_contact", lookupOrder: fresh.lookupOrder.join(">"), includeEmail: String(fresh.includeEmailOnCreate), payloadHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") }, outcome: "created_contact" });
    return { ...fresh, status: "created", outcome: "created_contact", contactId: confirmed.contactId, contactName: confirmed.name, contactEventId: reservation.event.id, contactWritesAttempted: 1 };
  } catch (error: any) {
    const uncertain = [502, 503, 504].includes(error?.response?.status);
    const reason = uncertain ? "Xero customer contact creation has an uncertain gateway result; reconcile before any retry." : "Xero customer contact creation failed; no customer invoice Draft was created.";
    await holdFinancialCustomerContactEvent(reservation.event.id, reason, uncertain, "held_xero_contact_creation_failed");
    return { ...plan, status: uncertain ? "reconciliation_required" : "held", outcome: "held_xero_contact_creation_failed", contactEventId: reservation.event.id, contactWritesAttempted: contactPostAttempted ? 1 : 0, holdReason: reason };
  }
}
