import {
  describeVtigerFinancialModuleFields,
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

/** Read-only metadata plus the exact Deal/customer. No Quote or webhook financial inputs are used. */
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
  for (const [key, label] of Object.entries(DEPOSIT_FIELD_LABELS)) {
    const fields = metadata.fields.filter(
      field => field.label.trim().toLowerCase() === label.toLowerCase()
    );
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
  // Standard current Deal mapping used by Main Customer Invoice, without its Quote-first resolution.
  const organisationRaw = text(deal.related_to ?? deal.relatedto);
  const contactRaw = text(deal.contact_id);
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
      ? text(customer.accountname)
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
