import { getDb } from "./server/db";
import { sql } from "drizzle-orm";
import { financialExtraHireInvoiceEvents } from "./drizzle/schema";
import { findExactFinancialCandidate } from "./server/vtigerFinancialCandidateService";
import { previewExtraHireInvoice } from "./server/financialExtraHireInvoiceService";

const db = await getDb();
if (!db) throw new Error("Database unavailable");
const count = async () => Number((await db.select({ count: sql<number>`count(*)` }).from(financialExtraHireInvoiceEvents))[0]?.count ?? 0);
const before = await count();
const candidate = await findExactFinancialCandidate({ sourceCategory: "deal", businessNumber: "D702881" });
let preview: unknown = null;
if (candidate.outcome === "found" && candidate.candidates.length === 1) {
  const recordId = candidate.candidates[0]!.recordId;
  const raw = await previewExtraHireInvoice(recordId, "D702881");
  preview = {
    state: raw.state,
    holdReason: raw.holdReason,
    noWrites: raw.noWrites,
    facts: raw.facts,
    customerContactPlan: raw.customerContactPlan,
    proposedOrdinal: raw.ordinal,
    document: raw.preview.document && {
      documentNumber: raw.preview.document.proposedDocumentNumber,
      party: raw.preview.document.partyName,
      reference: raw.preview.document.reference,
      issueDate: raw.preview.document.issueDate,
      dueDate: raw.preview.document.dueDate,
      itemCode: raw.preview.document.lineItems[0]?.itemCode,
      description: raw.preview.document.lineItems[0]?.description,
      quantity: raw.preview.document.lineItems[0]?.quantity,
      unitAmount: raw.preview.document.lineItems[0]?.unitAmount,
      subtotal: raw.preview.document.subtotal,
      taxAmount: raw.preview.document.taxAmount,
      total: raw.preview.document.total,
    },
  };
}
const after = await count();
console.log(JSON.stringify({ candidate: { outcome: candidate.outcome, message: candidate.message, recordId: candidate.candidates[0]?.recordId ?? null }, preview, eventCountBefore: before, eventCountAfter: after, ledgerChanged: before !== after }, null, 2));
if (before !== after) throw new Error("GET-only preview must not create an Extra Hire event.");
