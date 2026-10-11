import { createHash } from "node:crypto";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";

export const DEPOSIT_INVOICE_ITEM_CODE = "Deposit Required" as const;
export const DEPOSIT_INVOICE_RULES_VERSION =
  "deposit-invoice-v1-isolated-operations-readiness" as const;
export const DEPOSIT_INVOICE_RULES_HASH = createHash("sha256")
  .update(DEPOSIT_INVOICE_RULES_VERSION)
  .digest("hex");
export const DEPOSIT_MAIN_DEDUCTION_HOLD =
  "Main-invoice deposit deduction requires a separate approved, exact-current Draft-only path. This family never amends a main invoice or updates paid Deposit Status in VTiger.";

export type DepositInvoiceFacts = {
  dealId: string;
  dealNumber: string;
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
    | "application_current_date_unconfirmed"
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? parsed
    : null;
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
  // The historical sequence is known, but override versus fallback precedence is
  // not evidenced in this repository. Do not guess when dates disagree.
  if (
    facts.emptyContainerSupplyDate &&
    facts.fullContainerCollectionDate &&
    facts.emptyContainerSupplyDate !== facts.fullContainerCollectionDate
  )
    return held(
      "Both supply and collection dates are populated and differ; legacy precedence needs confirmation before release."
    );
  const dateValue =
    facts.emptyContainerSupplyDate || facts.fullContainerCollectionDate;
  if (!dateValue)
    return held(
      "Legacy application-date fallback is not evidenced here; confirm its source/timezone before enabling a no-supply/no-collection Deposit invoice."
    );
  const dueDateSource = facts.emptyContainerSupplyDate
    ? "empty_container_supply_date"
    : "full_container_collection_date";
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
      reference: null,
      partyName: facts.customerName.trim(),
      partySourceId: null,
      // Resolved only from the current Xero Deposit Required SalesDetails, not main-invoice account assumptions.
      accountCode: null,
      gstTreatment: "GST_INCLUSIVE",
      currency: "AUD",
      subtotal,
      taxAmount: money(total - subtotal),
      total,
      issueDate: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      ),
      dueDate: strictDepositDate(dateValue),
      lineItems: [
        {
          itemCode: DEPOSIT_INVOICE_ITEM_CODE,
          description: "Deposit Required",
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
