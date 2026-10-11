import { and, desc, eq, isNull } from "drizzle-orm";
import {
  financialExtraHireInvoiceEvents as events,
  type FinancialExtraHireInvoiceEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  financialSha256,
  sourceSnapshotHash,
} from "./financialProposalIntegrity";
import {
  assertExtraHireRelease,
  getExtraHireReleasePolicy,
} from "./financialExtraHireInvoiceRelease";
import {
  buildExtraHireInvoice,
  deriveExtraHireInvoiceNumber,
  EXTRA_HIRE_RULES_HASH,
  EXTRA_HIRE_RULES_VERSION,
  type ExtraHireFacts,
} from "./financialExtraHireInvoiceRules";
import { readExtraHireFacts } from "./financialExtraHireInvoiceSource";
import { readExtraHireXeroEvidence } from "./financialExtraHireInvoiceXero";
import {
  prepareFinancialDraftPayload,
  type FinancialDraftPayload,
} from "./financialProductionWriter";
async function database() {
  const db = await getDb();
  if (!db)
    throw new Error(
      "AP Extra Hire ledger unavailable; generated migration requires separate review/application."
    );
  return db;
}
const affected = (r: any) =>
  Number(r?.[0]?.affectedRows ?? r?.rowsAffected ?? 0) === 1;
