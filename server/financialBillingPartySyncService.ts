import axios from "axios";
import { getFinancialWorkflowConfig } from "./financialWorkflowDb";
import { financialSha256 } from "./financialProposalIntegrity";
import { getXeroReadAuthWithRefresh } from "./xeroService";
import { runCachedXeroGet, runXeroRequest, XERO_CACHE_TTL } from "./xeroRequestManager";
import {
  executeCustomerContactCreationV2,
  previewCustomerContactResolution,
  type CustomerContactPlan,
} from "./financialCustomerContactServiceV2";
import {
  readCurrentCustomerContactResolution,
  type CustomerContactResolutionSource,
} from "./financialCustomerContactSourceV2";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import {
  billingPartySyncConflictReason,
  getBillingPartySyncEvents as getEvents,
  getBillingPartySyncPendingInvoiceLock,
  getBillingPartySyncMainReceipt,
  recordBillingPartySyncAudit,
  recordBillingPartySyncEvent,
  reserveBillingPartySyncInvoiceLock,
  setBillingPartySyncInvoiceLockState,
} from "./financialBillingPartySyncDb";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
const EXPECTED_AP_TENANT_LABEL = "CONTAINERZONE";
export const BILLING_PARTY_SYNC_RELEASE_KEY = "financial-automation.billing-party-sync-release" as const;
export const BILLING_PARTY_SYNC_RULES_VERSION = "billing-party-sync-v1-contact-id-only" as const;
export const BILLING_PARTY_SYNC_RULES_HASH = financialSha256({
  version: BILLING_PARTY_SYNC_RULES_VERSION,
  scope: "ap-owned-main-inv-deal-only",
  target: "exact-current-vtiger-organisation-first-else-contact",
  transport: "POST /Invoices/{InvoiceID} only InvoiceID InvoiceNumber Type Status Contact.ContactID",
  source: "new_events_only",
  readback: "lines-accounts-quantity-tax-totals-reference-dates-unchanged",
});

export type BillingPartySyncTrigger = "deposit_invoice" | "main_invoice_finalisation";
export type BillingPartySyncStatus =
  | "disabled"
  | "unchanged"
  | "updated"
  | "not_found"
  | "held"
  | "reconciliation_required";

export type BillingPartySyncReleasePolicy = {
  releaseKey: string;
  rulesHash: string;
  enabled: boolean;
  approvedBy: number | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  migrationScope: "new_events_only";
  apOwnedMainReceiptOnly: boolean;
  exactDraftContactIdOnly: boolean;
  sourceRevalidationRequired: boolean;
  tenantBound: boolean;
  preservationReadbackRequired: boolean;
};

export type BillingPartySyncInvoiceSummary = {
  invoiceId: string;
  invoiceNumber: string;
  type: string;
  status: string;
  currencyCode: string;
  contactId: string | null;
  contactName: string | null;
  amountPaid: number;
  amountCredited: number;
  preservationFingerprint: string;
};

export type BillingPartySyncPreview = {
  dealId: string;
  invoiceNumber: string | null;
  source: CustomerContactResolutionSource | null;
  contactPlan: CustomerContactPlan | null;
  invoice: BillingPartySyncInvoiceSummary | null;
  canSync: boolean;
  state: "previewed" | "held" | "not_found";
  holdReason: string | null;
  noWrites: true;
};

export type BillingPartySyncResult = {
  ok: boolean;
  status: BillingPartySyncStatus;
  recordId: string;
  contactId: string | null;
  xeroWritesAttempted: number;
  /** Exact current VTiger billing-party evidence used by a successful result. */
  sourceSnapshotHash?: string;
  warning?: string;
};

type XeroInvoice = Record<string, any>;
type XeroAuth = { token: string; tenantId: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function exactId(value: unknown): string | null {
  const id = text(value);
  return /^\d+x\d+$/i.test(id) ? id : null;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function headers(auth: XeroAuth) {
  return {
    Authorization: `Bearer ${auth.token}`,
    "Xero-tenant-id": auth.tenantId,
    Accept: "application/json",
  };
}

function invoiceNumberForDeal(dealNumber: string): string | null {
  const match = dealNumber.trim().match(/^D(\d{1,12})$/i);
  return match ? `INV-${match[1]}` : null;
}

function invoiceContactId(invoice: XeroInvoice): string | null {
  return text(invoice.Contact?.ContactID) || null;
}

/**
 * A deterministic projection explicitly covers every retained business field
 * required by the release. Complete line-item JSON is retained (including
 * future Xero fields such as DiscountAmount) after removing response-only
 * metadata; Contact is separately asserted and never included in preservation.
 */
export function billingPartyPreservationProjection(invoice: XeroInvoice): Record<string, unknown> {
  const nonBusinessResponseMetadata = new Set([
    "Contact", "Contacts", "HasErrors", "ValidationErrors", "Warnings",
    "StatusAttributeString", "UpdatedDateUTC",
  ]);
  const preserveBusinessJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(preserveBusinessJson);
    if (!value || typeof value !== "object") return value ?? null;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !nonBusinessResponseMetadata.has(key))
      .map(([key, nested]) => [key, preserveBusinessJson(nested)]));
  };
  const lineItems = Array.isArray(invoice.LineItems) ? preserveBusinessJson(invoice.LineItems) : null;
  return {
    InvoiceID: invoice.InvoiceID ?? null,
    InvoiceNumber: invoice.InvoiceNumber ?? null,
    Type: invoice.Type ?? null,
    Status: invoice.Status ?? null,
    CurrencyCode: invoice.CurrencyCode ?? null,
    CurrencyRate: invoice.CurrencyRate ?? null,
    LineAmountTypes: invoice.LineAmountTypes ?? null,
    Date: invoice.Date ?? invoice.DateString ?? null,
    DueDate: invoice.DueDate ?? invoice.DueDateString ?? null,
    PlannedPaymentDate: invoice.PlannedPaymentDate ?? null,
    ExpectedPaymentDate: invoice.ExpectedPaymentDate ?? null,
    Reference: invoice.Reference ?? null,
    BrandingThemeID: invoice.BrandingThemeID ?? null,
    SubTotal: invoice.SubTotal ?? null,
    TotalTax: invoice.TotalTax ?? null,
    Total: invoice.Total ?? null,
    TotalDiscount: invoice.TotalDiscount ?? null,
    AmountDue: invoice.AmountDue ?? null,
    AmountPaid: invoice.AmountPaid ?? null,
    AmountCredited: invoice.AmountCredited ?? null,
    AmountRefunded: invoice.AmountRefunded ?? null,
    FullyPaidOnDate: invoice.FullyPaidOnDate ?? null,
    LineItems: lineItems,
  };
}

