import { randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { buildInitialStorageDrafts, firstStoragePeriod, validateLoadedStorageDeal, type StorageDeal } from "./financialStorageDrafts";
import { buildRecurringStorageDrafts, buildFinalStorageDrafts, validateStorageLifecycleFacts } from "./financialStorageLifecycleDrafts";
import { activeStorageRoots, bindStoragePayloads, claimStorageRoot, patchStoragePeriod, releaseStorageRoot, reserveStoragePeriod, storagePeriods, storagePriorExecution } from "./financialStorageLifecycleDb";
import { storedStorageReceipts, claimInitialStorageEvent, updateInitialStorageEvent, type StorageDraftReceipt } from "./financialInitialStorageDb";
import { assertStorageRelease, getStorageReleasePolicy, type StorageReleasePolicy } from "./financialStorageRelease";
import { preflightFinancialXeroIntents, readBackFinancialDraft, verifyInitialStorageXeroAccounts } from "./financialReadOnlyXeroService";
import { prepareFinancialDraftPayload, prepareFinancialDraftUpdatePayload, type FinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { storageDocumentsHash } from "./financialInitialStorageService";
import { createFinancialPostSuccessAction } from "./financialWorkflowDb";
import { planFinancialPostSuccessActions } from "./financialPostSuccessPlan";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";
import type { FinancialInitialStorageEvent } from "../drizzle/schema";
import { financialSha256 } from "./financialProposalIntegrity";
import { isFinancialPostSuccessVtigerWriteEnabled, runFinancialPostSuccessAction } from "./vtigerFinancialWriteService";

export const STORAGE_DATE_OUT_FIELD = "cf_potentials_dateout"; // verified describe Potentials, 10 Oct 2026
const complete = (event: FinancialInitialStorageEvent) => ["drafts_created", "writeback_pending"].includes(event.status);
const today = () => Temporal.Now.zonedDateTimeISO("Australia/Sydney").toPlainDate().toString();
const after = (a: string, b: string) => Temporal.PlainDate.compare(Temporal.PlainDate.from(a), Temporal.PlainDate.from(b)) > 0;
const next = (value: string) => Temporal.PlainDate.from(value).add({ days: 1 }).toString();
const sourceFingerprint = (deal: StorageDeal, period: { start: string; end: string }) => financialSha256({
  dealId: deal.dealId, location: deal.location, container: deal.containerNumber, type: deal.containerType,
  customer: deal.customer, driver: deal.driver, start: period.start, end: period.end,
});

async function party(id: string, kind: "account" | "contact" | "vendor") {
  const value = await retrieveCurrentVtigerFinancialRecord(id);
  if (value.id !== id) throw new Error("Referenced VTiger entity ID mismatch.");
  const name = kind === "account" ? value.accountname : kind === "vendor" ? value.vendorname : `${value.firstname ?? ""} ${value.lastname ?? ""}`.trim();
  if (typeof name !== "string" || !name.trim()) throw new Error("Storage party name is missing.");
  return { name: name.trim(), vtigerId: id, email: typeof value.email === "string" ? value.email : null };
}
async function loadDeal(recordId: string, location?: "origin" | "destination") {
  const raw = await retrieveCurrentVtigerFinancialRecord(recordId);
  const facts = location ? validateStorageLifecycleFacts(raw, recordId, location, STORAGE_DATE_OUT_FIELD) : validateLoadedStorageDeal(raw, recordId);
  const [customer, driver] = await Promise.all([party(facts.customerId, raw.related_to === facts.customerId ? "account" : "contact"), party(facts.driverId, "vendor")]);
  const deal: StorageDeal = { dealId: recordId, dealNumber: facts.dealNumber, location: facts.location, containerNumber: facts.containerNumber,
    containerType: facts.containerType, dateIn: facts.dateIn, deliveryDate: facts.deliveryDate, customer, driver,
    storageSupplier: { name: "Containerzone", vtigerId: "xero-contact", email: null } };
  const dateOut = String(raw[STORAGE_DATE_OUT_FIELD] || raw.cf_potentials_fullcontainerdeliverydate || "").trim() || null;
  return { deal, raw, dateOut };
}

async function queueFollowUp(event: FinancialInitialStorageEvent, document: ProposedFinancialDocument, executionId: number, workflowType: string, source: Record<string, unknown>) {
  const actions = planFinancialPostSuccessActions({ workflowType, document, sourceData: source });
  const queuedIds: number[] = [];
  for (const action of actions) {
    const queued = await createFinancialPostSuccessAction({ executionId, workflowType, actionType: action.actionType,
      sourceRecordId: event.dealId, payloadHash: financialSha256({ eventId: event.id, documents: storageDocumentsHash([document]), action: action.actionType }),
      safePayloadSummary: { ...action.safePayloadSummary, storageLocation: event.location, billingPeriod: `${event.periodStart}–${source.dateOut ?? event.periodEnd}` } });
    queuedIds.push(queued.id);
  }
  if (!isFinancialPostSuccessVtigerWriteEnabled()) throw new Error("VTiger follow-ups queued; independent post-success gate is disabled.");
  for (const id of queuedIds) await runFinancialPostSuccessAction(id);
}

/** All documents are reconciled/preflighted before the first write; no suffix bypass or legacy adoption. */
async function executeBundle(event: FinancialInitialStorageEvent, documents: ProposedFinancialDocument[], policy: StorageReleasePolicy,
  workflowType: "storage_activation" | "recurring_storage" | "storage_finalisation", finalDate?: string, originalDocuments?: ProposedFinancialDocument[]) {
  const previous = finalDate ? (Array.isArray(event.finalisationResults) ? event.finalisationResults as StorageDraftReceipt[] : []) : storedStorageReceipts(event);
  const created = storedStorageReceipts(event);
  const checks = await preflightFinancialXeroIntents(documents);
  const payloads: FinancialDraftPayload[] = [];
  for (let index = 0; index < documents.length; index++) {
    const doc = documents[index]!; const check = checks[index]!;
    if (!check?.contactCheck.found || !check.contactCheck.contactId) throw new Error(`No unique Xero contact for ${doc.proposedDocumentNumber}.`);
    doc.partySourceId = check.contactCheck.contactId;
    if (doc.documentType === "jd_transport") {
      const item = check.itemChecks.find(v => v.itemCode === doc.lineItems[0]?.itemCode);
      if (!item?.nativeDescription) throw new Error("JD purchase item wording is unavailable.");
      doc.lineItems[0]!.description = item.nativeDescription;
    }
    const receipt = previous.find(v => v.number === doc.proposedDocumentNumber);
    if (receipt) {
      await readBackFinancialDraft({ documentFamily: doc.documentFamily, documentNumber: receipt.number, expectedXeroDocumentId: receipt.xeroId, expectedDocument: doc });
      continue;
    }
    const target = finalDate ? created.find(v => v.number === doc.proposedDocumentNumber) : null;
    if (finalDate && target) {
      // Immutable IDs resolve deleted-history ambiguity without accepting another active record.
      const oldDraft = await readBackFinancialDraft({ documentFamily: doc.documentFamily, documentNumber: target.number, expectedXeroDocumentId: target.xeroId });
      if (oldDraft.partyName && oldDraft.partyName.trim().toUpperCase() !== doc.partyName?.trim().toUpperCase()) throw new Error("Finalisation contact differs from the original storage receipt; reconcile before changing supplier/customer.");
      const original = originalDocuments?.find(v => v.proposedDocumentNumber === doc.proposedDocumentNumber);
      if (original) {
        original.partySourceId = doc.partySourceId;
        await readBackFinancialDraft({ documentFamily: doc.documentFamily, documentNumber: target.number, expectedXeroDocumentId: target.xeroId, expectedDocument: original });
      }
      if (check.duplicateState === "found" && check.xeroDocumentId !== target.xeroId) throw new Error("Finalisation Xero ID differs from the stored receipt.");
      if (!["found"].includes(check.duplicateState)) throw new Error("Ambiguous or unavailable finalisation target; no update sent.");
      payloads.push(prepareFinancialDraftUpdatePayload(doc, `${event.id}:final:${finalDate}`, { xeroDocumentId: target.xeroId, documentNumber: target.number, status: "DRAFT" }));
    } else {
      if (finalDate) {
        assertStorageRelease(policy, "recovery");
        doc.proposedAction = "create_draft";
      }
      const payload = prepareFinancialDraftPayload(doc, `${event.dealId}:${event.location}:${event.periodStart}`);
      ((payload.body.Invoices ?? payload.body.PurchaseOrders) as Record<string, unknown>[])[0]!.CurrencyCode = "AUD";
      if (check.duplicateState !== "not_found") {
        const attempt = await storagePriorExecution(payload);
        if (check.duplicateState !== "found" || check.status !== "DRAFT" || !check.xeroDocumentId || !attempt ||
          attempt.approvalReference !== policy.releaseKey || attempt.payloadFingerprint !== financialSha256(payload.body) ||
          !["submitted", "succeeded", "reconciliation_required"].includes(attempt.status)) throw new Error(`Exact Xero reference ${doc.proposedDocumentNumber} is occupied; no duplicate or suffix bypass.`);
        await readBackFinancialDraft({ documentFamily: doc.documentFamily, documentNumber: payload.documentNumber, expectedXeroDocumentId: check.xeroDocumentId, expectedDocument: doc });
        previous.push({ documentType: doc.documentFamily === "customer_invoice" ? "customer_invoice" : doc.documentType === "jd_transport" ? "jd_transport" : "gd_storage", number: payload.documentNumber, xeroId: check.xeroDocumentId, status: "DRAFT", readBackAt: new Date().toISOString() });
        await patchStoragePeriod(event.id, finalDate ? { finalisationResults: previous } : { documentResults: previous });
        continue;
      }
      payloads.push(payload);
    }
  }
  for (const payload of payloads) {
    const row = ((payload.body.Invoices ?? payload.body.PurchaseOrders) as Record<string, unknown>[])[0]!; row.CurrencyCode = "AUD";
  }
  if (!(await claimInitialStorageEvent(event.id))) throw new Error("Storage period is already claimed; no second write.");
  await bindStoragePayloads(event.id, policy.releaseKey, payloads, workflowType);
  let lastExecutionId: number | null = null;
  try {
    for (const payload of payloads) {
      const doc = documents.find(v => v.proposedDocumentNumber === payload.documentNumber)!;
      const outcome = await executeGuardedFinancialWriterCommand({ workflowType, proposedAction: doc.proposedAction as "create_draft" | "update_draft", payload,
        expectedDraftDocument: doc,
        preparedBy: policy.approvedBy!, authorisation: { workflowType, approvalReference: policy.releaseKey,
          storageAutomaticEventId: event.id, storageReleaseKey: policy.releaseKey, storageApprovedBy: policy.approvedBy!,
          globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true } });
      let xeroId: string;
      if (outcome.outcome === "succeeded") xeroId = outcome.result.xeroDocumentId;
      else if (outcome.outcome === "duplicate" && outcome.xeroDocumentId) xeroId = outcome.xeroDocumentId;
      else throw new Error("Storage Draft result is uncertain; reconcile the exact execution before retry.");
      await readBackFinancialDraft({ documentFamily: doc.documentFamily, documentNumber: payload.documentNumber, expectedXeroDocumentId: xeroId, expectedDocument: doc });
      lastExecutionId = outcome.executionId;
      previous.push({ documentType: doc.documentFamily === "customer_invoice" ? "customer_invoice" : doc.documentType === "jd_transport" ? "jd_transport" : "gd_storage",
        number: payload.documentNumber, xeroId, status: "DRAFT", readBackAt: new Date().toISOString() });
      await patchStoragePeriod(event.id, finalDate ? { finalisationResults: previous, finalDate } : { documentResults: previous });
    }
    if (previous.length !== documents.length) throw new Error("Storage bundle has incomplete read-back receipts.");
    if (finalDate) {
      const merged = [...created.filter(v => !previous.some(p => p.number === v.number)), ...previous];
      await patchStoragePeriod(event.id, { documentResults: merged });
    }
    await updateInitialStorageEvent({ id: event.id, status: "drafts_created", ...(finalDate ? {} : { receipts: previous }) });
    if (lastExecutionId) {
      try {
        await queueFollowUp(event, documents[0]!, lastExecutionId, workflowType, { stage: finalDate ? String((await retrieveCurrentVtigerFinancialRecord(event.dealId)).sales_stage ?? "") : "", location: event.location, dateOut: finalDate });
      } catch { await patchStoragePeriod(event.id, { status: "writeback_pending", errorMessage: "Verified Xero Drafts; VTiger follow-up must be reconciled." }); }
    }
    return { ok: true, status: "drafts_created", eventId: event.id, documents: previous.map(v => v.number) };
  } catch (error) {
    await patchStoragePeriod(event.id, { status: previous.length ? "partial" : "failed", errorMessage: "Storage execution failed or requires reconciliation; inspect the AP execution ledger." });
    throw error;
  }
}

export async function processAutomaticInitialStorage(recordId: string) {
  const policy = await getStorageReleasePolicy(); assertStorageRelease(policy, "initial");
  const { deal, dateOut } = await loadDeal(recordId);
  if (after(deal.dateIn, today())) throw new Error("Storage Date In is future-dated in Sydney.");
  if (dateOut && !after(dateOut, today())) throw new Error("Completed storage must use finalisation/recovery, not initial creation.");
  await verifyInitialStorageXeroAccounts();
  const period = firstStoragePeriod(deal.dateIn, deal.deliveryDate);
  const rows = await storagePeriods(recordId, deal.location);
  const existing = rows.find(v => v.periodStart === period.start);
  if (rows.length && !existing) throw new Error("This location already has storage billing history; a changed Date In cannot start another initial period.");
  if (existing && complete(existing)) return { ok: true, status: "duplicate_replay", eventId: existing.id };
  const event = await reserveStoragePeriod({ dealId: recordId, dealNumber: deal.dealNumber, location: deal.location, periodStart: period.start, periodEnd: period.end,
    containerNumber: deal.containerNumber, containerType: deal.containerType, sourceHash: sourceFingerprint(deal, period) }, "initial");
  if (event.sourceHash !== sourceFingerprint(deal, period)) throw new Error("Source facts changed since initial reservation; reconcile before retry.");
  const token = randomUUID(); if (!(await claimStorageRoot(event.id, token))) throw new Error("Storage location is already processing.");
  try {
    const { documents } = buildInitialStorageDrafts(deal, event.suffix, event.suffix === "A");
    const result = await executeBundle(event, documents, policy, "storage_activation");
    await patchStoragePeriod(event.id, { nextBillingDate: next(period.end) });
    return result;
  } catch (error) {
    await patchStoragePeriod(event.id, { errorMessage: "Initial storage held or needs reconciliation. Check exact references, source facts and AP executions." });
    throw error;
  } finally { await releaseStorageRoot(event.id, token); }
}

export async function processRecurringStorageRoot(root: FinancialInitialStorageEvent, now = today()) {
  const policy = await getStorageReleasePolicy(); assertStorageRelease(policy, "recurring");
  const token = randomUUID(); if (!(await claimStorageRoot(root.id, token))) return { ok: false, status: "held", reason: "Storage location is locked or finalised." };
  try {
    if (storedStorageReceipts(root).length !== 3) throw new Error("Recurring storage requires all three verified activation receipts.");
    const { deal, dateOut, raw } = await loadDeal(root.dealId, root.location);
    if (root.containerNumber !== deal.containerNumber || root.containerType !== deal.containerType) throw new Error("Container changed since verified activation; recurring billing held.");
    // Only the current matching stage may recur. Moving away from storage cannot bill.
    validateLoadedStorageDeal(raw, root.dealId);
    if (dateOut) return { ok: true, status: "skipped", reason: "Date Out/delivery is set; finalisation is required." };
    const rows = await storagePeriods(root.dealId, root.location);
    const done = rows.filter(complete).sort((a,b) => b.periodEnd.localeCompare(a.periodEnd));
    const latest = done[0]; if (!latest) throw new Error("No verified activation receipts; recurrence cannot infer billing history.");
    if (storedStorageReceipts(latest).length !== (latest.eventKind === "recurring" ? 2 : 3)) throw new Error("Latest billed period lacks complete verified receipts.");
    const due = next(latest.periodEnd);
    if (rows.some(v => !complete(v) && v.periodStart !== due)) throw new Error("Another incomplete storage period requires reconciliation before recurrence.");
    if (due !== now) return { ok: true, status: "skipped", reason: after(due, now) ? "Not due." : "Billing gap held; no catch-up batch." };
    const existing = rows.find(v => v.periodStart === due);
    const preview = buildRecurringStorageDrafts(deal, existing?.suffix ?? "B", latest.periodEnd);
    const event = await reserveStoragePeriod({ dealId: deal.dealId, dealNumber: deal.dealNumber, location: deal.location, periodStart: preview.period.start, periodEnd: preview.period.end,
      containerNumber: deal.containerNumber, containerType: deal.containerType, sourceHash: sourceFingerprint(deal, preview.period) }, "recurring", root.id);
    if (event.sourceHash !== sourceFingerprint(deal, preview.period)) throw new Error("Recurring source facts changed since reservation; reconcile before retry.");
    const { documents } = buildRecurringStorageDrafts(deal, event.suffix, latest.periodEnd);
    const result = await executeBundle(event, documents, policy, "recurring_storage");
    await patchStoragePeriod(root.id, { nextBillingDate: next(preview.period.end) });
    return result;
  } catch (error) {
    await patchStoragePeriod(root.id, { errorMessage: "Monthly storage held or needs reconciliation. No catch-up billing or suffix bypass is permitted." });
    throw error;
  } finally { await releaseStorageRoot(root.id, token); }
}

export async function runAutomaticRecurringStorage(now = today()) {
  if (Temporal.PlainDate.from(now).day !== 1) return { ok: true, status: "skipped", reason: "Not first Australia/Sydney calendar day." };
  const policy = await getStorageReleasePolicy(); assertStorageRelease(policy, "recurring");
  const roots = await activeStorageRoots(10, now);
  const results = [];
  for (const root of roots) {
    try { results.push({ deal: root.dealNumber, ...await processRecurringStorageRoot(root, now) }); }
    catch { results.push({ deal: root.dealNumber, ok: false, status: "held", reason: "Storage billing held; inspect AP ledger/source evidence." }); }
  }
  const remaining = await activeStorageRoots(1, now);
  const progressed = results.some(v => v.ok && v.status === "drafts_created");
  return { ok: true, considered: roots.length, results, retryRemainingBatch: progressed && remaining.length > 0 };
}

export async function processStorageFinalisation(recordId: string, location: "origin" | "destination") {
  const policy = await getStorageReleasePolicy(); assertStorageRelease(policy, "finalisation");
  const { deal, dateOut } = await loadDeal(recordId, location);
  if (!dateOut || after(dateOut, today())) throw new Error("Finalisation requires a current, non-future VTiger Date Out/delivery date.");
  const rows = await storagePeriods(recordId, location); const root = rows.find(v => !v.parentEventId);
  if (!root || (root.eventKind === "recovery" && !root.finalisedAt)) {
    assertStorageRelease(policy, "recovery");
    // Controlled missing-document recovery uses the true initial capped period, never suffix-bypasses old records.
    deal.deliveryDate = dateOut;
    const built = buildInitialStorageDrafts(deal, root?.suffix ?? "A", (root?.suffix ?? "A") === "A");
    const event = await reserveStoragePeriod({ dealId: recordId, dealNumber: deal.dealNumber, location, periodStart: built.period.start, periodEnd: built.period.end,
      containerNumber: deal.containerNumber, containerType: deal.containerType, sourceHash: sourceFingerprint(deal, built.period) }, "recovery");
    if (event.sourceHash !== sourceFingerprint(deal, built.period)) throw new Error("Recovery source facts changed; reconcile before retry.");
    const token = randomUUID(); if (!(await claimStorageRoot(event.id, token))) throw new Error("Recovery is already processing.");
    try {
      const recovery = buildInitialStorageDrafts(deal, event.suffix, event.suffix === "A");
      if (recovery.period.end !== dateOut) throw new Error("Missing multi-month history cannot be recovered as one invented period.");
      const result = await executeBundle(event, recovery.documents, policy, "storage_finalisation");
      await patchStoragePeriod(event.id, { finalisedAt: new Date(), finalDate: dateOut, nextBillingDate: null });
      return result;
    } finally { await releaseStorageRoot(event.id, token); }
  }
  if (root.finalisedAt) {
    if (root.finalDate !== dateOut) throw new Error("Date Out changed after finalisation; do not silently reopen billed storage.");
    return { ok: true, status: "duplicate_replay", eventId: root.id };
  }
  const token = randomUUID(); if (!(await claimStorageRoot(root.id, token))) throw new Error("Monthly/finalisation work already holds this storage location.");
  try {
    const latest = [...rows].sort((a,b) => b.periodStart.localeCompare(a.periodStart))[0]!;
    if (!complete(latest) && latest.status !== "partial" && latest.status !== "failed") throw new Error("Incomplete activation requires reconciliation before finalisation.");
    if (after(dateOut, latest.periodEnd)) {
      assertStorageRelease(policy, "recovery");
      const lastMonth = buildRecurringStorageDrafts({ ...deal, deliveryDate: null }, "B", latest.periodEnd).period;
      if (after(dateOut, lastMonth.end)) throw new Error("Multiple unbilled months require reviewed history reconciliation, not a bulk catch-up.");
      const finalMonth = buildRecurringStorageDrafts({ ...deal, deliveryDate: dateOut }, "B", latest.periodEnd);
      const period = await reserveStoragePeriod({ dealId: recordId, dealNumber: deal.dealNumber, location, periodStart: finalMonth.period.start,
        periodEnd: finalMonth.period.end, containerNumber: deal.containerNumber, containerType: deal.containerType,
        sourceHash: sourceFingerprint(deal, finalMonth.period) }, "recurring", root.id);
      if (period.sourceHash !== sourceFingerprint(deal, finalMonth.period)) throw new Error("Final-period recovery facts changed; reconcile before retry.");
      const build = buildRecurringStorageDrafts({ ...deal, deliveryDate: dateOut }, period.suffix, latest.periodEnd);
      for (const doc of build.documents) doc.sourceWorkflow = "storage_finalisation";
      const result = await executeBundle(period, build.documents, policy, "storage_finalisation", dateOut);
      await patchStoragePeriod(root.id, { finalisedAt: new Date(), finalDate: dateOut, nextBillingDate: null });
      return result;
    }
    if (after(latest.periodStart, dateOut)) throw new Error("Date Out precedes an already billed period; reconcile history before changing documents.");
    if (latest.finalDate && latest.finalDate !== dateOut) throw new Error("Date Out changed after partial finalisation; reconcile the stored finalisation first.");
    if (latest.containerNumber !== deal.containerNumber || latest.containerType !== deal.containerType) throw new Error("Container changed since billed storage; reconcile before finalisation.");
    const built = buildFinalStorageDrafts(deal, latest.suffix, latest.eventKind !== "recurring" && latest.suffix === "A", latest.periodStart, dateOut);
    if (latest.eventKind !== "recurring" && !storedStorageReceipts(latest).some(v => v.documentType === "jd_transport")) {
      assertStorageRelease(policy, "recovery");
      const transport = buildInitialStorageDrafts({ ...deal, deliveryDate: dateOut }, latest.suffix, latest.suffix === "A").documents[1];
      transport.sourceWorkflow = "storage_finalisation";
      built.documents.push(transport);
    }
    // claimInitialStorageEvent accepts retry states; keep original receipts intact for target IDs.
    await patchStoragePeriod(latest.id, { status: "held" }); latest.status = "held";
    const baseline = buildFinalStorageDrafts(deal, latest.suffix, latest.eventKind !== "recurring" && latest.suffix === "A", latest.periodStart, latest.periodEnd).documents;
    const result = await executeBundle(latest, built.documents, policy, "storage_finalisation", dateOut, baseline);
    await patchStoragePeriod(root.id, { finalisedAt: new Date(), finalDate: dateOut, nextBillingDate: null });
    return result;
  } catch (error) {
    await patchStoragePeriod(root.id, { errorMessage: "Finalisation held or needs reconciliation. Original and partial Draft receipts are retained." });
    throw error;
  } finally { await releaseStorageRoot(root.id, token); }
}

/** Reference-only final-period calculation; existing Xero records are read, never changed/imported. */
export async function previewStorageFinalisation(recordId: string, location: "origin" | "destination", suffix = "A") {
  const { deal, dateOut } = await loadDeal(recordId, location);
  if (!dateOut) throw new Error("VTiger has no Date Out/delivery date.");
  const built = buildFinalStorageDrafts(deal, suffix, suffix === "A", deal.dateIn, dateOut);
  const evidence = await preflightFinancialXeroIntents(built.documents);
  return { dealNumber: deal.dealNumber, location, dateOut, period: built.period, referenceOnly: true as const,
    documents: built.documents.map((d,i) => ({ number: d.proposedDocumentNumber, subtotal: d.subtotal, tax: d.taxAmount, total: d.total, xeroState: evidence[i]?.duplicateState, xeroId: evidence[i]?.xeroDocumentId, xeroStatus: evidence[i]?.status })) };
}
