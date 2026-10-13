import { describeVtigerFinancialModuleFields, retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { financialSha256 } from "./financialProposalIntegrity";
import { warrantySourceConfigHash } from "./financialWarrantyAvisoRelease";
import {
  isoDate,
  WARRANTY_ADDED_SERVICES_MAPPINGS,
  type FieldBinding,
  type WarrantyFacts,
  type WarrantyMapping,
  type WarrantySourceConfig,
} from "./financialWarrantyAvisoRules";

type Metadata = Awaited<ReturnType<typeof describeVtigerFinancialModuleFields>>;

const id = (value: unknown): value is string => typeof value === "string" && /^\d+x\d{1,12}$/.test(value);
const normal = (value: string) => value.trim().replace(/\s+/g, " ");
const time = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= Date.now() ? new Date(parsed).toISOString() : null;
};

export function validateWarrantyField(metadata: Metadata, binding: FieldBinding | null | undefined, expectedType: string, reference?: string): string | null {
  if (!binding || !/^[A-Za-z][A-Za-z0-9_]*$/.test(binding.name) || !binding.label) return "Exact nonsecret field name/label/type/mandatory binding required.";
  const exact = metadata.fields.filter(field => field.name === binding.name);
  if (exact.length !== 1 || metadata.fields.filter(field => field.label === binding.label).length !== 1 || financialSha256(exact[0]) !== financialSha256(binding)) {
    return `Metadata/value/type drift or ambiguous exact field ${binding.label}; hold without guessing aliases.`;
  }
  if (binding.type.name !== expectedType || reference && financialSha256(binding.type.refersTo) !== financialSha256([reference])) {
    return `Exact ${binding.label} ${expectedType}/${reference ?? "scalar"} type not proven.`;
  }
  return null;
}

