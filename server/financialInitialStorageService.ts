import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { retrieveCurrentVtigerFinancialRecord } from "./vtigerFinancialReadService";
import { buildInitialStorageDrafts, firstStoragePeriod, validateLoadedStorageDeal, type StorageDeal, type StorageParty } from "./financialStorageDrafts";
import { claimInitialStorageEvent, reserveInitialStorageEvent, storedStorageReceipts, updateInitialStorageEvent, type StorageDraftReceipt } from "./financialInitialStorageDb";
import { preflightFinancialXeroIntents, readBackFinancialDraft, verifyInitialStorageXeroAccounts } from "./financialReadOnlyXeroService";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { createFinancialPostSuccessAction } from "./financialWorkflowDb";
import { isFinancialPostSuccessVtigerWriteEnabled, runFinancialPostSuccessAction } from "./vtigerFinancialWriteService";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function sha256(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeFailure(error: unknown): string { return error instanceof Error ? error.message.slice(0, 400) : "Storage validation or Draft execution failed."; }

export function storageDocumentsHash(documents: ProposedFinancialDocument[]): string {
  return sha256(documents.map((doc) => ({ number: doc.proposedDocumentNumber, party: doc.partyName, amount: doc.subtotal,
    date: doc.issueDate?.toISOString(), due: doc.dueDate?.toISOString(), lines: doc.lineItems })));
}

export function storagePreflightHash(preflight: Awaited<ReturnType<typeof preflightFinancialXeroIntents>>, documents: ProposedFinancialDocument[]): string {
  return sha256({
    preflight: preflight.map((row) => ({ number: row.documentNumber, duplicateState: row.duplicateState,
      contactId: row.contactCheck.contactId, items: row.itemChecks })),
    documents: documents.map((doc) => ({ number: doc.proposedDocumentNumber, partySourceId: doc.partySourceId, lines: doc.lineItems })),
  });
}

async function resolveParty(recordId: string, kind: "account" | "contact" | "vendor"): Promise<StorageParty> {
  const record = await retrieveCurrentVtigerFinancialRecord(recordId);
  if (text(record.id) !== recordId) throw new Error("VTiger referenced entity does not match the Deal reference.");
  const name = kind === "vendor" ? text(record.vendorname) : kind === "account"
    ? text(record.accountname) : [text(record.firstname), text(record.lastname)].filter(Boolean).join(" ");
  if (!name) throw new Error(`VTiger ${kind} reference has no usable name.`);
  return { name, vtigerId: recordId, email: text(record.email1 ?? record.email) || null };
}

export type InitialStorageResult = {
  ok: boolean;
  status: "held" | "failed" | "partial" | "drafts_created" | "duplicate_replay" | "writeback_pending";
  dealNumber?: string;
  location?: "origin" | "destination";
  customerInvoice?: string;
  transportPurchaseOrder?: string;
  storagePurchaseOrder?: string;
  warning?: string;
};

/**
 * An authenticated VTiger Deal event enters only this storage-specific workflow.
 * Current stage and all financial facts are refreshed from VTiger; no webhook
 * amount, party or date is trusted. The three Draft transport calls are locked
 * unless the exact local pilot approval and legacy handoff, as well as existing
 * deployment locks, have been explicitly completed in a later approved release.
 */
export async function processInitialLoadedStorage(recordId: string): Promise<InitialStorageResult> {
  const raw = await retrieveCurrentVtigerFinancialRecord(recordId);
  const facts = validateLoadedStorageDeal(raw, recordId);
  if (Temporal.PlainDate.compare(Temporal.PlainDate.from(facts.dateIn), Temporal.Now.zonedDateTimeISO("Australia/Sydney").toPlainDate()) > 0) {
    return { ok: false, status: "held", dealNumber: facts.dealNumber, location: facts.location,
      warning: "VTiger Date In is in the future in Australia/Sydney; no storage event was reserved or sent to Xero." };
  }
  const [customer, driver] = await Promise.all([
    resolveParty(facts.customerId, text(raw.related_to) === facts.customerId ? "account" : "contact"),
    resolveParty(facts.driverId, "vendor"),
  ]);
  const deal: StorageDeal = {
    dealId: recordId, dealNumber: facts.dealNumber, location: facts.location,
    containerNumber: facts.containerNumber, containerType: facts.containerType,
    dateIn: facts.dateIn, deliveryDate: facts.deliveryDate,
    customer, driver,
    storageSupplier: { name: "Containerzone", vtigerId: "xero-contact", email: null },
  };
  const period = firstStoragePeriod(deal.dateIn, deal.deliveryDate);
  const sourceHash = sha256({ recordId, dealNumber: deal.dealNumber, location: deal.location, containerNumber: deal.containerNumber,
    containerType: deal.containerType, period, customer: customer.vtigerId, driver: driver.vtigerId });
  const reservation = await reserveInitialStorageEvent({
    dealId: recordId, dealNumber: deal.dealNumber, location: deal.location,
    periodStart: period.start, periodEnd: period.end,
    containerNumber: deal.containerNumber, containerType: deal.containerType, sourceHash,
  });
  const event = reservation.event;
  const receipts = storedStorageReceipts(event);
  const resultBase = { dealNumber: deal.dealNumber, location: deal.location };
  if (event.status === "drafts_created" || event.status === "writeback_pending") {
    return { ok: true, status: "duplicate_replay", ...resultBase,
      customerInvoice: receipts[0]?.number, transportPurchaseOrder: receipts[1]?.number, storagePurchaseOrder: receipts[2]?.number };
  }
  // A changed Deal after a reservation cannot reuse an old pricing/supplier
  // approval or change a document number. Hold for review, never replay.
  if (event.sourceHash !== sourceHash || event.periodEnd !== period.end) {
    await updateInitialStorageEvent({ id: event.id, status: "held", errorMessage: "Deal facts changed since storage reservation; refresh exact pilot approval." });
    return { ok: false, status: "held", ...resultBase, warning: "Deal facts changed since storage reservation; refresh exact pilot approval." };
  }
  if (event.status === "reserved") return { ok: false, status: "held", ...resultBase, warning: "Storage event is already processing; no second Xero request was sent." };

  const { documents } = buildInitialStorageDrafts(deal, event.suffix, event.suffix === "A");
  const documentsHash = storageDocumentsHash(documents);
  const exactApproval = Boolean(event.pilotApprovalKey && event.approvedDocumentsHash === documentsHash && event.approvalExpiresAt
    && event.approvalExpiresAt.getTime() > Date.now() && event.approvedBy && event.legacyHandoffConfirmedAt);
  // This narrow flag can arm only an already approved Deal/location/period.
  // The broad financial family writer and its global shadow mode stay locked.
  if (!exactApproval || process.env.FINANCIAL_INITIAL_STORAGE_ENABLED !== "true") {
    await updateInitialStorageEvent({ id: event.id, status: "held", errorMessage: "Exact named pilot approval, legacy handoff or storage-only release gate is missing." });
    return { ok: false, status: "held", ...resultBase, warning: "Initial storage Drafts are prepared but the exact pilot approval, legacy handoff and deployment gates are not enabled." };
  }

  // Only approved operations reach accounting GETs and the guarded transport.
  // Contact matching is exact; no silent creation or ambiguous name matching.
  try {
    await verifyInitialStorageXeroAccounts();
    const preflight = await preflightFinancialXeroIntents(documents);
    for (let i = 0; i < documents.length; i += 1) {
      const document = documents[i]!;
      const evidence = preflight[i]!;
      const stored = receipts.find((receipt) => receipt.number === document.proposedDocumentNumber);
      if (stored) {
        await readBackFinancialDraft({ documentFamily: document.documentFamily, documentNumber: stored.number, expectedXeroDocumentId: stored.xeroId });
        continue;
      }
      if (evidence.duplicateState !== "not_found") throw new Error(`Xero document ${document.proposedDocumentNumber} already exists or preflight failed; reconcile before retry.`);
      if (!evidence.contactCheck.found || !evidence.contactCheck.contactId) throw new Error(`Xero has no unique exact contact match for ${document.proposedDocumentNumber}.`);
      if (i === 1) {
        const selectedCode = document.lineItems[0]!.itemCode;
        const jd = evidence.itemChecks.find((check) => check.itemCode === selectedCode);
        if (!jd?.found || !jd.nativeDescription) throw new Error(`Xero ${selectedCode} purchase item or its native description is missing.`);
        document.lineItems[0]!.description = jd.nativeDescription;
      }
      document.partySourceId = evidence.contactCheck.contactId;
    }
    // An exact approved preflight binds Xero contact IDs, JD item wording and
    // the collision state immediately before transport. A partial retry whose
    // previously written document now exists needs renewed human approval.
    const currentPreflightHash = storagePreflightHash(preflight, documents);
    if (event.approvedPreflightHash !== currentPreflightHash) {
      throw new Error("Current Xero preflight differs from the exact approved storage Draft evidence.");
    }
    if (!(await claimInitialStorageEvent(event.id))) throw new Error("Storage event was claimed by another request.");
    let lastExecutionId: number | null = null;
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index]!;
      if (receipts.some((receipt) => receipt.number === document.proposedDocumentNumber)) continue;
      const payload = prepareFinancialDraftPayload(document, `${event.dealId}:${event.location}:${event.periodStart}`);
      const entry = document.documentFamily === "purchase_order"
        ? (payload.body.PurchaseOrders as Record<string, unknown>[])[0]
        : (payload.body.Invoices as Record<string, unknown>[])[0];
      if (!entry) throw new Error("Storage Draft payload is missing its Xero document.");
      entry.CurrencyCode = "AUD";
      const outcome = await executeGuardedFinancialWriterCommand({
        workflowType: "storage_activation", proposedAction: "create_draft", payload, preparedBy: event.approvedBy!,
        authorisation: { workflowType: "storage_activation", approvalReference: event.pilotApprovalKey!, storagePilotEventId: event.id, storagePilotApprovedBy: event.approvedBy!,
          globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true,
          currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true },
      });
      if (outcome.outcome !== "succeeded") throw new Error(`Xero Draft ${document.proposedDocumentNumber} needs reconciliation before retry.`);
      lastExecutionId = outcome.executionId;
      const receipt: StorageDraftReceipt = { documentType: index === 0 ? "customer_invoice" : index === 1 ? "jd_transport" : "gd_storage",
        number: outcome.result.documentNumber, xeroId: outcome.result.xeroDocumentId, status: "DRAFT", readBackAt: new Date().toISOString() };
      receipts.push(receipt);
      // Keep the atomic claim until the entire bundle finishes or fails;
      // exposing "partial" while still writing would let another request claim it.
      await updateInitialStorageEvent({ id: event.id, status: "reserved", receipts });
    }
    if (receipts.length !== 3) throw new Error("Three distinct Xero Draft read-back receipts are required.");
    await updateInitialStorageEvent({ id: event.id, status: "drafts_created", receipts });
    const response: InitialStorageResult = { ok: true, status: "drafts_created", ...resultBase,
      customerInvoice: receipts[0]?.number, transportPurchaseOrder: receipts[1]?.number, storagePurchaseOrder: receipts[2]?.number };
    // CRM traceability is a separate, retryable action. A note failure never
    // changes Xero success and never causes a document to be created again.
    if (lastExecutionId) {
      try {
        const note = await createFinancialPostSuccessAction({ executionId: lastExecutionId, workflowType: "storage_activation", actionType: "vtiger_note",
        sourceRecordId: recordId, payloadHash: sha256({ eventId: event.id, receipts }),
        safePayloadSummary: { storageLocation: deal.location, billingPeriod: `${period.start}–${period.end}`,
          customerInvoice: receipts[0]?.number, transportPurchaseOrder: receipts[1]?.number, storagePurchaseOrder: receipts[2]?.number },
        });
        if (isFinancialPostSuccessVtigerWriteEnabled()) {
          await runFinancialPostSuccessAction(note.id);
        } else {
          throw new Error("VTiger note queued; post-success write-back remains disabled.");
        }
      } catch {
        await updateInitialStorageEvent({ id: event.id, status: "writeback_pending", receipts, errorMessage: "VTiger note write-back pending retry." });
        return { ...response, status: "writeback_pending", warning: "VTiger note pending; all three Xero Drafts are verified." };
      }
    } else {
      await updateInitialStorageEvent({ id: event.id, status: "writeback_pending", receipts, errorMessage: "VTiger note needs an execution receipt before retry." });
      return { ...response, status: "writeback_pending", warning: "VTiger note pending; all three Xero Drafts are verified." };
    }
    return response;
  } catch (error) {
    const warning = safeFailure(error);
    await updateInitialStorageEvent({ id: event.id, status: receipts.length ? "partial" : "failed", receipts, errorMessage: warning });
    return { ok: false, status: receipts.length ? "partial" : "failed", ...resultBase, warning };
  }
}
