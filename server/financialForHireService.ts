import { createHash } from "node:crypto";
import { resolveFinancialAutomationRules } from "./financialAutomationRules";
import {
  buildInitialForHirePo,
  buildRecurringForHirePo,
  type ForHireContainerControlFacts,
  type ForHirePoPreview,
} from "./financialForHireDrafts";
import {
  getForHireEventsForControl,
  lastVerifiedForHirePeriod,
  recordForHirePreview,
} from "./financialForHireDb";
import { preflightFinancialXeroIntents, type FinancialXeroPreflight } from "./financialReadOnlyXeroService";
import { financialSha256, rulesSnapshotHash, sourceSnapshotHash } from "./financialProposalIntegrity";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { getFinancialWorkflowSchedules } from "./financialWorkflowDb";
import { getForHireReleasePolicy } from "./financialForHireRelease";

export const FOR_HIRE_VTIGER_MODULE = "vtcmcontainercontrols" as const;
export const FOR_HIRE_FUTURE_WEBHOOK_PATH = "/api/webhooks/vtiger/container-control-for-hire" as const;
export const FOR_HIRE_RECURRING_PATH = "/api/scheduled/financial-writer/recurring_for_hire" as const;
export const FOR_HIRE_RECURRING_CRON = "0 0 0 1 * *" as const;
export const FOR_HIRE_RULES_VERSION = "for-hire-container-control-v1-readiness" as const;
export const FOR_HIRE_RULES_HASH = createHash("sha256").update(FOR_HIRE_RULES_VERSION).digest("hex");

type ForHirePreviewState = "previewed" | "held" | "dehired";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function normalized(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, " ");
}