export async function getExtraHireEvents(limit = 100) {
  return (await database())
    .select()
    .from(events)
    .orderBy(desc(events.id))
    .limit(Math.min(200, Math.max(1, limit)));
}
export async function getExtraHireDealClaims(
  dealId: string
): Promise<FinancialExtraHireInvoiceEvent[]> {
  return (await database())
    .select()
    .from(events)
    .where(eq(events.dealId, dealId));
}
export async function getExtraHireEvent(eventId: number) {
  return (
    (
      await (await database())
        .select()
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1)
    )[0] ?? null
  );
}
/** Insert only. Duplicate receipt may be read, but its source/proposal/preflight are never overwritten. */
export async function recordExtraHireEvidence(
  input: typeof events.$inferInsert
) {
  const db = await database();
  try {
    await db.insert(events).values(input);
  } catch (e: any) {
    if (e?.code !== "ER_DUP_ENTRY" && e?.cause?.code !== "ER_DUP_ENTRY")
      throw e;
  }
  const row = (
    await db
      .select()
      .from(events)
      .where(eq(events.evidenceKey, input.evidenceKey))
      .limit(1)
  )[0];
  if (
    !row ||
    row.sourceSnapshotHash !== input.sourceSnapshotHash ||
    row.xeroPreflightHash !== input.xeroPreflightHash
  )
    throw new Error("Immutable Extra Hire receipt conflict.");
  return row;
}
export async function claimExtraHireEvidence(
  eventId: number,
  token: string,
  releaseKey: string
) {
  const row = await getExtraHireEvent(eventId);
  if (
    !row ||
    row.status !== "previewed" ||
    !row.ordinal ||
    !row.sourceHireEndDate ||
    !row.proposedInvoiceNumber ||
    !row.xeroPreflightHash ||
    Date.now() - row.preflightAt.getTime() > 5 * 60_000 ||
    row.preflightAt.getTime() > Date.now()
  )
    return false;
  try {
    return affected(
      await (
        await database()
      )
        .update(events)
        .set({
          status: "reserved",
          processingToken: token,
          releaseKey,
          claimedPeriodKey: `${row.dealId}:${row.sourceHireEndDate}`,
          claimedOrdinalKey: `${row.dealId}:${row.ordinal}`,
          claimedInvoiceNumber: row.proposedInvoiceNumber,
        })
        .where(
          and(
            eq(events.id, eventId),
            eq(events.status, "previewed"),
            isNull(events.processingToken),
            isNull(events.claimedPeriodKey)
          )
        )
    );
  } catch (e: any) {
    if (e?.code === "ER_DUP_ENTRY" || e?.cause?.code === "ER_DUP_ENTRY")
      return false;
    throw e;
  }
}
export async function bindExtraHirePayload(
  eventId: number,
  token: string,
  payload: FinancialDraftPayload
) {
  const result = await (
    await database()
  )
    .update(events)
    .set({
      authorisedPayload: {
        hash: financialSha256(payload),
        number: payload.documentNumber,
      },
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.status, "reserved"),
        eq(events.processingToken, token),
        isNull(events.authorisedPayload)
      )
    );
  if (!affected(result))
    throw new Error(
      "Extra Hire payload can only be bound once to its exclusive claim."
    );
}
export async function verifyExtraHireAutomaticWriteAccess(input: {
  eventId: number;
  releaseKey: string;
  preparedBy: number;
  payload: FinancialDraftPayload;
}) {
  const policy = await getExtraHireReleasePolicy();
  assertExtraHireRelease(policy);
  const row = await getExtraHireEvent(input.eventId);
  const auth = row?.authorisedPayload as {
    hash?: string;
    number?: string;
  } | null;
  if (
    !row ||
    row.status !== "reserved" ||
    !row.processingToken ||
    !row.ordinal ||
    !row.sourceHireEndDate ||
    row.claimedPeriodKey !== `${row.dealId}:${row.sourceHireEndDate}` ||
    row.claimedOrdinalKey !== `${row.dealId}:${row.ordinal}` ||
    row.claimedInvoiceNumber !== row.proposedInvoiceNumber ||
    row.releaseKey !== policy.releaseKey ||
    input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy ||
    !auth ||
    auth.hash !== financialSha256(input.payload) ||
    auth.number !== row.proposedInvoiceNumber ||
    row.rulesSnapshotHash !== EXTRA_HIRE_RULES_HASH ||
    !row.xeroPreflightHash ||
    financialSha256(row.xeroPreflight) !== row.xeroPreflightHash ||
    Date.now() - row.preflightAt.getTime() > 5 * 60_000 ||
    row.preflightAt.getTime() > Date.now()
  )
    throw new Error(
      "Extra Hire has no current immutable release-backed exact-payload reservation."
    );
  if (
    input.payload.method !== "POST" ||
    input.payload.endpoint !== "/Invoices" ||
    input.payload.documentFamily !== "customer_invoice" ||
    input.payload.expectedXeroDocumentId
  )
    throw new Error(
      "Extra Hire permits only an isolated new Draft ACCREC POST, never another invoice/PO/create/update."
    );
  if (
    sourceSnapshotHash({
      ...(row.sourceSnapshot as ExtraHireFacts),
      rulesVersion: EXTRA_HIRE_RULES_VERSION,
    }) !== row.sourceSnapshotHash
  )
    throw new Error("Extra Hire immutable source integrity failed.");
  const facts = await readExtraHireFacts(row.dealId);
  if (
    sourceSnapshotHash({ ...facts, rulesVersion: EXTRA_HIRE_RULES_VERSION }) !==
      row.sourceSnapshotHash ||
    financialSha256(facts.mappingEvidence) !== policy.sourceMappingsHash ||
    !facts.sourceRefreshedAt ||
    Date.parse(facts.sourceRefreshedAt) < Date.parse(policy.effectiveFrom!)
  )
    throw new Error(
      "Current Extra Hire source changed, mappings changed, or Deal predates cutover."
    );
  if (!facts.containerFeet || !facts.hireEndDate)
    throw new Error("Extra Hire current source incomplete.");
  const evidence = await readExtraHireXeroEvidence(
    facts.dealNumber,
    facts.customerName,
    facts.containerFeet,
    row.proposedInvoiceNumber!
  );
  if (financialSha256(evidence) !== row.xeroPreflightHash)
    throw new Error(
      "Current Extra Hire Xero evidence changed; reconcile rather than retry."
    );
  const claims = (await getExtraHireDealClaims(row.dealId)).filter(
    c => c.id !== row.id
  );
  const number = deriveExtraHireInvoiceNumber(
    facts.dealNumber,
    facts.hireEndDate,
    evidence.history,
    claims,
    policy.invoiceSuffixCollisionSchemeConfirmed
  );
  if (
    number.holdReason ||
    number.ordinal !== row.ordinal ||
    number.invoiceNumber !== row.proposedInvoiceNumber
  )
    throw new Error(
      number.holdReason ?? "Exact AP Extra Hire ordinal changed."
    );
  const preview = buildExtraHireInvoice(
    facts,
    number.invoiceNumber,
    evidence.item,
    policy.dateSemantics
  );
  if (!preview.document || !preview.eligible)
    throw new Error(preview.holdReason ?? "Extra Hire proposal held.");
  preview.document.partySourceId = evidence.contactId;
  if (financialSha256(preview.document) !== financialSha256(row.proposal))
    throw new Error(
      "Extra Hire proposal does not match independently rebuilt current evidence."
    );
  const expected = prepareFinancialDraftPayload(
    preview.document,
    `${row.dealId}:extra_hire:${row.sourceHireEndDate}:${row.ordinal}:${row.sourceSnapshotHash}`
  );
  (expected.body.Invoices as any[])[0].CurrencyCode = "AUD";
  if (financialSha256(expected) !== auth.hash)
    throw new Error(
      "Extra Hire transport payload differs from exact rebuilt proposal."
    );
}
/** Atomic one-time transport consumption: any subsequent retry/replay holds, even after timeout. Claims NEVER clear. */
export async function consumeExtraHirePayload(
  eventId: number,
  executionId: number
) {
  const result = await (
    await database()
  )
    .update(events)
    .set({ status: "submitted", executionId, submittedAt: new Date() })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.status, "reserved"),
        isNull(events.submittedAt)
      )
    );
  if (!affected(result))
    throw new Error(
      "Extra Hire payload already submitted; no blind retry permitted."
    );
}
export async function completeExtraHireDraft(
  eventId: number,
  token: string,
  executionId: number,
  xeroInvoiceId: string
) {
  const result = await (
    await database()
  )
    .update(events)
    .set({
      status: "drafts_created",
      executionId,
      xeroInvoiceId,
      processingToken: null,
      holdReason: null,
    })
    .where(
      and(
        eq(events.id, eventId),
        eq(events.status, "submitted"),
        eq(events.processingToken, token),
        eq(events.executionId, executionId)
      )
    );
  if (!affected(result))
    throw new Error(
      "Extra Hire verified Draft receipt requires reconciliation; immutable claim was lost."
    );
}
export async function holdExtraHireExecution(eventId: number, reason: string) {
  // Preserve all claims and any success receipt. Never make a reserved/submitted payload eligible again.
  const db = await database();
  const row = await getExtraHireEvent(eventId);
  if (!row || !["reserved", "submitted"].includes(row.status)) return;
  await db
    .update(events)
    .set({
      status: "reconciliation_required",
      processingToken: null,
      holdReason: reason.slice(0, 2000),
    })
    .where(and(eq(events.id, eventId), eq(events.status, row.status)));
}