function mappingConfigurationHolds(config: WarrantySourceConfig): string[] {
  const holds: string[] = [];
  const expected = WARRANTY_ADDED_SERVICES_MAPPINGS;
  const mappings = Array.isArray(config.addedServicesMappings) ? config.addedServicesMappings : [];
  if (mappings.length !== expected.length) {
    holds.push(`All ${expected.length} approved Added Services warranty mappings are required; no partial or extra mapping is accepted.`);
    return holds;
  }
  const byValue = new Map<string, WarrantyMapping>();
  for (const mapping of mappings) {
    const key = typeof mapping?.addedServicesValue === "string" ? normal(mapping.addedServicesValue) : "";
    if (!key || byValue.has(key)) {
      holds.push("Warranty Added Services mapping values must be unique and exact.");
      continue;
    }
    byValue.set(key, mapping);
  }
  for (const approved of expected) {
    const mapping = byValue.get(approved.addedServicesValue);
    if (!mapping || mapping.itemCode !== approved.itemCode || mapping.premiumExGst !== approved.premiumExGst ||
      !mapping.nativeDescription || typeof mapping.nativeDescription !== "string" ||
      !/^WAR[A-Za-z0-9 _'-]*$/.test(mapping.itemCode) ||
      !Number.isFinite(mapping.premiumExGst) || mapping.premiumExGst <= 0 || Math.round(mapping.premiumExGst * 100) !== mapping.premiumExGst * 100) {
      holds.push(`Approved ${approved.addedServicesValue} → ${approved.itemCode} exclusive premium mapping is incomplete or changed.`);
    }
  }
  for (const value of Array.from(byValue.keys())) if (!expected.some(item => item.addedServicesValue === value)) holds.push("Unsupported warranty Added Services mapping is configured.");
  return Array.from(new Set(holds));
}

export function resolveWarrantySourceMappings(metadata: Metadata, config: WarrantySourceConfig | null) {
  const holds: string[] = [];
  const configurationRequired: string[] = [];
  if (metadata.name !== "Potentials") holds.push("Exact authenticated Potentials metadata required.");
  if (!config || config.module !== "Potentials" || !config.fields || !config.customerFields || !config.dateSemantics) {
    configurationRequired.push(
      "Potentials idPrefix and unique Deal ID, Added Services multipicklist, organisation/contact and Modified Time exact API name/label/full type bindings",
      "Current Accounts/Contacts name and Modified Time metadata bindings",
      "All ten approved Added Services warranty values → native WAR item code/description/GST-exclusive premium mappings",
      "Issue/due field bindings where present, or explicit preserve-main date semantics; offset-bearing timestamp semantics",
    );
    holds.push("Warranty source configuration absent/unproven; no custom labels/API names, selected warranty or premium will be guessed.");
    return { holds, configurationRequired };
  }
  if (!/^\d+$/.test(config.potentialsIdPrefix) || metadata.idPrefix !== config.potentialsIdPrefix) holds.push("Potentials native module ID prefix is unproven or drifted.");
  const checks = [["dealNumber", "string"], ["addedServices", "multipicklist"], ["organisation", "reference", "Accounts"], ["contact", "reference", "Contacts"], ["modifiedTime", "datetime"]] as const;
  for (const [key, type, reference] of checks) {
    const hold = validateWarrantyField(metadata, config.fields[key], type, reference);
    if (hold) holds.push(hold);
  }
  if (config.fields.addedServices?.label !== "Added Services") holds.push("Warranty source must be exact Added Services only; Warranty Confirmed is deliberately ignored.");
  for (const key of ["issueDate", "dueDate"] as const) {
    const binding = config.fields[key];
    const semantic = key === "issueDate" ? config.dateSemantics.issue : config.dateSemantics.due;
    if (binding) {
      const hold = validateWarrantyField(metadata, binding, "date");
      if (hold) holds.push(hold);
      if (semantic !== "source_iso_date") holds.push(`Mapped ${key} must use source_iso_date semantics.`);
    } else if (semantic !== (key === "issueDate" ? "preserve_main_date" : "preserve_main_due_date")) {
      holds.push(`Explicit ${key} preservation semantics required.`);
    }
  }
  const bindings = Object.values(config.fields).filter((binding): binding is FieldBinding => Boolean(binding));
  if (new Set(bindings.map(binding => binding.name)).size !== bindings.length) holds.push("One field cannot provide multiple warranty facts.");
  const picklist = config.fields.addedServices?.type.picklistValues;
  if (!Array.isArray(picklist) || picklist.length === 0) holds.push("The exact Added Services multipicklist values are required.");
  for (const approved of WARRANTY_ADDED_SERVICES_MAPPINGS) {
    if (!Array.isArray(picklist) || picklist.filter((entry: any) => entry?.value === approved.addedServicesValue).length !== 1) {
      holds.push(`Current Added Services lacks the approved ${approved.addedServicesValue} value.`);
    }
  }
  holds.push(...mappingConfigurationHolds(config));
  return { holds: Array.from(new Set(holds)), configurationRequired };
}

function exactRecord(reference: string, module: Metadata) {
  if (!id(reference) || !module.idPrefix || reference.split("x")[0] !== module.idPrefix) throw new Error("Exact current source/customer module ID prefix mismatch; hold.");
  return retrieveCurrentVtigerFinancialRecord(reference).then(row => {
    if (row.id !== reference) throw new Error("VTiger retrieve did not return the exact requested record.");
    return row;
  });
}

/** VTiger serializes multipicklist selections with ` |##| `. No free text is accepted. */
export function parseCurrentAddedServices(raw: string, allowedValues: string[]): { values: string[]; unknown: string[] } {
  const allowed = new Map(allowedValues.map(value => [normal(value), value]));
  const parts = raw.split(/\s*\|##\|\s*|\s*;\s*/).map(normal).filter(Boolean);
  const values: string[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    const value = allowed.get(part);
    if (value) values.push(value);
    else unknown.push(part);
  }
  return { values: Array.from(new Set(values)), unknown: Array.from(new Set(unknown)) };
}

/** Fresh metadata then one exact Deal and its assigned current customer only. Never queries/scans records. */
export async function readWarrantyFacts(dealId: string, config: WarrantySourceConfig | null): Promise<WarrantyFacts> {
  if (!id(dealId)) throw new Error("One exact VTiger Deal webservice ID required; no record scans or free-text lookups.");
  const metadata = await describeVtigerFinancialModuleFields("Potentials");
  const resolved = resolveWarrantySourceMappings(metadata, config);
  const facts: WarrantyFacts = {
    dealId, dealNumber: "", addedServices: "", customerVtigerId: "", customerName: "", customerKind: "organisation",
    sourceModifiedAt: null, customerModifiedAt: null, issueDate: null, dueDate: null,
    sourceMappingsHash: config ? warrantySourceConfigHash(config) : "", addedServicesMappingHash: config ? financialSha256(config.addedServicesMappings) : "",
    mapping: null, configurationRequired: resolved.configurationRequired, holdReason: null,
  };
  const holds = [...resolved.holds];
  if (!holds.length && config) {
    const deal = await exactRecord(dealId, metadata);
    const field = (key: keyof WarrantySourceConfig["fields"]) => {
      const binding = config.fields[key];
      if (!binding) return "";
      if (!Object.hasOwn(deal, binding.name) || typeof deal[binding.name] !== "string") {
        holds.push(`Current ${binding.label} must be an exact scalar; type drift holds.`);
        return "";
      }
      return deal[binding.name] as string;
    };
    facts.dealNumber = field("dealNumber");
    facts.addedServices = field("addedServices");
    facts.sourceModifiedAt = time(field("modifiedTime"));
    const organisation = field("organisation");
    const contact = field("contact");
    if (!/^D\d{1,12}$/.test(facts.dealNumber) || !facts.sourceModifiedAt) holds.push("Exact D-number and current offset-bearing Modified Time required; no date/timezone guessing.");
    const allowedValues = (config.fields.addedServices.type.picklistValues as Array<{ value?: unknown }>).map(entry => typeof entry?.value === "string" ? entry.value : "").filter(Boolean);
    const selected = parseCurrentAddedServices(facts.addedServices, allowedValues);
    if (selected.unknown.length) holds.push("Current Added Services contains an unrecognised value; no warranty selection will be inferred.");
    const mappings = selected.values
      .map(value => config.addedServicesMappings.find(mapping => mapping.addedServicesValue === value) ?? null)
      .filter((mapping): mapping is WarrantyMapping => Boolean(mapping));
    const unsupportedWarranty = selected.values.filter(value => /^Warranty \$\d+k$/i.test(value) && !mappings.some(mapping => mapping.addedServicesValue === value));
    if (mappings.length > 1) holds.push("More than one supported Warranty Added Services value is selected; no document is changed.");
    else if (unsupportedWarranty.length) holds.push("Current Added Services selects an unsupported Warranty cover; no item or premium will be guessed.");
    else if (mappings.length === 0) holds.push("Current Added Services has no supported Warranty selection; no Warranty/Aviso document is proposed.");
    else facts.mapping = mappings[0]!;
    if (config.fields.issueDate) { facts.issueDate = isoDate(field("issueDate")); if (!facts.issueDate) holds.push("Exact source issue ISO date missing/invalid."); }
    if (config.fields.dueDate) { facts.dueDate = isoDate(field("dueDate")); if (!facts.dueDate) holds.push("Exact source due ISO date missing/invalid."); }
    if (facts.issueDate && facts.dueDate && facts.dueDate < facts.issueDate) holds.push("Source due precedes issue date.");
    if (organisation && !id(organisation) || contact && !id(contact) || !organisation && !contact) holds.push("Current linked organisation/contact invalid/missing; no fallback bypass.");
    facts.customerKind = organisation ? "organisation" : "contact";
    facts.customerVtigerId = organisation || contact;
    if (!holds.length) {
      const customerModule = await describeVtigerFinancialModuleFields(organisation ? "Accounts" : "Contacts");
      if (customerModule.name !== (organisation ? "Accounts" : "Contacts")) holds.push("Exact customer module metadata mismatch.");
      const bindings = config.customerFields[facts.customerKind];
      for (const [key, binding] of Object.entries(bindings)) {
        const hold = validateWarrantyField(customerModule, binding, key === "modifiedTime" ? "datetime" : "string");
        if (hold) holds.push(hold);
      }
      if (!holds.length) {
        const customer = await exactRecord(facts.customerVtigerId, customerModule);
        const value = (binding: FieldBinding) => {
          if (typeof customer[binding.name] !== "string") { holds.push(`Current customer ${binding.label} scalar missing/type drift.`); return ""; }
          return customer[binding.name] as string;
        };
        facts.customerName = organisation
          ? value(config.customerFields.organisation.name)
          : [value(config.customerFields.contact.firstName), value(config.customerFields.contact.lastName)].filter(Boolean).join(" ");
        facts.customerModifiedAt = time(value(bindings.modifiedTime));
        if (!facts.customerName || !facts.customerModifiedAt) holds.push("Current customer name and offset-bearing modified timestamp required.");
      }
    }
  }
  facts.holdReason = holds.length ? Array.from(new Set(holds)).join(" ") : null;
  return facts;
}