function parseDate(value: unknown): Date | null {
  const raw = text(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  const parsed = match ? new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00.000Z`) : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function recordId(value: unknown): string {
  const raw = text(value);
  return /^\d+x\d+$/i.test(raw) ? raw : "";
}

function toNumber(value: unknown): number | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeHoldPeriod(value: unknown): string {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = parseDate(raw);
  return parsed ? parsed.toISOString().slice(0, 10) : "unresolved";
}

function sourceRefresh(raw: Record<string, unknown>): Date | null {
  return parseDate(raw.modifiedtime ?? raw.modifiedTime ?? raw.createdtime);
}

async function resolveVendor(reference: string): Promise<{ id: string; name: string }> {
  const vendor = await retrieveCurrentVtigerFinancialRecord(reference);
  if (recordId(vendor.id) !== reference) throw new Error("VTiger supplier reference did not return the exact assigned Vendor.");
  const name = text(vendor.vendorname ?? vendor.vendor_name ?? vendor.name);
  if (!name) throw new Error("Assigned VTiger Vendor has no usable name.");
  return { id: reference, name };
}

/** Re-reads exact current Container Control and its referenced Vendor; never trusts webhook values. */
export async function readForHireContainerControl(recordIdValue: string): Promise<ForHireContainerControlFacts> {
  const raw = await retrieveCurrentVtigerFinancialRecord(recordIdValue);
  if (recordId(raw.id) !== recordIdValue) throw new Error("VTiger Container Control retrieve did not return the exact requested record.");
  const supplierId = recordId(raw.cf_vtcmcontainercontrols_suppliername ?? raw.suppliername);
  let supplierName = "";
  if (supplierId) supplierName = (await resolveVendor(supplierId)).name;
  return {
    recordId: recordIdValue,
    controlNumber: text(raw.vtcmcontainercontrolsnumber),
    acquisition: text(raw.cf_vtcmcontainercontrols_acquisition),
    status: text(raw.cf_vtcmcontainercontrols_status),
    containerNumber: text(raw.fld_vtcmcontainercontrolsname),
    containerType: text(raw.cf_vtcmcontainercontrols_containertype),
    collectionDate: text(raw.cf_vtcmcontainercontrols_collectiondate),
    supplierVtigerId: supplierId,
    supplierName,
    monthlyCostInclusive: toNumber(raw.cf_vtcmcontainercontrols_costpermonth),
    purchasePriceInclusive: toNumber(raw.cf_vtcmcontainercontrols_purchaseprice),
    liftAndBookingFeesInclusive: toNumber(raw.cf_vtcmcontainercontrols_liftrelocationfees),
    sourceRefreshedAt: sourceRefresh(raw)?.toISOString() ?? null,
  };
}

function preflightReason(document: ForHirePoPreview["document"], preflight: FinancialXeroPreflight | null): string | null {
  if (!document || !preflight) return "No valid PO proposal is available for Xero preflight.";
  if (preflight.duplicateState !== "not_found") return `Exact Xero PO ${document.proposedDocumentNumber} is ${preflight.duplicateState}${preflight.status ? ` (${preflight.status})` : ""}; AP will not bypass or adopt it.`;
  if (!preflight.contactCheck.found || !preflight.contactCheck.contactId) return "Xero supplier contact is missing, ambiguous or not an exact match.";
  const codes = Array.from(new Set(document.lineItems.map((line) => line.itemCode).filter(Boolean)));
  if (codes.some((code) => !preflight.itemChecks.some((item) => item.itemCode === code && item.found))) return "A required Xero purchase item is unavailable.";
  return null;
}

function applyPreflightContact(document: NonNullable<ForHirePoPreview["document"]>, preflight: FinancialXeroPreflight): void {
  const contactId = preflight.contactCheck.contactId;
  if (preflight.contactCheck.found && contactId) document.partySourceId = contactId;
}

function holdRecord(input: {
  facts: ForHireContainerControlFacts;
  kind: "initial" | "recurring";
  preview: ForHirePoPreview;
  sourceHash: string;
  reason: string;
  preflight?: FinancialXeroPreflight | null;
}): Promise<void> {
  const periodStart = input.preview.periodStart ?? safeHoldPeriod(input.facts.collectionDate);
  const periodEnd = input.preview.periodEnd ?? periodStart;
  const number = input.preview.proposedPoNumber ?? `UNRESOLVED-${input.kind}-${input.facts.recordId}`;
  return recordForHirePreview({
    containerControlId: input.facts.recordId,
    containerControlNumber: input.facts.controlNumber || input.facts.recordId,
    eventKind: input.kind,
    billingPeriodStart: periodStart,
    billingPeriodEnd: periodEnd,
    proposedPoNumber: number,
    containerNumber: input.facts.containerNumber,
    containerType: input.facts.containerType,
    supplierVtigerId: input.facts.supplierVtigerId || null,
    supplierName: input.facts.supplierName || null,
    sourceRefreshedAt: input.facts.sourceRefreshedAt ? new Date(input.facts.sourceRefreshedAt) : null,
    sourceSnapshotHash: input.sourceHash,
    rulesSnapshotHash: FOR_HIRE_RULES_HASH,
    xeroPreflightHash: input.preflight ? financialSha256(input.preflight) : null,
    proposal: input.preview.document,
    xeroPreflight: input.preflight ?? null,
    status: normalized(input.facts.status) === "DEHIRED" ? "dehired" : "held",
    holdReason: input.reason,
  }).then(() => undefined);
}

export type ForHirePreviewResult = {
  kind: "initial" | "recurring";
  facts: ForHireContainerControlFacts;
  lifecycle: Awaited<ReturnType<typeof getForHireEventsForControl>>;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  preview: ForHirePoPreview;
  preflight: FinancialXeroPreflight | null;
  state: ForHirePreviewState;
  holdReason: string | null;
  noWrites: true;
};

async function preflightPreview(input: {
  kind: "initial" | "recurring";
  facts: ForHireContainerControlFacts;
  sourceHash: string;
  preview: ForHirePoPreview;
}): Promise<ForHirePreviewResult> {
  const lifecycle = await getForHireEventsForControl(input.facts.recordId);
  if (!input.preview.eligible || !input.preview.document) {
    const reason = input.preview.holdReason ?? "For Hire PO source eligibility is incomplete.";
    await holdRecord({ facts: input.facts, kind: input.kind, preview: input.preview, sourceHash: input.sourceHash, reason });
    return { kind: input.kind, facts: input.facts, lifecycle, sourceSnapshotHash: input.sourceHash, rulesSnapshotHash: FOR_HIRE_RULES_HASH,
      xeroPreflightHash: null, preview: input.preview, preflight: null, state: normalized(input.facts.status) === "DEHIRED" ? "dehired" : "held", holdReason: reason, noWrites: true };
  }
  try {
    const [preflight] = await preflightFinancialXeroIntents([input.preview.document]);
    const reason = preflightReason(input.preview.document, preflight ?? null);
    if (reason || !preflight) {
      await holdRecord({ facts: input.facts, kind: input.kind, preview: input.preview, sourceHash: input.sourceHash, reason: reason ?? "Xero GET-only preflight was not completed.", preflight: preflight ?? null });
      return { kind: input.kind, facts: input.facts, lifecycle, sourceSnapshotHash: input.sourceHash, rulesSnapshotHash: FOR_HIRE_RULES_HASH,
        xeroPreflightHash: preflight ? financialSha256(preflight) : null, preview: input.preview, preflight: preflight ?? null, state: "held", holdReason: reason ?? "Xero GET-only preflight was not completed.", noWrites: true };
    }
    applyPreflightContact(input.preview.document, preflight);
    const xeroPreflightHash = financialSha256(preflight);
    await recordForHirePreview({
      containerControlId: input.facts.recordId, containerControlNumber: input.facts.controlNumber, eventKind: input.kind,
      billingPeriodStart: input.preview.periodStart!, billingPeriodEnd: input.preview.periodEnd!, proposedPoNumber: input.preview.proposedPoNumber!,
      containerNumber: input.facts.containerNumber, containerType: input.facts.containerType,
      supplierVtigerId: input.facts.supplierVtigerId, supplierName: input.facts.supplierName,
      sourceRefreshedAt: input.facts.sourceRefreshedAt ? new Date(input.facts.sourceRefreshedAt) : null,
      sourceSnapshotHash: input.sourceHash, rulesSnapshotHash: FOR_HIRE_RULES_HASH, xeroPreflightHash,
      proposal: input.preview.document, xeroPreflight: preflight, status: "previewed", holdReason: null,
    });
    return { kind: input.kind, facts: input.facts, lifecycle, sourceSnapshotHash: input.sourceHash, rulesSnapshotHash: FOR_HIRE_RULES_HASH,
      xeroPreflightHash, preview: input.preview, preflight, state: "previewed", holdReason: null, noWrites: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Xero GET-only preflight could not be completed.";
    await holdRecord({ facts: input.facts, kind: input.kind, preview: input.preview, sourceHash: input.sourceHash, reason });
    return { kind: input.kind, facts: input.facts, lifecycle, sourceSnapshotHash: input.sourceHash, rulesSnapshotHash: FOR_HIRE_RULES_HASH,
      xeroPreflightHash: null, preview: input.preview, preflight: null, state: "held", holdReason: reason, noWrites: true };
  }
}

/** Administrator-invoked, current-source, GET-only initial Request PO preview. */
export async function previewInitialForHirePo(recordId: string): Promise<ForHirePreviewResult> {
  const facts = await readForHireContainerControl(recordId);
  const sourceHash = sourceSnapshotHash({ ...facts, rulesVersion: FOR_HIRE_RULES_VERSION });
  return preflightPreview({ kind: "initial", facts, sourceHash, preview: buildInitialForHirePo(facts) });
}

/** Administrator-invoked, current-source, GET-only next extension preview. */
export async function previewRecurringForHirePo(recordId: string, now?: string): Promise<ForHirePreviewResult> {
  const facts = await readForHireContainerControl(recordId);
  const sourceHash = sourceSnapshotHash({ ...facts, rulesVersion: FOR_HIRE_RULES_VERSION });
  const prior = await lastVerifiedForHirePeriod(recordId);
  const rules = resolveFinancialAutomationRules();
  const feet = /\b20\b/.test(facts.containerType) ? 20 : /\b40\b/.test(facts.containerType) ? 40 : null;
  const itemCode = feet === 20 ? rules.itemCodes.recurringHire20 : feet === 40 ? rules.itemCodes.recurringHire40 : "";
  let rate: number | null = null;
  let nativeDescription: string | null = null;
  // Ask Xero for the current extension item only after the source and an AP
  // previous receipt make a single next period meaningful. No broad source scan.
  if (prior && itemCode) {
    const stub = buildRecurringForHirePo({ facts, priorPeriodEnd: prior.periodEnd, lastVerifiedExtensionSuffix: prior.suffix, purchaseRate: 1 });
    if (stub.document) {
      try {
        const [preflight] = await preflightFinancialXeroIntents([stub.document]);
        const item = preflight?.itemChecks.find((candidate) => candidate.itemCode === itemCode);
        rate = item?.purchaseUnitPrice ?? null;
        nativeDescription = item?.nativeDescription ?? null;
      } catch {
        rate = null;
      }
    }
  }
  const preview = buildRecurringForHirePo({ facts, priorPeriodEnd: prior?.periodEnd ?? null, lastVerifiedExtensionSuffix: prior?.suffix ?? null, purchaseRate: rate, itemNativeDescription: nativeDescription, now });
  return preflightPreview({ kind: "recurring", facts, sourceHash, preview });
}

/** Status-only contract for UI; it exposes neither secret nor an activation control. */
export async function getForHireReadiness() {
  const [config, policy, schedules] = await Promise.all([
    Promise.resolve(resolveFinancialAutomationRules()),
    getForHireReleasePolicy(),
    getFinancialWorkflowSchedules(),
  ]);
  const schedule = schedules.find((item) => item.workflowType === "recurring_for_hire");
  const writerEnabled = process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED === "true" && policy.enabled;
  return {
    module: FOR_HIRE_VTIGER_MODULE,
    futureWebhookPath: FOR_HIRE_FUTURE_WEBHOOK_PATH,
    routeRegistered: true,
    webhookAuthenticationConfigured: Boolean(process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim()),
    recurringPath: FOR_HIRE_RECURRING_PATH,
    recurringCron: FOR_HIRE_RECURRING_CRON,
    heartbeatRegistered: Boolean(schedule?.enabled && schedule.taskUid),
    writerEnabled,
    policy: {
      enabled: policy.enabled,
      effectiveFrom: policy.effectiveFrom,
      forHireOnlyVtigerBranch: policy.forHireOnlyVtigerBranch,
      initialOperationsHandoff: policy.initialOperationsHandoff,
      recurringOperationsHandoff: policy.recurringOperationsHandoff,
      migrationScope: policy.migrationScope,
    },
    sharedOperationsActionUntouched: true,
    legacyRecurringTask: { uid: "PtaAhkr5tHtixG7E4DTZhC", name: "forHireMonthlyPo", callback: "/api/scheduled/forHireMonthlyPo", cadence: "0 0 0 1 * *" },
    ruleSnapshotHash: rulesSnapshotHash(config),
    noWrites: true as const,
  };
}
