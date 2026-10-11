import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { financialWarrantyAvisoEvents as events, type FinancialWarrantyAvisoEvent } from "../drizzle/schema";
import { getDb } from "./db";
import { financialSha256 } from "./financialProposalIntegrity";
import type { WarrantyReleasePolicy } from "./financialWarrantyAvisoRelease";
import type { WarrantyFacts, WarrantyPlan, WarrantyXeroEvidence } from "./financialWarrantyAvisoRules";
async function database() { const db = await getDb(); if (!db) throw new Error("Warranty AP ledger unavailable; generated migration requires parent review/application."); return db; }
export async function getWarrantyEvents(limit = 100) { return (await database()).select().from(events).orderBy(desc(events.id)).limit(Math.max(1, Math.min(200, limit))); }
export async function getWarrantyEvent(id: number): Promise<FinancialWarrantyAvisoEvent | null> { return (await (await database()).select().from(events).where(eq(events.id, id)).limit(1))[0] ?? null; }
export async function getWarrantyDealClaim(dealNumber: string): Promise<FinancialWarrantyAvisoEvent | null> {
  return (await (await database()).select().from(events).where(eq(events.claimKey, `warranty:${dealNumber}`)).limit(1))[0] ?? null;
}
export async function getWarrantyExecutionEntries(group: string) { return (await database()).select().from(events).where(eq(events.executionGroup, group)).orderBy(desc(events.id)); }
async function insert(input: typeof events.$inferInsert): Promise<FinancialWarrantyAvisoEvent> {
  const db = await database(); await db.insert(events).values(input);
  const result = (await db.select().from(events).where(eq(events.eventKey, input.eventKey)).limit(1))[0];
  if (!result) throw new Error("Immutable warranty ledger entry could not be read back; hold.");
  return result;
}
/** Every preview creates new immutable current evidence, no upsert and no shadow import. */
export function recordWarrantyPreview(facts: WarrantyFacts, evidence: WarrantyXeroEvidence | null, plan: WarrantyPlan | null, reason: string | null) {
  return insert({ eventKey: `preview:${randomUUID()}`, dealId: facts.dealId, dealNumber: facts.dealNumber || null, status: reason ? "held" : "previewed",
    sourceSnapshot: facts, sourceSnapshotHash: financialSha256(facts), sourceMappingsHash: facts.sourceMappingsHash, addedServicesMappingHash: facts.addedServicesMappingHash,
    xeroPreflight: evidence, xeroPreflightHash: evidence ? financialSha256(evidence) : null, proposal: plan, holdReason: reason });
}
/** Atomic unique Deal claim: one lifetime warranty attempt only, regardless of source timestamp changes. */
export async function reserveWarranty(preview: FinancialWarrantyAvisoEvent, policy: WarrantyReleasePolicy, plan: WarrantyPlan) {
  if (preview.status !== "previewed" || !preview.dealNumber || financialSha256(preview.proposal) !== financialSha256(plan)) throw new Error("Exact freshly previewed warranty plan required.");
  const group = randomUUID();
  return insert({ eventKey: `reserve:${group}`, claimKey: `warranty:${preview.dealNumber}`, executionGroup: group, dealId: preview.dealId, dealNumber: preview.dealNumber,
    status: "reserved", sourceSnapshot: preview.sourceSnapshot, sourceSnapshotHash: preview.sourceSnapshotHash, sourceMappingsHash: preview.sourceMappingsHash,
    addedServicesMappingHash: preview.addedServicesMappingHash, xeroPreflight: preview.xeroPreflight, xeroPreflightHash: preview.xeroPreflightHash, proposal: plan,
    releaseKey: policy.releaseKey, approvedBy: policy.approvedBy, authorisedPayload: { policyHash: financialSha256(policy), main: plan.mainPayload, po: plan.poPayload,
      mainHash: financialSha256(plan.mainPayload), poHash: financialSha256(plan.poPayload), expectedMain: plan.expectedMain, expectedPo: plan.expectedPo } });
}
/** Consumption insert precedes HTTP. Unique event key makes even a process crash or DB receipt failure non-retryable. */
export async function consumeWarrantyStep(reservation: FinancialWarrantyAvisoEvent, step: "main" | "po") {
  if (!reservation.executionGroup || reservation.status !== "reserved") throw new Error("Immutable warranty reservation missing.");
  const prior = await getWarrantyExecutionEntries(reservation.executionGroup);
  const verifiedMainReadback = prior.some(
    e =>
      e.status === "main_receipt" &&
      (e.receipt as Record<string, unknown> | null)?.readbackVerified === true
  );
  if (prior.some(e => e.status === "reconciliation_required" || e.status === "drafts_created") || step === "po" && !verifiedMainReadback) throw new Error("Warranty partial/uncertain/completed execution cannot retry or bypass verified main readback.");
  return insert({ eventKey: `${reservation.executionGroup}:${step}:attempt`, executionGroup: reservation.executionGroup, dealId: reservation.dealId, dealNumber: reservation.dealNumber,
    status: step === "main" ? "main_submitted" : "po_submitted", releaseKey: reservation.releaseKey });
}
export function recordWarrantyReceipt(reservation: FinancialWarrantyAvisoEvent, step: "main" | "po", receipt: unknown) {
  return insert({ eventKey: `${reservation.executionGroup}:${step}:receipt`, executionGroup: reservation.executionGroup, dealId: reservation.dealId, dealNumber: reservation.dealNumber,
    status: step === "main" ? "main_receipt" : "po_receipt", receipt, releaseKey: reservation.releaseKey });
}
export async function finishWarranty(reservation: FinancialWarrantyAvisoEvent, status: "drafts_created" | "reconciliation_required", reason: string | null, receipt?: unknown) {
  return insert({ eventKey: `${reservation.executionGroup}:finish`, executionGroup: reservation.executionGroup, dealId: reservation.dealId, dealNumber: reservation.dealNumber,
    status, holdReason: reason?.slice(0, 2000) ?? null, receipt: receipt ?? null, releaseKey: reservation.releaseKey });
}
