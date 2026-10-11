import { createHash } from "node:crypto";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";

export const EXTRA_HIRE_RULES_VERSION =
  "extra-hire-v1-exact-source-EH-ap-ordinal";
export const EXTRA_HIRE_RULES_HASH = createHash("sha256")
  .update(EXTRA_HIRE_RULES_VERSION)
  .digest("hex");
export const EXTRA_HIRE_WEEKS = 4.286;
export const EXTRA_HIRE_SUFFIX_SCHEME = "EH_AP_ORDINAL_V1";
export const money = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
export function extraHireDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
}
export function extendExtraHireDate(value: string): string {
  if (!extraHireDate(value))
    throw new Error("Exact ISO Hire End Date required.");
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}
export type ExtraHireFacts = {
  dealId: string;
  dealNumber: string;
  containerNumber: string;
  containerType: string;
  containerFeet: 20 | 40 | null;
  hireDuration: number | null;
  hireEndDate: string | null;
  customerVtigerId: string;
  customerName: string;
  customerKind: "organisation" | "contact";
  sourceRefreshedAt: string | null;
  customerRefreshedAt: string | null;
  mappingEvidence: Record<string, string>;
  sourceHoldReason: string | null;
};
export type ExtraHireClaim = {
  ordinal: number | null;
  claimedInvoiceNumber: string | null;
  sourceHireEndDate: string | null;
  status: string;
  xeroInvoiceId: string | null;
};
export type ExtraHireHistoryRow = {
  InvoiceNumber: string;
  InvoiceID: string;
  Status: string;
  Type: string;
};
/** Never searches for the next free suffix. A collision at the exact ordinal is a HOLD, not a skip/adoption. */
export function deriveExtraHireInvoiceNumber(
  dealNumber: string,
  hireEndDate: string,
  history: ExtraHireHistoryRow[],
  claims: ExtraHireClaim[],
  schemeConfirmed: boolean
) {
  const held = (holdReason: string) => ({
    ordinal: null,
    invoiceNumber: null,
    holdReason,
  });
  if (!/^D\d{1,12}$/.test(dealNumber) || !extraHireDate(hireEndDate))
    return held("Exact D-number and current Hire End Date required.");
  if (!schemeConfirmed)
    return held(
      "Legacy suffix/revision semantics are not proven; the separate EH AP ordinal scheme must be explicitly approved. Deposit owns -D."
    );
  const base = `INV-${dealNumber.slice(1)}-EH`;
  const live = claims.filter(c => c.claimedInvoiceNumber !== null);
  if (live.some(c => c.status !== "drafts_created" || !c.xeroInvoiceId))
    return held(
      "Prior AP Extra Hire claim is pending or uncertain; reconcile before another period."
    );
  const sorted = [...live].sort(
    (a, b) => Number(a.ordinal) - Number(b.ordinal)
  );
  if (
    sorted.some(
      (c, i) =>
        c.ordinal !== i + 1 || c.claimedInvoiceNumber !== `${base}${i + 1}`
    )
  )
    return held("AP Extra Hire ordinal history is incomplete or ambiguous.");
  if (live.some(c => c.sourceHireEndDate === hireEndDate))
    return held(
      "This Hire End Date already has an AP claim; it must never be invoiced again."
    );
  if (sorted.some(c => !extraHireDate(c.sourceHireEndDate)))
    return held(
      "Prior AP Extra Hire source period is invalid; reconcile rather than infer an ordinal."
    );
  if (
    sorted.length &&
    extendExtraHireDate(sorted.at(-1)!.sourceHireEndDate ?? "") !== hireEndDate
  )
    return held(
      "Current Hire End Date does not follow the prior verified AP period by exactly 30 calendar days."
    );
  const series = history.filter(row =>
    row.InvoiceNumber.toUpperCase().startsWith(base)
  );
  if (
    series.some(
      row =>
        !live.some(
          c =>
            c.claimedInvoiceNumber === row.InvoiceNumber &&
            c.xeroInvoiceId === row.InvoiceID &&
            row.Type === "ACCREC" &&
            row.Status === "DRAFT"
        )
    )
  )
    return held(
      "Xero Extra Hire series contains an unowned, changed, deleted/voided or ambiguous invoice; no historical invoice can be adopted."
    );
  if (
    live.some(
      c =>
        history.filter(
          row =>
            row.InvoiceNumber === c.claimedInvoiceNumber &&
            row.InvoiceID === c.xeroInvoiceId
        ).length !== 1
    )
  )
    return held(
      "Prior AP Draft is missing or duplicated in current Xero history."
    );
  const ordinal = sorted.length + 1;
  const invoiceNumber = `${base}${ordinal}`;
  if (
    history.some(
      row => row.InvoiceNumber.trim().toUpperCase() === invoiceNumber
    )
  )
    return held(
      "Exact Extra Hire invoice number collision, including deleted/voided history; never skip or adopt."
    );
  return { ordinal, invoiceNumber, holdReason: null };
}
export type ExtraHireItemEvidence = {
  itemCode: "20' Hire" | "40' Hire";
  unitAmount: number;
  accountCode: string;
  taxType: "OUTPUT";
};
export type ExtraHirePreview = {
  eligible: boolean;
  holdReason: string | null;
  document: ProposedFinancialDocument | null;
  proposedInvoiceNumber: string | null;
};
export function buildExtraHireInvoice(
  facts: ExtraHireFacts,
  invoiceNumber: string | null,
  item: ExtraHireItemEvidence | null,
  dateSemantics: string | null
): ExtraHirePreview {
  const hold = (reason: string): ExtraHirePreview => ({
    eligible: false,
    holdReason: reason,
    document: null,
    proposedInvoiceNumber: invoiceNumber,
  });
  if (facts.sourceHoldReason) return hold(facts.sourceHoldReason);
  if (
    !/^\d+x\d{1,12}$/.test(facts.dealId) ||
    !/^D\d{1,12}$/.test(facts.dealNumber) ||
    !facts.containerNumber.trim()
  )
    return hold("Exact named current Deal/D-number/container required.");
  if (
    facts.hireDuration !== 30 ||
    !facts.hireEndDate ||
    !extraHireDate(facts.hireEndDate)
  )
    return hold(
      "Only Hire Duration 30 with a valid current ISO Hire End Date is eligible."
    );
  if (
    !facts.containerFeet ||
    !/^\d+x\d+$/.test(facts.customerVtigerId) ||
    !facts.customerName.trim() ||
    !facts.sourceRefreshedAt
  )
    return hold(
      "Supported 20/40 container, exact customer and current Deal modified timestamp required."
    );
  if (dateSemantics !== "CURRENT_HIRE_END_DATE_NO_DUE_DATE")
    return hold(
      "Extra Hire issue/due-date business semantics are unconfirmed; no today/application date is guessed."
    );
  if (
    !invoiceNumber ||
    !new RegExp(`^INV-${facts.dealNumber.slice(1)}-EH[1-9]\\d*$`).test(
      invoiceNumber
    )
  )
    return hold(
      "Exact approved EH AP ordinal suffix required; Deposit -D is unavailable."
    );
  if (
    !item ||
    item.itemCode !== `${facts.containerFeet}' Hire` ||
    !item.accountCode ||
    item.taxType !== "OUTPUT" ||
    !Number.isFinite(item.unitAmount) ||
    item.unitAmount <= 0
  )
    return hold(
      "Current exact Xero hire sales item/rate/account/OUTPUT evidence required."
    );
  const subtotal = money(EXTRA_HIRE_WEEKS * item.unitAmount);
  const taxAmount = money(subtotal * 0.1);
  return {
    eligible: true,
    holdReason: null,
    proposedInvoiceNumber: invoiceNumber,
    document: {
      documentFamily: "customer_invoice",
      documentType: "extra_hire",
      proposedAction: "create_draft",
      proposedDocumentNumber: invoiceNumber,
      reference: facts.containerNumber,
      partyName: facts.customerName.trim(),
      partySourceId: null,
      accountCode: item.accountCode,
      gstTreatment: "GST_EXCLUSIVE",
      currency: "AUD",
      subtotal,
      taxAmount,
      total: money(subtotal + taxAmount),
      issueDate: new Date(`${facts.hireEndDate}T00:00:00Z`),
      dueDate: null,
      lineItems: [
        {
          itemCode: item.itemCode,
          description: `${facts.containerFeet}' Extra Hire — ${facts.containerNumber}`,
          quantity: EXTRA_HIRE_WEEKS,
          unitAmount: item.unitAmount,
          lineAmount: subtotal,
          accountCode: item.accountCode,
          taxRate: 10,
          gstTreatment: "GST_EXCLUSIVE",
        },
      ],
      sourceWorkflow: "extra_hire",
      sourceRecordId: facts.dealId,
      validationStatus: "valid",
    },
  };
}
