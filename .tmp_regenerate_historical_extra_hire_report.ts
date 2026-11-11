import { writeFile } from "node:fs/promises";
import { resolveExtraHireSourceMappings } from "./server/financialExtraHireInvoiceSource";
import { describeVtigerFinancialModuleFields, withVtigerFinancialReadSession } from "./server/vtigerFinancialReadService";
import { getExtraHireReleasePolicy } from "./server/financialExtraHireInvoiceRelease";
import { getDb } from "./server/db";
import { financialExtraHireInvoiceEvents } from "./drizzle/schema";

const OUT = "reports/historical-extra-hire-timezone-audit-2026-10-31.csv";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const DISPLAYED_CUTOVER = "2026-10-12 04:40:53";
const UNZONED_VTIGER_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const text = (value: unknown) => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const webId = (value: unknown) => /^\d+x\d{1,12}$/.test(text(value)) ? text(value) : "";
const rowsOf = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value)
  ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
  : Array.isArray((value as any)?.records)
    ? (value as any).records.filter((row: unknown): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    : [];
const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

const policy = await getExtraHireReleasePolicy();
if (!policy.effectiveFrom) throw new Error("Extra Hire cutover policy is missing effectiveFrom.");
const metadata = await describeVtigerFinancialModuleFields("Potentials");
const mapping = resolveExtraHireSourceMappings(metadata);
if (mapping.holdReason) throw new Error(`Cannot produce source-accurate report: ${mapping.holdReason}`);
const m = mapping.mappingEvidence;
for (const key of ["dealNumber", "containerNumber", "containerType", "hireDuration", "hireEndDate", "organisation", "contact", "modifiedTime"] as const) {
  if (!m[key]) throw new Error(`Missing Extra Hire source mapping: ${key}`);
}
const select = Array.from(new Set(["id", "createdtime", ...Object.values(m)])).join(",");
const raw: Array<Record<string, unknown>> = [];
let complete = false;
await withVtigerFinancialReadSession(async (session) => {
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `SELECT ${select} FROM Potentials WHERE ${m.hireDuration} = '30 days' AND createdtime < '${DISPLAYED_CUTOVER}' LIMIT ${page * PAGE_SIZE},${PAGE_SIZE};`;
    const batch = rowsOf(await session.query<unknown>(query));
    raw.push(...batch);
    console.log(`page=${page + 1} rows=${batch.length} cumulative=${raw.length}`);
    if (batch.length < PAGE_SIZE) { complete = true; break; }
  }
});
if (!complete) throw new Error(`The report would exceed the bounded ${MAX_PAGES * PAGE_SIZE}-record source scan; no CSV was written.`);
const db = await getDb();
if (!db) throw new Error("AP ledger unavailable for reporting cross-reference.");
const events = await db.select().from(financialExtraHireInvoiceEvents);
const byDealId = new Map<string, any>();
const byDealNumber = new Map<string, any>();
for (const event of events as any[]) {
  const priorById = byDealId.get(event.dealId);
  if (!priorById || new Date(event.createdAt).getTime() > new Date(priorById.createdAt).getTime()) byDealId.set(event.dealId, event);
  const priorByNumber = byDealNumber.get(event.dealNumber);
  if (!priorByNumber || new Date(event.createdAt).getTime() > new Date(priorByNumber.createdAt).getTime()) byDealNumber.set(event.dealNumber, event);
}
const dedup = new Map<string, Record<string, unknown>>();
for (const row of raw) {
  const dealNumber = text(row[m.dealNumber!]);
  const dealId = webId(row.id);
  const created = text(row.createdtime);
  const modified = text(row[m.modifiedTime!]);
  // A historic Extra Hire invoice is only a Deal; exclude Quote-like / malformed records.
  if (!/^D\d{1,12}$/.test(dealNumber) || !dealId || !UNZONED_VTIGER_DATETIME.test(created)) continue;
  const organisationId = webId(row[m.organisation!]);
  const contactId = webId(row[m.contact!]);
  const event = byDealId.get(dealId) ?? byDealNumber.get(dealNumber);
  const matchBasis = byDealId.has(dealId) ? "vtiger_webservice_id" : byDealNumber.has(dealNumber) ? "deal_number" : "";
  dedup.set(dealId, {
    deal_number: dealNumber,
    vtiger_webservice_id: dealId,
    container_number: text(row[m.containerNumber!]),
    container_type: text(row[m.containerType!]),
    hire_duration: text(row[m.hireDuration!]),
    hire_end_date: text(row[m.hireEndDate!]),
    billing_party_type: organisationId ? "organisation" : contactId ? "contact" : "missing",
    billing_party_vtiger_id: organisationId || contactId,
    vtiger_createdtime_raw: created,
    vtiger_modifiedtime_raw: modified,
    timezone_issue: "VTiger historical timestamp has no UTC offset/timezone",
    cutover_review_basis: `Displayed Deal Created Time is before ${DISPLAYED_CUTOVER}; actual UTC cutover comparison needs manual timezone confirmation`,
    extra_hire_cutover_effective_from: policy.effectiveFrom,
    existing_ap_event_match_basis: matchBasis,
    existing_ap_extra_hire_event_id: event?.id ?? "",
    existing_ap_extra_hire_event_status: event?.status ?? "",
    existing_ap_extra_hire_invoice_number: event?.proposedInvoiceNumber ?? "",
    existing_ap_xero_invoice_id: event?.xeroInvoiceId ?? "",
    existing_ap_hold_reason: event?.holdReason ?? "",
    accounts_manual_action: event
      ? "Confirm VTiger timezone and true created/modified timestamps. Do not replay the historic Extra Hire webhook; review the existing AP hold and use the approved manual historical-invoice procedure if billing is required."
      : "Confirm VTiger timezone and true created/modified timestamps. Do not trigger this historic 30-day hire through AP Extra Hire; use the approved manual historical-invoice procedure if billing is required.",
    audit_scope: "Complete read-only scan of 30-day Potentials with displayed Deal Created Time before the Extra Hire activation candidate. This CSV is D-number Deals only. No Xero, invoice, contact, CRM, webhook or AP-event write was made.",
  });
}
const rows = [...dedup.values()].sort((a, b) => String(a.vtiger_createdtime_raw).localeCompare(String(b.vtiger_createdtime_raw)) || String(a.deal_number).localeCompare(String(b.deal_number)));
const headers = Object.keys(rows[0] ?? {});
if (!headers.length) throw new Error("No affected historical D-number monthly-hire records found; report not written.");
await writeFile(OUT, [headers.join(","), ...rows.map((row) => headers.map((header) => csv(row[header])).join(","))].join("\n") + "\n", "utf8");
console.log(JSON.stringify({
  report: OUT,
  complete,
  rawPreCutoverMonthlyHireRows: raw.length,
  affectedHistoricalDealRows: rows.length,
  existingApHeldEvents: rows.filter((row) => Boolean(row.existing_ap_extra_hire_event_id)).length,
  existingApHeldDeals: rows.filter((row) => Boolean(row.existing_ap_extra_hire_event_id)).map((row) => row.deal_number),
  policyEffectiveFrom: policy.effectiveFrom,
  displayedCreatedTimeCutoverCandidate: DISPLAYED_CUTOVER,
}, null, 2));
process.exit(0);
