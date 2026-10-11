import {
  describeVtigerFinancialModuleFields,
  retrieveCurrentVtigerFinancialRecord,
} from "./vtigerFinancialReadService";
import {
  extraHireDate,
  type ExtraHireFacts,
} from "./financialExtraHireInvoiceRules";
/** Verified by one Potentials metadata-only describe, 2026-10-11. Re-resolve on EVERY preview/write. */
export const EXTRA_HIRE_FIELD_LABELS = {
  dealNumber: "Deal ID",
  containerNumber: "Container number",
  containerType: "Container Type",
  hireDuration: "Hire Duration",
  hireEndDate: "Hire End Date",
  organisation: "Organization Name",
  contact: "Contact Name",
  modifiedTime: "Modified Time",
} as const;
type Metadata = Awaited<ReturnType<typeof describeVtigerFinancialModuleFields>>;
const text = (v: unknown) =>
  typeof v === "string"
    ? v.trim()
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : "";
const id = (v: unknown) => (/^\d+x\d{1,12}$/.test(text(v)) ? text(v) : "");
export function resolveExtraHireSourceMappings(metadata: Metadata) {
  const mappingEvidence: Record<string, string> = {};
  const holds: string[] = [];
  if (metadata.name !== "Potentials")
    holds.push("Source metadata must be Potentials exactly.");
  for (const [key, label] of Object.entries(EXTRA_HIRE_FIELD_LABELS)) {
    const fields = metadata.fields.filter(f => f.label.trim() === label);
    if (
      fields.length !== 1 ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(fields[0]!.name) ||
      metadata.fields.filter(f => f.name === fields[0]!.name).length !== 1
    ) {
      holds.push(`Exact ${label} mapping is missing or ambiguous.`);
      continue;
    }
    const field = fields[0]!;
    const type = field.type;
    const expected =
      key === "hireEndDate"
        ? "date"
        : key === "modifiedTime"
          ? "datetime"
          : ["organisation", "contact"].includes(key)
            ? "reference"
            : ["containerType", "hireDuration"].includes(key)
              ? "picklist"
              : "string";
    const refersTo = Array.isArray(type.refersTo) ? type.refersTo : [];
    if (
      type.name !== expected ||
      (key === "organisation" &&
        (refersTo.length !== 1 || refersTo[0] !== "Accounts")) ||
      (key === "contact" &&
        (refersTo.length !== 1 || refersTo[0] !== "Contacts"))
    )
      holds.push(`Exact ${label} metadata type/reference is unconfirmed.`);
    if (
      expected === "picklist" &&
      (!Array.isArray(type.picklistValues) ||
        !(type.picklistValues as any[]).length)
    )
      holds.push(`Exact ${label} picklist values are unconfirmed.`);
    mappingEvidence[key] = field.name;
  }
  if (
    new Set(Object.values(mappingEvidence)).size !==
    Object.values(mappingEvidence).length
  )
    holds.push("One source field resolves to multiple Extra Hire facts.");
  return { mappingEvidence, holdReason: holds.length ? holds.join(" ") : null };
}
async function exactRecord(reference: string) {
  if (!id(reference))
    throw new Error("Extra Hire requires one exact VTiger webservice ID.");
  const record = await retrieveCurrentVtigerFinancialRecord(reference);
  if (id(record.id) !== reference)
    throw new Error("VTiger retrieve returned a different exact record.");
  return record;
}
export async function readExtraHireFacts(
  dealId: string
): Promise<ExtraHireFacts> {
  const metadata = await describeVtigerFinancialModuleFields("Potentials");
  const mapping = resolveExtraHireSourceMappings(metadata);
  const deal = await exactRecord(dealId);
  const holds = mapping.holdReason ? [mapping.holdReason] : [];
  const field = (key: keyof typeof EXTRA_HIRE_FIELD_LABELS) => {
    const name = mapping.mappingEvidence[key];
    if (!name) return "";
    if (!Object.hasOwn(deal, name) || typeof deal[name] !== "string")
      holds.push(`Current Deal lacks exact scalar ${key}.`);
    return text(deal[name]);
  };
  const dealNumber = field("dealNumber");
  const containerNumber = field("containerNumber");
  const containerType = field("containerType");
  const duration = field("hireDuration");
  const options = (key: string) => {
    const t = metadata.fields.find(
      f => f.name === mapping.mappingEvidence[key]
    )?.type;
    return Array.isArray(t?.picklistValues)
      ? (t.picklistValues as any[]).map(p => p.value)
      : [];
  };
  if (
    !options("hireDuration").includes(duration) ||
    !options("containerType").includes(containerType)
  )
    holds.push(
      "Current hire duration/container type is not an exact metadata picklist value."
    );
  const containerFeet = ["20 Foot Standard", "20 Foot High Cube"].includes(
    containerType
  )
    ? (20 as const)
    : ["40 Foot Standard", "40 Foot High Cube"].includes(containerType)
      ? (40 as const)
      : null;
  const hireDuration = duration === "30 days" ? 30 : null;
  const hireEndDate = extraHireDate(field("hireEndDate"));
  const organisation = field("organisation");
  const contact = field("contact");
  if (
    (organisation && !id(organisation)) ||
    (!organisation && contact && !id(contact))
  )
    holds.push(
      "Invalid exact linked customer reference; no contact fallback may bypass an invalid organisation."
    );
  const customerKind = organisation
    ? ("organisation" as const)
    : ("contact" as const);
  const customerVtigerId = id(organisation || contact);
  const customer =
    !mapping.holdReason && customerVtigerId
      ? await exactRecord(customerVtigerId)
      : null;
  const customerName = customer
    ? customerKind === "organisation"
      ? text(customer.accountname)
      : [text(customer.firstname), text(customer.lastname)]
          .filter(Boolean)
          .join(" ")
    : "";
  const modified = field("modifiedTime");
  const timestamp = (value: unknown) => {
    const raw = text(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        raw
      )
    )
      return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) && date.getTime() <= Date.now()
      ? date.toISOString()
      : null;
  };
  const sourceRefreshedAt = timestamp(modified);
  const customerRefreshedAt = customer
    ? timestamp(customer.modifiedtime)
    : null;
  if (!sourceRefreshedAt || (customer && !customerRefreshedAt))
    holds.push(
      "Modified timestamp timezone is unconfirmed: exact offset-bearing source/customer timestamps required; no server/local timezone is guessed."
    );
  if (
    !sourceRefreshedAt ||
    !/^D\d{1,12}$/.test(dealNumber) ||
    !containerNumber ||
    !hireEndDate
  )
    holds.push(
      "Named D-number, container, ISO Hire End Date and current modified timestamp required; no date aliases or locale guesses."
    );
  return {
    dealId,
    dealNumber,
    containerNumber,
    containerType,
    containerFeet,
    hireDuration,
    hireEndDate,
    customerVtigerId,
    customerName,
    customerKind,
    sourceRefreshedAt,
    customerRefreshedAt,
    mappingEvidence: mapping.mappingEvidence,
    sourceHoldReason: holds.length ? holds.join(" ") : null,
  };
}
