import { writeFile } from "node:fs/promises";
import { resolveExtraHireSourceMappings } from "./server/financialExtraHireInvoiceSource";
import { describeVtigerFinancialModuleFields, withVtigerFinancialReadSession } from "./server/vtigerFinancialReadService";
import { getExtraHireReleasePolicy } from "./server/financialExtraHireInvoiceRelease";
import { getDb } from "./server/db";
import { financialExtraHireInvoiceEvents } from "./drizzle/schema";

const OUT = "reports/historical-extra-hire-timezone-audit-2026-10-31.csv";
const DISPLAYED_CUTOVER = "2026-10-12 04:40:53";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const UNZONED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const asText = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const asId = (value: unknown) => /^\d+x\d{1,12}$/.test(asText(value)) ? asText(value) : "";
const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const rowsOf = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
  : Array.isArray((value as any)?.records)
    ? (value as any).records.filter((row: unknown): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : [];
const closedOrCompleted = (stage: string) => /(?:\bclosed\b|\bcomplete(?:d)?\b)/i.test(stage);

const policy = await getExtraHireReleasePolicy();
if (!policy.effectiveFrom) throw new Error("Extra Hire cutover policy has no effective time.");
const metadata = await describeVtigerFinancialModuleFields("Potentials");
const mappingResult = resolveExtraHireSourceMappings(metadata);
if (mappingResult.holdReason) throw new Error(`Exact Extra Hire source mapping unavailable: ${mappingResult.holdReason}`);
const mapping = mappingResult.mappingEvidence;
const statusCandidates = metadata.fields.filter((field: any) =>
  field.name === "sales_stage" && field.label?.trim() === "Sales Stage" && field.type?.name === "metricpicklist"
);
if (statusCandidates.length !== 1) throw new Error("VTiger Sales Stage field is missing or ambiguous; report not written.");
const statusField = statusCandidates[0]!.name;
for (const key of ["dealNumber", "containerNumber", "containerType", "hireDuration", "hireEndDate", "organisation", "contact", "modifiedTime"] as const) {
  if (!mapping[key]) throw new Error(`Extra Hire field mapping missing: ${key}`);
}
const select = Array.from(new Set(["id", "createdtime", statusField, ...Object.values(mapping)])).join(",");
const sourceRows: Array<Record<string, unknown>> = [];
let complete = false;
await withVtigerFinancialReadSession(async (session) => {
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `SELECT ${select} FROM Potentials WHERE ${mapping.hireDuration} = '30 days' AND createdtime < '${DISPLAYED_CUTOVER}' LIMIT ${page * PAGE_SIZE},${PAGE_SIZE};`;
    const batch = rowsOf(await session.query<unknown>(query));
    sourceRows.push(...batch);
    console.log(`page=${page + 1} source_rows=${batch.length} cumulative=${sourceRows.length}`);
    if (batch.length < PAGE_SIZE) { complete = true; break; }
  }
});
if (!complete) throw new Error(`Source scan exceeded the fixed ${MAX_PAGES * PAGE_SIZE}-row cap. No CSV written.`);
const db = await getDb();
if (!db) throw new Error("AP event ledger unavailable for report cross-reference.");
const events = await db.select().from(financialExtraHireInvoiceEvents);
const eventByDealId = new Map<string, any>();
const eventByDealNumber = new Map<string, any>();
for (const event of events as any[]) {
  const newer = (candidate: any, prior: any) => !prior || new Date(candidate.createdAt).getTime() > new Date(prior.createdAt).getTime();
  if (newer(event, eventByDealId.get(event.dealId))) eventByDealId.set(event.dealId, event);
  if (newer(event, eventByDealNumber.get(event.dealNumber))) eventByDealNumber.set(event.dealNumber, event);
}
const outputByDeal = new Map<string, Record<string, string>>();
const excludedByStage = new Map<string, number>();
for (const row of sourceRows) {
  const dealNumber = asText(row[mapping.dealNumber!]);
  const internalId = asId(row.id);
  const created = asText(row.createdtime);
  const stage = asText(row[statusField]);
  if (!/^D\d{1,12}$/.test(dealNumber) || !internalId || !UNZONED.test(created)) continue;
  if (closedOrCompleted(stage)) {
    excludedByStage.set(stage || "(blank)", (excludedByStage.get(stage || "(blank)") ?? 0) + 1);
    continue;
  }
  const organisation = asId(row[mapping.organisation!]);
  const contact = asId(row[mapping.contact!]);
  const event = eventByDealId.get(internalId) ?? eventByDealNumber.get(dealNumber);
  const matchBasis = eventByDealId.has(internalId) ? "Deal ID" : eventByDealNumber.has(dealNumber) ? "D-number" : "";
  outputByDeal.set(dealNumber, {
    deal_id: dealNumber,
    sales_stage: stage || "(blank)",
    container_number: asText(row[mapping.containerNumber!]),
    container_type: asText(row[mapping.containerType!]),
    hire_duration: asText(row[mapping.hireDuration!]),
    hire_end_date: asText(row[mapping.hireEndDate!]),
    billing_party_type: organisation ? "organisation" : contact ? "contact" : "missing",
    vtiger_createdtime_raw: created,
    vtiger_modifiedtime_raw: asText(row[mapping.modifiedTime!]),
    timezone_issue: "VTiger historical timestamp has no UTC offset/timezone",
    cutover_review_basis: `Displayed Deal Created Time is before ${DISPLAYED_CUTOVER}; actual UTC cutover comparison needs manual timezone confirmation`,
    extra_hire_cutover_effective_from: policy.effectiveFrom,
    existing_ap_event_match_basis: matchBasis,
    existing_ap_extra_hire_event_id: event ? String(event.id) : "",
    existing_ap_extra_hire_event_status: event?.status ?? "",
    existing_ap_extra_hire_invoice_number: event?.proposedInvoiceNumber ?? "",
    existing_ap_xero_invoice_id: event?.xeroInvoiceId ?? "",
    existing_ap_hold_reason: event?.holdReason ?? "",
    accounts_manual_action: event
      ? "Confirm VTiger timezone and true timestamps. Do not replay this historic Extra Hire webhook; review the existing AP hold and use the approved manual historical-invoice process if billing is required."
      : "Confirm VTiger timezone and true timestamps. Do not trigger this historic 30-day hire through AP Extra Hire; use the approved manual historical-invoice process if billing is required.",
    audit_scope: "Read-only scan of 30-day Deals with displayed Created Time before the Extra Hire cutover candidate. Completed/Closed Sales Stages are excluded. Business D-number IDs are shown; internal VTiger 5x IDs are intentionally omitted.",
  });
}
const records = [...outputByDeal.values()].sort((a, b) => a.vtiger_createdtime_raw.localeCompare(b.vtiger_createdtime_raw) || a.deal_id.localeCompare(b.deal_id));
if (!records.length) throw new Error("No eligible historical D-number monthly-hire Deals found; CSV not written.");
const headers = Object.keys(records[0]!);
await writeFile(OUT, [headers.join(","), ...records.map((record) => headers.map((header) => csv(record[header])).join(","))].join("\n") + "\n", "utf8");
console.log(JSON.stringify({
  report: OUT,
  sourceRowsRead: sourceRows.length,
  historicalDNumberDealsIncluded: records.length,
  completedOrClosedExcluded: Object.fromEntries([...excludedByStage.entries()].sort()),
  excludedTotal: [...excludedByStage.values()].reduce((sum, value) => sum + value, 0),
  existingApEventsMatched: records.filter((record) => Boolean(record.existing_ap_extra_hire_event_id)).map((record) => record.deal_id),
  policyEffectiveFrom: policy.effectiveFrom,
}, null, 2));
process.exit(0);