export function billingPartyOriginalFingerprint(invoice: XeroInvoice): string {
  return financialSha256({ preservation: billingPartyPreservationProjection(invoice), contactId: invoiceContactId(invoice) });
}

export function verifyBillingPartyReadback(input: {
  original: XeroInvoice;
  readback: XeroInvoice;
  expectedContactId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (text(input.readback.InvoiceID) !== text(input.original.InvoiceID) ||
    text(input.readback.InvoiceNumber).toUpperCase() !== text(input.original.InvoiceNumber).toUpperCase() ||
    text(input.readback.Type).toUpperCase() !== "ACCREC" || text(input.readback.Status).toUpperCase() !== "DRAFT") {
    return { ok: false, reason: "Xero read-back did not return the exact existing Draft customer invoice." };
  }
  if (invoiceContactId(input.readback) !== input.expectedContactId) {
    return { ok: false, reason: "Xero read-back did not confirm the exact target ContactID." };
  }
  if (financialSha256(billingPartyPreservationProjection(input.original)) !== financialSha256(billingPartyPreservationProjection(input.readback))) {
    return { ok: false, reason: "Xero read-back changed a preserved line, account, quantity, tax, total, reference or date; reconciliation is required." };
  }
  return { ok: true };
}

/** Fast no-I/O gate for existing Deposit/final-weight trigger paths; default off. */
export function isBillingPartySyncRuntimeEnabled(): boolean {
  return process.env.FINANCIAL_BILLING_PARTY_SYNC_ENABLED === "true";
}

export function resolveBillingPartySyncRelease(value: unknown): BillingPartySyncReleasePolicy {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<BillingPartySyncReleasePolicy> : {};
  return {
    releaseKey: typeof raw.releaseKey === "string" ? raw.releaseKey : "",
    rulesHash: typeof raw.rulesHash === "string" ? raw.rulesHash : "",
    enabled: raw.enabled === true && raw.migrationScope === "new_events_only",
    approvedBy: Number.isInteger(raw.approvedBy) && Number(raw.approvedBy) > 0 ? Number(raw.approvedBy) : null,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : null,
    effectiveFrom: typeof raw.effectiveFrom === "string" ? raw.effectiveFrom : null,
    migrationScope: "new_events_only",
    apOwnedMainReceiptOnly: raw.apOwnedMainReceiptOnly === true,
    exactDraftContactIdOnly: raw.exactDraftContactIdOnly === true,
    sourceRevalidationRequired: raw.sourceRevalidationRequired === true,
    tenantBound: raw.tenantBound === true,
    preservationReadbackRequired: raw.preservationReadbackRequired === true,
  };
}

export async function getBillingPartySyncReleasePolicy(): Promise<BillingPartySyncReleasePolicy> {
  const configs = await getFinancialWorkflowConfig();
  return resolveBillingPartySyncRelease(configs.find(row => row.configKey === BILLING_PARTY_SYNC_RELEASE_KEY)?.configValue);
}

export function assertBillingPartySyncRelease(policy: BillingPartySyncReleasePolicy): void {
  const approvedAt = policy.approvedAt ? Date.parse(policy.approvedAt) : Number.NaN;
  const effectiveFrom = policy.effectiveFrom ? Date.parse(policy.effectiveFrom) : Number.NaN;
  if (!isBillingPartySyncRuntimeEnabled() || process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED !== "true" || policy.releaseKey !== BILLING_PARTY_SYNC_RELEASE_KEY ||
    policy.rulesHash !== BILLING_PARTY_SYNC_RULES_HASH || !policy.enabled || !policy.approvedBy ||
    !Number.isFinite(approvedAt) || !Number.isFinite(effectiveFrom) || approvedAt > Date.now() || effectiveFrom > Date.now() ||
    policy.migrationScope !== "new_events_only" || !policy.apOwnedMainReceiptOnly || !policy.exactDraftContactIdOnly ||
    !policy.sourceRevalidationRequired || !policy.tenantBound || !policy.preservationReadbackRequired) {
    throw new Error("Billing-party sync release disabled: runtime, Customer Contact v2, exact new-events-only, AP-owned main receipt, tenant binding, source revalidation, ContactID-only Draft payload and preservation read-back approval are all required.");
  }
}

async function assertExpectedTenant(auth: XeroAuth): Promise<void> {
  const response = await runXeroRequest(auth, "GET billing-party-sync-tenant", () => axios.get(`${XERO_API_BASE}/Organisation`, { headers: headers(auth) }));
  const name = text(response.data?.Organisations?.[0]?.Name).toUpperCase();
  if (!name.includes(EXPECTED_AP_TENANT_LABEL)) throw new Error("Connected Xero organisation does not match the expected AP tenant.");
}

function assertPlanTenant(auth: XeroAuth, plan: CustomerContactPlan): void {
  const planTenantId = text((plan as CustomerContactPlan & { tenantId?: unknown }).tenantId);
  if (planTenantId && planTenantId !== auth.tenantId) {
    throw new Error("Current billing-party plan tenant does not match the authenticated Xero tenant.");
  }
}

async function readDealNumber(dealId: string, expectedDealNumber?: string): Promise<{ dealNumber: string; invoiceNumber: string }> {
  if (!exactId(dealId)) throw new Error("Billing-party sync requires an exact VTiger Deal webservice ID.");
  const deal = await retrieveCurrentVtigerFinancialRecord(dealId);
  if (exactId(deal.id) !== dealId) throw new Error("Billing-party sync Deal retrieve did not return the requested exact record.");
  const dealNumber = text(deal.potential_no ?? deal.deal_no);
  if (!dealNumber) throw new Error("Current Deal has no exact Deal number for billing-party sync.");
  if (expectedDealNumber && dealNumber.toUpperCase() !== expectedDealNumber.trim().toUpperCase()) {
    throw new Error("Current Deal number no longer matches the exact requested lookup.");
  }
  const invoiceNumber = invoiceNumberForDeal(dealNumber);
  if (!invoiceNumber) throw new Error("Current Deal number cannot produce a bounded INV-<Deal> main invoice number.");
  return { dealNumber, invoiceNumber };
}

async function readExactMainInvoice(auth: XeroAuth, invoiceNumber: string): Promise<
  { kind: "not_found" } | { kind: "ambiguous"; reason: string } | { kind: "found"; invoice: XeroInvoice }
> {
  const data = await runCachedXeroGet<any>(
    auth,
    `billing-party-sync-main:${invoiceNumber.toUpperCase()}`,
    XERO_CACHE_TTL.invoiceSearch,
    () => axios.get(`${XERO_API_BASE}/Invoices`, { headers: headers(auth), params: { InvoiceNumbers: invoiceNumber } }),
    { forceRefresh: true },
  );
  const matches = (Array.isArray(data?.Invoices) ? data.Invoices : []).filter((invoice: any) =>
    text(invoice?.InvoiceNumber).toUpperCase() === invoiceNumber.toUpperCase(),
  );
  if (!matches.length) return { kind: "not_found" };
  if (matches.length !== 1) return { kind: "ambiguous", reason: `Xero returned ${matches.length} exact-number records for ${invoiceNumber}; no record will be selected.` };
  return { kind: "found", invoice: matches[0] as XeroInvoice };
}

function invoiceSummary(invoice: XeroInvoice): BillingPartySyncInvoiceSummary {
  return {
    invoiceId: text(invoice.InvoiceID),
    invoiceNumber: text(invoice.InvoiceNumber),
    type: text(invoice.Type).toUpperCase(),
    status: text(invoice.Status).toUpperCase(),
    currencyCode: text(invoice.CurrencyCode).toUpperCase(),
    contactId: invoiceContactId(invoice),
    contactName: text(invoice.Contact?.Name) || null,
    amountPaid: number(invoice.AmountPaid),
    amountCredited: number(invoice.AmountCredited),
    preservationFingerprint: billingPartyOriginalFingerprint(invoice),
  };
}

function targetContactId(plan: CustomerContactPlan | null): string | null {
  return plan?.status === "matched" && plan.contactId ? plan.contactId : null;
}

function validUpdateTarget(invoice: XeroInvoice): string | null {
  if (text(invoice.Type).toUpperCase() !== "ACCREC") return "Exact Xero number belongs to a non-customer-invoice record; no contact change is permitted.";
  if (text(invoice.Status).toUpperCase() !== "DRAFT") return "Main Xero invoice has a different billing ContactID but is not Draft; no contact change is permitted.";
  if (text(invoice.CurrencyCode).toUpperCase() !== "AUD") return "Main Xero Draft is not AUD; no contact change is permitted.";
  if (number(invoice.AmountPaid) !== 0 || number(invoice.AmountCredited) !== 0) return "Main Xero Draft has paid or credited value; no contact change is permitted.";
  if (!text(invoice.InvoiceID) || !text(invoice.InvoiceNumber)) return "Main Xero Draft lacks an exact immutable invoice ID or number.";
  return null;
}

function safeSourceSnapshot(source: CustomerContactResolutionSource, dealNumber: string) {
  return {
    dealId: source.dealId,
    dealNumber,
    billingKind: source.billingKind,
    customerVtigerId: source.customerVtigerId,
    organisationName: source.organisationName,
    contactName: source.contactName,
    name: source.name,
    linkedAccountId: source.linkedAccountId,
    linkedContactId: source.linkedContactId,
    sourceFieldsUsed: source.sourceFieldsUsed,
    resolvedAt: source.resolvedAt,
    sourceSnapshotHash: source.sourceSnapshotHash,
  };
}

function safeTargetEvidence(plan: CustomerContactPlan) {
  return {
    contactId: plan.contactId,
    contactName: plan.contactName,
    billingKind: plan.source.billingKind,
    lookupOrder: plan.lookupOrder,
    outcome: plan.outcome,
    sourceSnapshotHash: plan.source.sourceSnapshotHash,
  };
}

async function assertFreshTargetContact(auth: XeroAuth, contactId: string): Promise<void> {
  const response = await runXeroRequest(auth, "GET billing-party-sync-target-contact", () => axios.get(
    `${XERO_API_BASE}/Contacts/${encodeURIComponent(contactId)}`,
    { headers: headers(auth) },
  ));
  const contact = response.data?.Contacts?.[0];
  if (text(contact?.ContactID) !== contactId || text(contact?.ContactStatus).toUpperCase() !== "ACTIVE") {
    throw new Error("Fresh Xero target contact read did not confirm the exact active ContactID.");
  }
}

function isUncertainTransport(error: unknown): boolean {
  const status = (error as any)?.response?.status;
  return !status || [502, 503, 504].includes(status);
}

function heldResult(dealId: string, contactId: string | null, warning: string, writes = 0, reconciliation = false): BillingPartySyncResult {
  return { ok: false, status: reconciliation ? "reconciliation_required" : "held", recordId: dealId, contactId, xeroWritesAttempted: writes, warning };
}

function alert(dealId: string, invoiceId: string | null, title: string, warning: string, severity: "warning" | "error" = "warning") {
  reportWorkflowFailureSafely({
    workflowType: "billing-party-sync",
    recordKey: `${dealId}:${invoiceId ?? "no-invoice"}`,
    title,
    errorMessage: warning,
    details: { dealId, xeroInvoiceId: invoiceId },
    severity,
  });
}

async function auditOutcome(input: {
  dealId: string;
  invoiceId?: string | null;
  eventFingerprint?: string | null;
  outcome: "updated" | "unchanged" | "not_found" | "held" | "reconciliation_required" | "disabled";
  details?: unknown;
}) {
  await recordBillingPartySyncAudit({
    dealId: input.dealId,
    xeroInvoiceId: input.invoiceId ?? null,
    eventFingerprint: input.eventFingerprint ?? null,
    action: "outcome",
    outcome: input.outcome,
    details: input.details,
  });
}

/** Read-only source + exact-number Xero evidence. It creates no local receipt and never writes Xero or VTiger. */
export async function previewBillingPartySync(dealId: string, expectedDealNumber?: string): Promise<BillingPartySyncPreview> {
  let source: CustomerContactResolutionSource | null = null;
  let contactPlan: CustomerContactPlan | null = null;
  let invoiceNumber: string | null = null;
  try {
    const identity = await readDealNumber(dealId, expectedDealNumber);
    invoiceNumber = identity.invoiceNumber;
    source = await readCurrentCustomerContactResolution(dealId);
    contactPlan = await previewCustomerContactResolution(source);
    const auth = await getXeroReadAuthWithRefresh();
    await assertExpectedTenant(auth);
    const target = await readExactMainInvoice(auth, identity.invoiceNumber);
    if (target.kind === "not_found") return { dealId, invoiceNumber, source, contactPlan, invoice: null, canSync: false, state: "not_found", holdReason: null, noWrites: true };
    if (target.kind === "ambiguous") return { dealId, invoiceNumber, source, contactPlan, invoice: null, canSync: false, state: "held", holdReason: target.reason, noWrites: true };
    const invoice = target.invoice;
    const desiredContactId = targetContactId(contactPlan);
    const updateReason = validUpdateTarget(invoice);
    const current = invoiceContactId(invoice);
    let ownershipOrConflictReason: string | null = null;
    if (desiredContactId && desiredContactId !== current && !updateReason) {
      const receipt = await getBillingPartySyncMainReceipt(dealId);
      if (!receipt || receipt.status !== "drafts_created" || receipt.proposedInvoiceNumber.toUpperCase() !== identity.invoiceNumber.toUpperCase() || receipt.xeroInvoiceId !== text(invoice.InvoiceID)) {
        ownershipOrConflictReason = "Exact main Draft is not an AP-owned completed Main Customer Invoice receipt for this Deal; preview remains read-only.";
      } else {
        ownershipOrConflictReason = await billingPartySyncConflictReason(dealId, text(invoice.InvoiceID));
      }
    }
    const canSync = Boolean(desiredContactId && desiredContactId !== current && !updateReason && !ownershipOrConflictReason && text(invoice.InvoiceNumber).toUpperCase() === identity.invoiceNumber.toUpperCase());
    const reason = contactPlan.status === "held"
      ? contactPlan.holdReason ?? "Billing-party contact resolution is held."
      : contactPlan.status === "would_create"
        ? "Billing-party contact creation is needed; preview remains read-only."
        : desiredContactId === current ? null : updateReason ?? ownershipOrConflictReason;
    return { dealId, invoiceNumber, source, contactPlan, invoice: invoiceSummary(invoice), canSync, state: reason ? "held" : "previewed", holdReason: reason, noWrites: true };
  } catch (error) {
    return { dealId, invoiceNumber, source, contactPlan, invoice: null, canSync: false, state: "held", holdReason: error instanceof Error ? error.message : "Billing-party sync preview could not be completed.", noWrites: true };
  }
}

/**
 * Resolves the organisation-first (else individual) billing party using v2,
 * then changes only the ContactID of an AP-owned exact INV-<Deal> main Draft.
 * It has no retry path after local submission and is inaccessible while either
 * the runtime environment or independently approved policy is off.
 */
export async function processAutomaticBillingPartySync(
  dealId: string,
  trigger: BillingPartySyncTrigger,
): Promise<BillingPartySyncResult> {
  if (!isBillingPartySyncRuntimeEnabled()) {
    return { ok: false, status: "disabled", recordId: dealId, contactId: null, xeroWritesAttempted: 0, warning: "Billing-party sync is disabled by FINANCIAL_BILLING_PARTY_SYNC_ENABLED." };
  }

  let writes = 0;
  let contactId: string | null = null;
  let invoiceId: string | null = null;
  let eventFingerprint: string | null = null;
  let submittedLockId: number | null = null;
  let invoicePostAttempted = false;
  try {
    const policy = await getBillingPartySyncReleasePolicy();
    try {
      assertBillingPartySyncRelease(policy);
    } catch (error) {
      const warning = error instanceof Error ? error.message : "Billing-party sync release is disabled.";
      await auditOutcome({ dealId, outcome: "disabled", details: { trigger, warning } });
      return { ok: false, status: "disabled", recordId: dealId, contactId: null, xeroWritesAttempted: 0, warning };
    }

    const identity = await readDealNumber(dealId);
    let source = await readCurrentCustomerContactResolution(dealId);
    if (!Number.isFinite(Date.parse(source.resolvedAt)) || Date.parse(source.resolvedAt) < Date.parse(policy.effectiveFrom!)) {
      const warning = "Current Deal customer source predates the approved new-events-only billing-party-sync cutover; no historical backfill.";
      await auditOutcome({ dealId, outcome: "held", details: { trigger, warning } });
      alert(dealId, null, "Billing-party sync held by new-events-only cutover", warning);
      return heldResult(dealId, null, warning);
    }

    let plan = await previewCustomerContactResolution(source);
    if (plan.status === "held") {
      const warning = plan.holdReason ?? "Billing-party contact resolution is held.";
      await auditOutcome({ dealId, outcome: "held", details: { trigger, warning } });
      alert(dealId, null, "Billing-party contact resolution held", warning);
      return heldResult(dealId, null, warning);
    }
    if (plan.status === "would_create") {
      const created = await executeCustomerContactCreationV2(plan);
      writes += created.contactWritesAttempted;
      if (created.status === "would_create" || created.status === "held" || created.status === "reconciliation_required") {
        const warning = created.holdReason ?? "Billing-party contact creation remains held by its independent v2 gate.";
        const reconciliation = created.status === "reconciliation_required";
        await auditOutcome({ dealId, outcome: reconciliation ? "reconciliation_required" : "held", details: { trigger, warning } });
        alert(dealId, null, reconciliation ? "Billing-party contact creation requires reconciliation" : "Billing-party contact creation held", warning);
        return heldResult(dealId, null, warning, writes, reconciliation);
      }
      // Creation invalidates source/contact evidence. Re-read exact source and repeat
      // the existing v2 decision before looking up or modifying an invoice.
      const refreshed = await readCurrentCustomerContactResolution(dealId);
      if (refreshed.sourceSnapshotHash !== source.sourceSnapshotHash) {
        const warning = "Current VTiger billing-party source changed after v2 contact resolution; no main Draft will be altered.";
        await auditOutcome({ dealId, outcome: "held", details: { trigger, warning } });
        alert(dealId, null, "Billing-party source changed after contact resolution", warning);
        return heldResult(dealId, created.contactId ?? null, warning, writes);
      }
      source = refreshed;
      plan = await previewCustomerContactResolution(source);
    }
    contactId = targetContactId(plan);
    if (!contactId) {
      const warning = plan.holdReason ?? "Current billing-party resolution did not return one exact Xero ContactID.";
      await auditOutcome({ dealId, outcome: "held", details: { trigger, warning } });
      alert(dealId, null, "Billing-party target contact is not exact", warning);
      return heldResult(dealId, null, warning, writes);
    }

    const auth = await getXeroReadAuthWithRefresh();
    assertPlanTenant(auth, plan);
    await assertExpectedTenant(auth);
    const lookup = await readExactMainInvoice(auth, identity.invoiceNumber);
    if (lookup.kind === "not_found") {
      await auditOutcome({ dealId, outcome: "not_found", details: { trigger, invoiceNumber: identity.invoiceNumber, targetContactId: contactId } });
      return { ok: true, status: "not_found", recordId: dealId, contactId, xeroWritesAttempted: writes, sourceSnapshotHash: source.sourceSnapshotHash };
    }
    if (lookup.kind === "ambiguous") {
      await auditOutcome({ dealId, outcome: "held", details: { trigger, warning: lookup.reason, invoiceNumber: identity.invoiceNumber } });
      alert(dealId, null, "Billing-party main invoice lookup ambiguous", lookup.reason);
      return heldResult(dealId, contactId, lookup.reason, writes);
    }

    const original = lookup.invoice;
    invoiceId = text(original.InvoiceID) || null;
    if (!invoiceId) {
      const warning = "Exact main invoice result has no immutable InvoiceID.";
      await auditOutcome({ dealId, outcome: "held", details: { trigger, warning } });
      alert(dealId, null, "Billing-party main invoice lacks exact ID", warning);
      return heldResult(dealId, contactId, warning, writes);
    }
    if (text(original.Type).toUpperCase() !== "ACCREC") {
      const warning = "Exact INV-<Deal> record is not an ACCREC customer invoice; no contact change is permitted.";
      await auditOutcome({ dealId, invoiceId, outcome: "held", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party target is not ACCREC", warning);
      return heldResult(dealId, contactId, warning, writes);
    }
    if (invoiceContactId(original) === contactId) {
      const pendingLock = await getBillingPartySyncPendingInvoiceLock(invoiceId);
      if (pendingLock) {
        const warning = "Billing-party sync has a pending invoice lock while this Draft appears current; reconciliation must finish before treating it as unchanged.";
        const reconciliation = pendingLock.state === "reconciliation_required";
        await auditOutcome({ dealId, invoiceId, outcome: reconciliation ? "reconciliation_required" : "held", details: { trigger, warning, lockState: pendingLock.state } });
        alert(dealId, invoiceId, "Billing-party unchanged result blocked by pending lock", warning, reconciliation ? "error" : "warning");
        return heldResult(dealId, contactId, warning, writes, reconciliation);
      }
      await auditOutcome({ dealId, invoiceId, outcome: "unchanged", details: { trigger, invoiceNumber: identity.invoiceNumber, targetContactId: contactId } });
      return { ok: true, status: "unchanged", recordId: dealId, contactId, xeroWritesAttempted: writes, sourceSnapshotHash: source.sourceSnapshotHash };
    }
    const targetReason = validUpdateTarget(original);
    if (targetReason) {
      await auditOutcome({ dealId, invoiceId, outcome: "held", details: { trigger, warning: targetReason } });
      alert(dealId, invoiceId, "Billing-party main Draft cannot be changed", targetReason);
      return heldResult(dealId, contactId, targetReason, writes);
    }

    const receipt = await getBillingPartySyncMainReceipt(dealId);
    if (!receipt || receipt.status !== "drafts_created" || receipt.proposedInvoiceNumber.toUpperCase() !== identity.invoiceNumber.toUpperCase() || receipt.xeroInvoiceId !== invoiceId) {
      const warning = "Exact main Draft is not an AP-owned completed Main Customer Invoice receipt for this Deal; automatic billing-party mutation will not adopt legacy or unowned invoices.";
      await auditOutcome({ dealId, invoiceId, outcome: "held", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party main invoice ownership is unverified", warning);
      return heldResult(dealId, contactId, warning, writes);
    }
    const conflict = await billingPartySyncConflictReason(dealId, invoiceId);
    if (conflict) {
      await auditOutcome({ dealId, invoiceId, outcome: "held", details: { trigger, warning: conflict } });
      alert(dealId, invoiceId, "Billing-party sync conflict", conflict);
      return heldResult(dealId, contactId, conflict, writes);
    }

    const originalContactId = invoiceContactId(original);
    if (!originalContactId) {
      const warning = "Main Xero Draft has no exact original ContactID; automatic billing-party mutation is not permitted.";
      await auditOutcome({ dealId, invoiceId, outcome: "held", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party original contact is not exact", warning);
      return heldResult(dealId, contactId, warning, writes);
    }
    const originalFingerprint = billingPartyOriginalFingerprint(original);
    const payload = {
      Invoices: [{
        InvoiceID: invoiceId,
        InvoiceNumber: identity.invoiceNumber,
        Type: "ACCREC",
        Status: "DRAFT",
        Contact: { ContactID: contactId },
      }],
    };
    eventFingerprint = financialSha256({ tenantId: auth.tenantId, invoiceId, sourceSnapshotHash: source.sourceSnapshotHash, targetContactId: contactId, originalInvoiceFingerprint: originalFingerprint });
    const payloadFingerprint = financialSha256(payload);
    await recordBillingPartySyncEvent({
      eventFingerprint,
      dealId,
      trigger,
      tenantIdHash: financialSha256(auth.tenantId),
      xeroInvoiceId: invoiceId,
      invoiceNumber: identity.invoiceNumber,
      sourceSnapshotHash: source.sourceSnapshotHash,
      targetContactId: contactId,
      originalContactId,
      originalInvoiceFingerprint: originalFingerprint,
      payloadFingerprint,
      rulesSnapshotHash: BILLING_PARTY_SYNC_RULES_HASH,
      sourceSnapshot: safeSourceSnapshot(source, identity.dealNumber) as any,
      originalInvoiceSnapshot: billingPartyPreservationProjection(original) as any,
      targetContactEvidence: safeTargetEvidence(plan) as any,
    });
    const reservation = await reserveBillingPartySyncInvoiceLock({ xeroInvoiceId: invoiceId, eventFingerprint, dealId, targetContactId: contactId, originalContactId });
    if (reservation.kind !== "reserved") {
      const warning = reservation.lock.state === "reconciliation_required" || reservation.lock.state === "submitted"
        ? "Billing-party sync has an existing uncertain or submitted invoice lock; reconciliation is required and no retry will occur."
        : "Billing-party sync invoice lock already exists for this exact invoice; no second automatic A→B/B→C contact mutation is permitted.";
      const reconciliation = reservation.lock.state === "reconciliation_required" || reservation.lock.state === "submitted";
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: reconciliation ? "reconciliation_required" : "held", details: { trigger, warning, lockState: reservation.lock.state } });
      alert(dealId, invoiceId, reconciliation ? "Billing-party sync locked for reconciliation" : "Billing-party sync invoice lock already exists", warning);
      return heldResult(dealId, contactId, warning, writes, reconciliation);
    }
    await recordBillingPartySyncAudit({ dealId, xeroInvoiceId: invoiceId, eventFingerprint, action: "reserved", outcome: "held", details: { trigger, targetContactId: contactId } });

    // Final exact source + target contact + invoice revalidation immediately before POST.
    const currentSource = await readCurrentCustomerContactResolution(dealId);
    if (currentSource.sourceSnapshotHash !== source.sourceSnapshotHash) {
      const warning = "Current VTiger billing-party source changed immediately before Xero POST; no main Draft was altered.";
      await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["reserved"], to: "held" });
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "held", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party source changed before POST", warning);
      return heldResult(dealId, contactId, warning, writes);
    }
    const currentPlan = await previewCustomerContactResolution(currentSource);
    if (targetContactId(currentPlan) !== contactId) {
      const warning = "Fresh v2 billing-party resolution no longer returns the exact target ContactID; no main Draft was altered.";
      await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["reserved"], to: "held" });
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "held", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party target changed before POST", warning);
      return heldResult(dealId, contactId, warning, writes);
    }
    assertPlanTenant(auth, currentPlan);
    await assertFreshTargetContact(auth, contactId);
    const currentInvoice = await readExactMainInvoice(auth, identity.invoiceNumber);
    if (currentInvoice.kind !== "found" || text(currentInvoice.invoice.InvoiceID) !== invoiceId || billingPartyOriginalFingerprint(currentInvoice.invoice) !== originalFingerprint) {
      const warning = "Exact Xero Draft ID or original fingerprint changed immediately before POST; reconciliation is required and no contact mutation was sent.";
      await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["reserved"], to: "held" });
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "held", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party Xero pre-POST guard changed", warning);
      return heldResult(dealId, contactId, warning, writes);
    }

    if (!(await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["reserved"], to: "submitted" }))) {
      const warning = "Billing-party invoice lock was lost before POST; no contact mutation was sent.";
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "held", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party invoice lock lost before POST", warning);
      return heldResult(dealId, contactId, warning, writes);
    }
    submittedLockId = reservation.lock.id;
    await recordBillingPartySyncAudit({ dealId, xeroInvoiceId: invoiceId, eventFingerprint, action: "submitted", outcome: "held", details: { trigger, payloadFingerprint } });

    try {
      // No transport retry: a response-loss result is ambiguous and the lock is held.
      const exactInvoiceId = invoiceId;
      if (!exactInvoiceId) throw new Error("Billing-party invoice ID was lost before Xero POST.");
      await runXeroRequest(auth, `POST billing-party-sync:${invoiceId}`, async () => {
        // Never nest a managed Xero read in its own tenant queue. These are
        // VTiger/local ledger reads; all Xero evidence was force-refreshed above.
        const latestPolicy = await getBillingPartySyncReleasePolicy();
        assertBillingPartySyncRelease(latestPolicy);
        if (financialSha256(latestPolicy) !== financialSha256(policy)) {
          throw new Error("Billing-party policy changed while awaiting transport; no contact update was sent.");
        }
        const latestSource = await readCurrentCustomerContactResolution(dealId);
        if (latestSource.sourceSnapshotHash !== source.sourceSnapshotHash) {
          throw new Error("VTiger billing party changed while awaiting transport; no contact update was sent.");
        }
        const latestReceipt = await getBillingPartySyncMainReceipt(dealId);
        if (!latestReceipt || latestReceipt.status !== "drafts_created" ||
          latestReceipt.proposedInvoiceNumber.toUpperCase() !== identity.invoiceNumber.toUpperCase() ||
          latestReceipt.xeroInvoiceId !== exactInvoiceId) {
          throw new Error("Exact AP-owned Main receipt changed while awaiting transport; no contact update was sent.");
        }
        const latestConflict = await billingPartySyncConflictReason(dealId, exactInvoiceId);
        if (latestConflict) throw new Error(latestConflict);
        // Invocation, not response, is the attempted-write boundary.
        invoicePostAttempted = true;
        writes += 1;
        return axios.post(
          `${XERO_API_BASE}/Invoices/${encodeURIComponent(exactInvoiceId)}`,
          payload,
          { timeout: 30_000, headers: { ...headers(auth), "Content-Type": "application/json", "Idempotency-Key": `bps-${payloadFingerprint}`.slice(0, 128) } },
        );
      }, { retryTransientGatewayFailures: false });
    } catch (error) {
      const uncertain = invoicePostAttempted && isUncertainTransport(error);
      const warning = uncertain
        ? "Billing-party contact POST has an unknown transport outcome; reconciliation is required and no retry will occur."
        : `Billing-party contact POST was rejected before a confirmed update: ${error instanceof Error ? error.message : String(error)}`;
      await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["submitted"], to: uncertain ? "reconciliation_required" : "held" });
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: uncertain ? "reconciliation_required" : "held", details: { trigger, warning } });
      alert(dealId, invoiceId, uncertain ? "Billing-party Xero POST requires reconciliation" : "Billing-party Xero POST rejected", warning, uncertain ? "error" : "warning");
      return heldResult(dealId, contactId, warning, writes, uncertain);
    }

    const readback = await readExactMainInvoice(auth, identity.invoiceNumber);
    if (readback.kind !== "found" || text(readback.invoice.InvoiceID) !== invoiceId) {
      const warning = "Billing-party contact POST returned but exact Xero read-back is absent or changed; reconciliation is required.";
      await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["submitted"], to: "reconciliation_required" });
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "reconciliation_required", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party Xero read-back missing", warning, "error");
      return heldResult(dealId, contactId, warning, writes, true);
    }
    const verified = verifyBillingPartyReadback({ original, readback: readback.invoice, expectedContactId: contactId });
    if (!verified.ok) {
      await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["submitted"], to: "reconciliation_required" });
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "reconciliation_required", details: { trigger, warning: verified.reason } });
      alert(dealId, invoiceId, "Billing-party read-back preservation failed", verified.reason, "error");
      return heldResult(dealId, contactId, verified.reason, writes, true);
    }
    const readbackProjection = billingPartyPreservationProjection(readback.invoice);
    await recordBillingPartySyncAudit({
      dealId,
      xeroInvoiceId: invoiceId,
      eventFingerprint,
      action: "outcome",
      outcome: "updated",
      details: {
        trigger,
        readbackContactId: invoiceContactId(readback.invoice),
        readbackFingerprint: billingPartyOriginalFingerprint(readback.invoice),
        retainedBusinessFieldsHash: financialSha256(readbackProjection),
      },
    });
    if (!(await setBillingPartySyncInvoiceLockState({ lockId: reservation.lock.id, eventFingerprint, from: ["submitted"], to: "updated" }))) {
      const warning = "Billing-party verified read-back could not finalize its submitted lock; reconciliation is required.";
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "reconciliation_required", details: { trigger, warning } });
      alert(dealId, invoiceId, "Billing-party verified lock finalization failed", warning, "error");
      return heldResult(dealId, contactId, warning, writes, true);
    }
    submittedLockId = null;
    await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "updated", details: { trigger, invoiceNumber: identity.invoiceNumber, targetContactId: contactId } });
    return { ok: true, status: "updated", recordId: dealId, contactId, xeroWritesAttempted: writes, sourceSnapshotHash: source.sourceSnapshotHash };
  } catch (error) {
    const warning = error instanceof Error ? error.message : "Billing-party sync failed before a confirmed Xero mutation.";
    if (invoiceId && submittedLockId !== null && eventFingerprint) {
      await setBillingPartySyncInvoiceLockState({ lockId: submittedLockId, eventFingerprint, from: ["submitted"], to: "reconciliation_required" }).catch(() => undefined);
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "reconciliation_required", details: { trigger, warning } }).catch(() => undefined);
      alert(dealId, invoiceId, "Billing-party submitted operation requires reconciliation", warning, "error");
      return heldResult(dealId, contactId, warning, writes, true);
    }
    if (invoiceId) {
      await auditOutcome({ dealId, invoiceId, eventFingerprint, outcome: "held", details: { trigger, warning } }).catch(() => undefined);
      alert(dealId, invoiceId, "Billing-party sync failed", warning, "error");
    }
    return heldResult(dealId, contactId, warning, writes);
  }
}

/** Read-only readiness report; it does not activate policy, routes or schedules. */
export async function getBillingPartySyncReadiness() {
  const policy = await getBillingPartySyncReleasePolicy();
  let releaseHoldReason: string | null = null;
  try {
    assertBillingPartySyncRelease(policy);
  } catch (error) {
    releaseHoldReason = error instanceof Error ? error.message : "Billing-party sync release is disabled.";
  }
  return {
    runtimeEnabled: isBillingPartySyncRuntimeEnabled(),
    writerEnabled: releaseHoldReason === null,
    releaseHoldReason,
    policy,
    rulesHash: BILLING_PARTY_SYNC_RULES_HASH,
    migrationScope: "new_events_only" as const,
    apOwnedMainReceiptOnly: true,
    noWrites: true as const,
  };
}

export { getEvents as getBillingPartySyncEvents };
export default processAutomaticBillingPartySync;
