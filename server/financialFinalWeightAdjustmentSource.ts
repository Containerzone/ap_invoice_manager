import { describeVtigerFinancialModuleFields, retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { finalWeightDate, type FinalWeightDirection, type FinalWeightFacts } from "./financialFinalWeightAdjustmentRules";

/** Labels verified by Potentials describe only on 2026-10-11; runtime revalidation is mandatory. */
export const FINAL_WEIGHT_FIELD_LABELS = {
  dealNumber: ["Deal ID"], dealName: ["Container number"], organisation: ["Organization Name"], contact: ["Contact Name"],
  customerPO: ["Customer PO"],
  estimatedWeight: ["Estimated Weight (TONS)"], actualWeight: ["Actual Weight (Tons)"], perExtraTonne: ["Per Extra Tonne"],
  collectionDate: ["Full Container Pickup DATE"], depositStatus: ["Deposit Status"], modifiedTime: ["Modified Time"],
} as const;
/** Approved Potentials API names; labels are still runtime-verified exactly below. */
const FINAL_WEIGHT_API_FIELD_NAMES = {
  collectionDate: "cf_potentials_fullcontainercollectiondate",
  depositStatus: "cf_potentials_depositstatus",
} as const;
type Metadata = Awaited<ReturnType<typeof describeVtigerFinancialModuleFields>>;
const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const id = (value: unknown) => /^\d+x\d+$/i.test(text(value)) ? text(value) : "";
const numeric = (value: unknown) => {
  const raw = text(value);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const valueNumber = Number(raw); return Number.isFinite(valueNumber) ? valueNumber : null;
};
const timestamp = (value: unknown) => {
  const raw = text(value); const date = raw ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export function resolveFinalWeightSourceMappings(metadata: Metadata, direction: FinalWeightDirection) {
  const mappingEvidence: Record<string, string> = {}; const holds: string[] = [];
  if (metadata.name !== "Potentials") holds.push("Metadata must describe Potentials exactly.");
  const required = Object.keys(FINAL_WEIGHT_FIELD_LABELS).filter(key =>
    key !== "customerPO" || direction === "overweight");
  for (const key of required) {
    const labels = FINAL_WEIGHT_FIELD_LABELS[key as keyof typeof FINAL_WEIGHT_FIELD_LABELS] as readonly string[];
    // Exact label text, not fuzzy aliases or presumed custom API names.
    const fields = metadata.fields.filter(field => labels.includes(field.label));
    if (fields.length !== 1 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(fields[0]!.name) || metadata.fields.filter(field => field.name === fields[0]!.name).length !== 1) {
      holds.push(`Source mapping ${labels.join(" / ")} is missing or ambiguous.`); continue;
    }
    const field = fields[0]!;
    if ((key === "customerPO" && field.type.name !== "string") ||
      (key === "organisation" && !(field.type.refersTo as string[] | undefined)?.includes("Accounts")) ||
      (key === "contact" && !(field.type.refersTo as string[] | undefined)?.includes("Contacts")) ||
      (key === "collectionDate" && field.type.name !== "date") ||
      (key === "depositStatus" && field.type.name !== "picklist")) holds.push(`Source mapping ${field.label} has an unverified field type.`);
    const requiredApiName = FINAL_WEIGHT_API_FIELD_NAMES[key as keyof typeof FINAL_WEIGHT_API_FIELD_NAMES];
    if (requiredApiName && field.name !== requiredApiName) holds.push(`Source mapping ${field.label} must use verified API field ${requiredApiName}.`);
    mappingEvidence[key] = field.name;
  }
  if (new Set(Object.values(mappingEvidence)).size !== Object.values(mappingEvidence).length) holds.push("A source field resolves to more than one final-weight fact.");
  return { mappingEvidence, holdReason: holds.length ? holds.join(" ") : null };
}
async function exactRecord(reference: string) {
  if (!/^\d+x\d{1,12}$/i.test(reference)) throw new Error("An exact VTiger webservice ID is required.");
  const record = await retrieveCurrentVtigerFinancialRecord(reference);
  if (id(record.id) !== reference) throw new Error("VTiger retrieve returned a different exact record.");
  return record;
}
/** Metadata + exact named Deal and linked customer only. No record browsing, Quote fallbacks or body finance. */
export async function readFinalWeightFacts(dealId: string, direction: FinalWeightDirection): Promise<FinalWeightFacts> {
  const metadata = await describeVtigerFinancialModuleFields("Potentials");
  const mapping = resolveFinalWeightSourceMappings(metadata, direction);
  const deal = await exactRecord(dealId);
  const holds = mapping.holdReason ? [mapping.holdReason] : [];
  const field = (key: keyof typeof FINAL_WEIGHT_FIELD_LABELS) => {
    const name = mapping.mappingEvidence[key];
    if (!name) return undefined;
    if (!Object.prototype.hasOwnProperty.call(deal, name) || !["string", "number"].includes(typeof deal[name])) holds.push(`Current exact Deal lacks scalar mapped ${key}.`);
    return deal[name];
  };
  const organisation = text(field("organisation")); const contact = text(field("contact"));
  if (organisation && !id(organisation) || !organisation && contact && !id(contact)) holds.push("Current Deal customer reference is not an exact webservice ID; no bypass fallback.");
  const customerKind = organisation ? "organisation" as const : "contact" as const;
  const customerVtigerId = id(organisation || contact);
  // Mapping ambiguity holds before any linked customer retrieve.
  const customer = !mapping.holdReason && customerVtigerId ? await exactRecord(customerVtigerId) : null;
  const customerName = customer ? customerKind === "organisation" ? text(customer.accountname) : [text(customer.firstname), text(customer.lastname)].filter(Boolean).join(" ") : "";
  const dealNumber = text(field("dealNumber")); const dealName = text(field("dealName"));
  const customerPO = direction === "overweight" ? text(field("customerPO")) : "";
  const estimatedWeight = numeric(field("estimatedWeight")); const actualWeight = numeric(field("actualWeight")); const perExtraTonne = numeric(field("perExtraTonne"));
  const collectionDate = finalWeightDate(field("collectionDate"));
  const depositStatusValue = field("depositStatus");
  const depositStatus = typeof depositStatusValue === "string" ? depositStatusValue.trim() || null : null;
  const sourceRefreshedAt = timestamp(field("modifiedTime"));
  return { dealId, dealNumber, dealName, customerPO, customerVtigerId, customerName, customerKind, estimatedWeight, actualWeight, perExtraTonne, collectionDate, depositStatus,
    sourceRefreshedAt, customerRefreshedAt: customer ? timestamp(customer.modifiedtime) : null, mappingEvidence: mapping.mappingEvidence, sourceHoldReason: holds.length ? holds.join(" ") : null };
}
