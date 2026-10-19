import { createHash } from "node:crypto";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";

export const DEPOSIT_INVOICE_ITEM_CODE = "Deposit Required" as const;
export const DEPOSIT_INVOICE_RULES_VERSION =
  "deposit-invoice-v3-operations-quote-description-sydney-due-date" as const;
export const DEPOSIT_INVOICE_RULES_HASH = createHash("sha256")
  .update(DEPOSIT_INVOICE_RULES_VERSION)
  .digest("hex");
export const DEPOSIT_MAIN_DEDUCTION_HOLD =
  "Main-invoice deposit deduction requires a separate approved, exact-current Draft-only path. This family never amends a main invoice or updates paid Deposit Status in VTiger.";

export type DepositInvoiceFacts = {
  dealId: string;
  dealNumber: string;
  quoteId: string;
  quoteNumber: string;
  depositStatus: string;
  depositAmountRequiredInclusive: number | null;
  customerVtigerId: string;
  customerName: string;
  customerKind: "organisation" | "contact";
  emptyContainerSupplyDate: string;
  fullContainerCollectionDate: string;
  sourceRefreshedAt: string | null;
  customerRefreshedAt: string | null;
  mappingEvidence: Record<string, string>;
  sourceHoldReason: string | null;
};
export type DepositInvoicePreview = {
  eligible: boolean;
  holdReason: string | null;
  proposedInvoiceNumber: string | null;
  dueDateSource:
    | "empty_container_supply_date"
    | "full_container_collection_date"
    | "not_set"
    | null;
  postconditionHold: string;
  document: ProposedFinancialDocument | null;
};

export function depositInvoiceNumber(dealNumber: string): string | null {
  // Never use webservice ID digits or strip arbitrary text into an invoice number.
  const match = dealNumber.trim().match(/^D(\d{1,12})$/i);
  return match ? `INV-${match[1]}-D` : null;
}
function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
export function strictDepositDate(value: string): Date | null {
  const raw = value.trim();
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";
  const australian = raw.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
  const dateOnly = iso || (australian
    ? `${australian[3]!.length === 2 ? `20${australian[3]}` : australian[3]}-${australian[2]}-${australian[1]}`
    : "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === dateOnly
    ? parsed
    : null;
}

function sydneyDateOnly(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** A single isolated invoice; no negative deduction, suffix, adoption or main-invoice amendment. */
export function buildDepositInvoice(
  facts: DepositInvoiceFacts,
  now = new Date()
): DepositInvoicePreview {
  const number = depositInvoiceNumber(facts.dealNumber);
  const held = (reason: string): DepositInvoicePreview => ({
    eligible: false,
    holdReason: reason,
    proposedInvoiceNumber: number,
    dueDateSource: null,
    postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
    document: null,
  });
  if (facts.sourceHoldReason) return held(facts.sourceHoldReason);
  if (!/^\d+x\d+$/i.test(facts.dealId) || !number)
    return held(
      "An exact current VTiger Deal and a D-prefixed Deal number are required."
    );
  if (!["", "PENDING"].includes(facts.depositStatus.trim().toUpperCase()))
    return held("Deposit Status must be blank or PENDING.");
  const amount = facts.depositAmountRequiredInclusive;
  if (
    amount === null ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    money(amount) <= 0
  )
    return held("Deposit Amount Required must be positive and GST-inclusive.");
  if (!/^\d+x\d+$/i.test(facts.customerVtigerId) || !facts.customerName.trim())
    return held(
      "A current Deal customer organisation/contact is required; organisation takes precedence."
    );
  if (
    facts.emptyContainerSupplyDate &&
    !strictDepositDate(facts.emptyContainerSupplyDate)
  )
    return held(
      "Empty Container Supply Date is invalid; no fallback may bypass a populated invalid date."
    );
  if (
    facts.fullContainerCollectionDate &&
    !strictDepositDate(facts.fullContainerCollectionDate)
  )
    return held(
      "Full Container Collection Date is invalid; no fallback may bypass a populated invalid date."
    );
  const dateCandidates = [
    { source: "empty_container_supply_date" as const, value: strictDepositDate(facts.emptyContainerSupplyDate) },
    { source: "full_container_collection_date" as const, value: strictDepositDate(facts.fullContainerCollectionDate) },
  ];
  if (dateCandidates.some((candidate) => candidate.value === null && Boolean(candidate.source === "empty_container_supply_date" ? facts.emptyContainerSupplyDate.trim() : facts.fullContainerCollectionDate.trim()))) {
    return held("A populated Deposit scheduling date is malformed; no date alias or fallback will be guessed.");
  }
  const populated = dateCandidates.filter((candidate) => candidate.value);
  const earliest = populated.sort((a, b) => a.value!.getTime() - b.value!.getTime())[0] ?? null;
  const dueDateSource = earliest?.source ?? "not_set";
  const triggerDate = sydneyDateOnly(now);
  const dueDate = earliest ? addDays(triggerDate, daysBetween(triggerDate, earliest.value!) <= 14 ? 1 : 7) : null;
  const total = money(amount);
  const subtotal = money(total / 1.1);
  return {
    eligible: true,
    holdReason: null,
    proposedInvoiceNumber: number,
    dueDateSource,
    postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
    document: {
      documentFamily: "customer_invoice",
      documentType: "deposit_invoice",
      proposedAction: "create_draft",
      proposedDocumentNumber: number,
      reference: facts.quoteNumber || facts.quoteId,
      partyName: facts.customerName.trim(),
      partySourceId: null,
      // Resolved only from the current Xero Deposit Required SalesDetails, not main-invoice account assumptions.
      accountCode: null,
      gstTreatment: "GST_INCLUSIVE",
      currency: "AUD",
      subtotal,
      taxAmount: money(total - subtotal),
      total,
      issueDate: triggerDate,
      dueDate,
      lineItems: [
        {
          itemCode: DEPOSIT_INVOICE_ITEM_CODE,
          description: `Deposit for ${facts.quoteNumber || facts.quoteId} from ${number.replace(/-D$/, "")}`,
          quantity: 1,
          unitAmount: total,
          lineAmount: total,
          accountCode: "",
          taxRate: 10,
          gstTreatment: "GST_INCLUSIVE",
        },
      ],
      sourceWorkflow: "deposit_invoice",
      sourceRecordId: facts.dealId,
      validationStatus: "valid",
    },
  };
}
