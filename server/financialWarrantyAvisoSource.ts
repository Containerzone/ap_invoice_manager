import { describeVtigerFinancialModuleFields, retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { financialSha256 } from "./financialProposalIntegrity";
import { warrantySourceConfigHash } from "./financialWarrantyAvisoRelease";
import { isoDate, type FieldBinding, type WarrantyFacts, type WarrantySourceConfig } from "./financialWarrantyAvisoRules";
type Metadata = Awaited<ReturnType<typeof describeVtigerFinancialModuleFields>>;
const id = (v: unknown): v is string => typeof v === "string" && /^\d+x\d{1,12}$/.test(v);
const time = (v: unknown): string | null => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const n = Date.parse(v); return Number.isFinite(n) && n <= Date.now() ? new Date(n).toISOString() : null;
};
export function validateWarrantyField(metadata: Metadata, b: FieldBinding | null | undefined, expectedType: string, reference?: string): string | null {
  if (!b || !/^[A-Za-z][A-Za-z0-9_]*$/.test(b.name) || !b.label) return "Exact nonsecret field name/label/type/mandatory binding required.";
  const exact = metadata.fields.filter(f => f.name === b.name);
  if (exact.length !== 1 || metadata.fields.filter(f => f.label === b.label).length !== 1 || financialSha256(exact[0]) !== financialSha256(b)) return `Metadata/value/type drift or ambiguous exact field ${b.label}; hold without guessing aliases.`;
  if (b.type.name !== expectedType || reference && financialSha256(b.type.refersTo) !== financialSha256([reference])) return `Exact ${b.label} ${expectedType}/${reference ?? "scalar"} type not proven.`;
  return null;
}
export function resolveWarrantySourceMappings(metadata: Metadata, c: WarrantySourceConfig | null) {
  const holds: string[] = []; const configurationRequired: string[] = [];
  if (metadata.name !== "Potentials") holds.push("Exact authenticated Potentials metadata required.");
  if (!c || c.module !== "Potentials" || !c.fields || !c.customerFields || !c.dateSemantics) {
    configurationRequired.push("Potentials idPrefix and unique Deal ID, Added Services, organisation/contact and Modified Time exact API name/label/full type bindings",
      "Current Accounts/Contacts name and Modified Time metadata bindings", "Exactly one approved Added Services picklist value → native WAR item code/description/GST-exclusive premium",
      "Issue/due field bindings where present, or explicit preserve-main date semantics; offset-bearing timestamp semantics");
    holds.push("Warranty source configuration absent/unproven; no custom labels/API names or premium will be guessed.");
    return { holds, configurationRequired, mapping: null };
  }
  if (!/^\d+$/.test(c.potentialsIdPrefix) || metadata.idPrefix !== c.potentialsIdPrefix) holds.push("Potentials native module ID prefix is unproven or drifted.");
  const checks = [["dealNumber", "string"], ["addedServices", "picklist"], ["organisation", "reference", "Accounts"], ["contact", "reference", "Contacts"], ["modifiedTime", "datetime"]] as const;
  for (const [key, type, ref] of checks) { const h = validateWarrantyField(metadata, c.fields[key], type, ref); if (h) holds.push(h); }
  if (c.fields.addedServices?.label !== "Added Services") holds.push("Warranty source must be exact Added Services only; Warranty Confirmed is deliberately ignored.");
  for (const key of ["issueDate", "dueDate"] as const) {
    const b = c.fields[key]; const semantic = key === "issueDate" ? c.dateSemantics.issue : c.dateSemantics.due;
    if (b) { const h = validateWarrantyField(metadata, b, "date"); if (h) holds.push(h); if (semantic !== "source_iso_date") holds.push(`Mapped ${key} must use source_iso_date semantics.`); }
    else if (semantic !== (key === "issueDate" ? "preserve_main_date" : "preserve_main_due_date")) holds.push(`Explicit ${key} preservation semantics required.`);
  }
  const bindings = Object.values(c.fields).filter((b): b is FieldBinding => Boolean(b));
  if (new Set(bindings.map(b => b.name)).size !== bindings.length) holds.push("One field cannot provide multiple warranty facts.");
  const maps = c.addedServicesMappings;
  const options = c.fields.addedServices?.type.picklistValues;
  if (!Array.isArray(maps) || maps.length !== 1 || !Array.isArray(options) || options.length === 0) holds.push("Exactly one recognised and approved Added Services mapping required; multi-mapping ambiguity holds.");
  const m = Array.isArray(maps) && maps.length === 1 ? maps[0] : null;
  if (m && (!m.addedServicesValue || !Array.isArray(options) || options.filter((p: any) => p.value === m.addedServicesValue).length !== 1 || !/^WAR[A-Za-z0-9 _'-]*$/.test(m.itemCode) ||
    !m.nativeDescription || typeof m.premiumExGst !== "number" || !Number.isFinite(m.premiumExGst) || m.premiumExGst <= 0 || Math.round(m.premiumExGst * 100) !== m.premiumExGst * 100)) holds.push("Approved exact Added Services value/native WAR description/positive cents-exclusive premium not proven.");
  return { holds, configurationRequired, mapping: m };
}
async function exactRecord(reference: string, module: Metadata) {
  if (!id(reference) || !module.idPrefix || reference.split("x")[0] !== module.idPrefix) throw new Error("Exact current source/customer module ID prefix mismatch; hold.");
  const row = await retrieveCurrentVtigerFinancialRecord(reference);
  if (row.id !== reference) throw new Error("VTiger retrieve did not return the exact requested record.");
  return row;
}
/** Fresh metadata on every invocation, then one exact Deal and its assigned current customer only. Never queries/scans records. */
export async function readWarrantyFacts(dealId: string, config: WarrantySourceConfig | null): Promise<WarrantyFacts> {
  if (!id(dealId)) throw new Error("One exact VTiger Deal webservice ID required; no record scans or free-text lookups.");
  const metadata = await describeVtigerFinancialModuleFields("Potentials");
  const resolved = resolveWarrantySourceMappings(metadata, config);
  const facts: WarrantyFacts = { dealId, dealNumber: "", addedServices: "", customerVtigerId: "", customerName: "", customerKind: "organisation", sourceModifiedAt: null, customerModifiedAt: null,
    issueDate: null, dueDate: null, sourceMappingsHash: config ? warrantySourceConfigHash(config) : "", addedServicesMappingHash: config ? financialSha256(config.addedServicesMappings) : "",
    mapping: resolved.mapping, configurationRequired: resolved.configurationRequired, holdReason: null };
  const holds = resolved.holds;
  if (!holds.length && config) {
    const deal = await exactRecord(dealId, metadata);
    const field = (key: keyof WarrantySourceConfig["fields"]) => {
      const b = config.fields[key]; if (!b) return "";
      if (!Object.hasOwn(deal, b.name) || typeof deal[b.name] !== "string") { holds.push(`Current ${b.label} must be an exact scalar; type drift holds.`); return ""; }
      return deal[b.name] as string;
    };
    facts.dealNumber = field("dealNumber"); facts.addedServices = field("addedServices"); facts.sourceModifiedAt = time(field("modifiedTime"));
    const org = field("organisation"); const contact = field("contact");
    if (!/^D\d{1,12}$/.test(facts.dealNumber) || !facts.sourceModifiedAt) holds.push("Exact D-number and current offset-bearing Modified Time required; no date/timezone guessing.");
    if (facts.addedServices !== resolved.mapping?.addedServicesValue) holds.push("Current Added Services is not the one exact approved metadata value; no free-text/Warranty Confirmed inference.");
    if (config.fields.issueDate) { facts.issueDate = isoDate(field("issueDate")); if (!facts.issueDate) holds.push("Exact source issue ISO date missing/invalid."); }
    if (config.fields.dueDate) { facts.dueDate = isoDate(field("dueDate")); if (!facts.dueDate) holds.push("Exact source due ISO date missing/invalid."); }
    if (facts.issueDate && facts.dueDate && facts.dueDate < facts.issueDate) holds.push("Source due precedes issue date.");
    if (org && !id(org) || contact && !id(contact) || !org && !contact) holds.push("Current linked organisation/contact invalid/missing; no fallback bypass.");
    facts.customerKind = org ? "organisation" : "contact"; facts.customerVtigerId = org || contact;
    if (!holds.length) {
      const module = await describeVtigerFinancialModuleFields(org ? "Accounts" : "Contacts");
      if (module.name !== (org ? "Accounts" : "Contacts")) holds.push("Exact customer module metadata mismatch.");
      const bindings = config.customerFields[facts.customerKind];
      for (const [k, b] of Object.entries(bindings)) { const h = validateWarrantyField(module, b, k === "modifiedTime" ? "datetime" : "string"); if (h) holds.push(h); }
      if (!holds.length) {
        const customer = await exactRecord(facts.customerVtigerId, module);
        const value = (b: FieldBinding) => { if (typeof customer[b.name] !== "string") { holds.push(`Current customer ${b.label} scalar missing/type drift.`); return ""; } return customer[b.name] as string; };
        facts.customerName = org ? value(config.customerFields.organisation.name) : [value(config.customerFields.contact.firstName), value(config.customerFields.contact.lastName)].filter(Boolean).join(" ");
        facts.customerModifiedAt = time(value(bindings.modifiedTime));
        if (!facts.customerName || !facts.customerModifiedAt) holds.push("Current customer name and offset-bearing modified timestamp required.");
      }
    }
  }
  facts.holdReason = holds.length ? holds.join(" ") : null;
  return facts;
}
