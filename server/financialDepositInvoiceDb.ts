import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  financialDepositInvoiceEvents,
  type FinancialDepositInvoiceEvent,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  financialSha256,
  sourceSnapshotHash,
} from "./financialProposalIntegrity";
import {
  assertDepositInvoiceRelease,
  getDepositInvoiceReleasePolicy,
} from "./financialDepositInvoiceRelease";
import {
  DEPOSIT_INVOICE_RULES_HASH,
  DEPOSIT_INVOICE_RULES_VERSION,
  DEPOSIT_MAIN_DEDUCTION_HOLD,
  buildDepositInvoice,
  type DepositInvoiceFacts,
} from "./financialDepositInvoiceDrafts";
import {
  DEPOSIT_V2_CUSTOMER_SNAPSHOT_MAPPING_KEY,
  readDepositInvoiceFacts,
} from "./financialDepositInvoiceSource";
import {
  preflightFinancialXeroIntents,
  readDepositInvoiceXeroItemConfiguration,
  type FinancialXeroPreflight,
} from "./financialReadOnlyXeroService";
import {
  prepareFinancialDraftPayload,
  type FinancialDraftPayload,
} from "./financialProductionWriter";
import { readCurrentCustomerContactResolution } from "./financialCustomerContactSourceV2";
import { previewCustomerContactResolution } from "./financialCustomerContactServiceV2";

export const depositInvoicePayloadHash = (payload: FinancialDraftPayload) =>
  financialSha256(payload);
const affected = (result: any) =>
  Number(result?.[0]?.affectedRows ?? result?.rowsAffected ?? 0) === 1;
async function database() {
  const db = await getDb();
  if (!db)
    throw new Error("AP Deposit Invoice immutable ledger is unavailable.");
  return db;
}
export async function getDepositInvoiceEvents(
  limit = 100
): Promise<FinancialDepositInvoiceEvent[]> {
  return (await database())
    .select()
    .from(financialDepositInvoiceEvents)
    .orderBy(desc(financialDepositInvoiceEvents.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}
export async function getDepositInvoiceEvent(
  eventId: number
): Promise<FinancialDepositInvoiceEvent | null> {
  return (
    (
      await (await database())
        .select()
        .from(financialDepositInvoiceEvents)
        .where(eq(financialDepositInvoiceEvents.id, eventId))
        .limit(1)
    )[0] ?? null
  );
}
export async function getDepositInvoiceClaim(
  dealId: string,
  number: string
): Promise<FinancialDepositInvoiceEvent | null> {
  return (
    (
      await (
        await database()
      )
        .select()
        .from(financialDepositInvoiceEvents)
        .where(
          or(
            eq(financialDepositInvoiceEvents.claimedDealId, dealId),
            eq(financialDepositInvoiceEvents.claimedInvoiceNumber, number)
          )
        )
        .limit(1)
    )[0] ?? null
  );
}

/** Append-only evidence: same receipt may be returned but its factual fields never overwritten. */
export async function recordDepositInvoicePreview(input: {
  facts: DepositInvoiceFacts;
  sourceHash: string;
  proposal: unknown;
  preflight: FinancialXeroPreflight | null;
  proposedInvoiceNumber: string | null;
  status: "previewed" | "held";
  holdReason: string | null;
}): Promise<FinancialDepositInvoiceEvent> {
  const db = await database();
  const values = {
    evidenceKey: financialSha256(input),
    dealId: input.facts.dealId,
    dealNumber: input.facts.dealNumber || input.facts.dealId,
    proposedInvoiceNumber:
      input.proposedInvoiceNumber ?? `UNRESOLVED-DEPOSIT-${input.facts.dealId}`,
    customerVtigerId: input.facts.customerVtigerId || null,
    customerName: input.facts.customerName || null,
    sourceRefreshedAt: input.facts.sourceRefreshedAt
      ? new Date(input.facts.sourceRefreshedAt)
      : null,
    sourceSnapshotHash: input.sourceHash,
    rulesSnapshotHash: DEPOSIT_INVOICE_RULES_HASH,
    xeroPreflightHash: input.preflight
      ? financialSha256(input.preflight)
      : null,
    sourceSnapshot: input.facts,
    proposal: input.proposal as any,
    xeroPreflight: input.preflight,
    postconditionHold: DEPOSIT_MAIN_DEDUCTION_HOLD,
    status: input.status,
    holdReason: input.holdReason,
  };
  // The sole duplicate update is a no-op on the same evidence key. No factual columns change.
  await db
    .insert(financialDepositInvoiceEvents)
    .values(values)
    .onDuplicateKeyUpdate({ set: { evidenceKey: values.evidenceKey } });
  const event = (
    await db
      .select()
      .from(financialDepositInvoiceEvents)
      .where(eq(financialDepositInvoiceEvents.evidenceKey, values.evidenceKey))
      .limit(1)
  )[0];
  if (!event)
    throw new Error(
      "Deposit Invoice immutable receipt could not be read back."
    );
  return event;
}

/** Unique claim keys are never cleared, including uncertain/failed transports; no blind retry. */
export async function claimDepositInvoicePreview(
  eventId: number,
  token: string,
  sourceHash: string,
  preflightHash: string
): Promise<boolean> {
  const db = await database();
  const event = await getDepositInvoiceEvent(eventId);
  if (!event) return false;
  try {
    return affected(
      await db
        .update(financialDepositInvoiceEvents)
        .set({
          status: "reserved",
          processingToken: token,
          claimedDealId: event.dealId,
          claimedInvoiceNumber: event.proposedInvoiceNumber,
        })
        .where(
          and(
            eq(financialDepositInvoiceEvents.id, eventId),
            eq(financialDepositInvoiceEvents.status, "previewed"),
            isNull(financialDepositInvoiceEvents.processingToken),
            isNull(financialDepositInvoiceEvents.claimedDealId),
            eq(financialDepositInvoiceEvents.sourceSnapshotHash, sourceHash),
            eq(financialDepositInvoiceEvents.xeroPreflightHash, preflightHash)
          )
        )
    );
  } catch (error) {
    if ((error as any)?.code === "ER_DUP_ENTRY") return false;
    throw error;
  }
}
export async function bindDepositInvoicePayload(
  eventId: number,
  token: string,
  releaseKey: string,
  payload: FinancialDraftPayload
): Promise<void> {
  const db = await database();
  if (
    !affected(
      await db
        .update(financialDepositInvoiceEvents)
        .set({
          releaseKey,
          authorisedPayload: {
            hash: depositInvoicePayloadHash(payload),
            number: payload.documentNumber,
            payload,
          },
        })
        .where(
          and(
            eq(financialDepositInvoiceEvents.id, eventId),
            eq(financialDepositInvoiceEvents.status, "reserved"),
            eq(financialDepositInvoiceEvents.processingToken, token),
            isNull(financialDepositInvoiceEvents.authorisedPayload)
          )
        )
    )
  )
    throw new Error(
      "Deposit payload can only be bound once to its exclusive reservation."
    );
}

export function depositPreflightHold(
  documentNumber: string,
  customerName: string,
  preflight: FinancialXeroPreflight | null
): string | null {
  if (
    !preflight ||
    preflight.documentNumber !== documentNumber ||
    preflight.documentFamily !== "customer_invoice"
  )
    return "Current exact Deposit Invoice GET-only preflight is missing or mismatched.";
  if (
    preflight.error ||
    preflight.duplicateState !== "not_found" ||
    preflight.xeroDocumentId ||
    preflight.status
  )
    return `Exact Xero invoice ${documentNumber} is ${preflight.duplicateState}${preflight.status ? ` (${preflight.status})` : ""}; never adopt, suffix or bypass deleted history.`;
  if (
    !preflight.contactCheck.found ||
    preflight.contactCheck.count !== 1 ||
    !preflight.contactCheck.contactId ||
    preflight.contactCheck.partyName !== customerName
  )
    return "Exact current Deal Xero customer is missing or ambiguous.";
  if (
    !preflight.itemChecks.some(
      item => item.itemCode === "Deposit Required" && item.found
    )
  )
    return "Current Xero Deposit Required item is unavailable.";
  return null;
}

function storedDepositContactId(event: FinancialDepositInvoiceEvent): string | null {
  const proposal = event.proposal as { partySourceId?: unknown } | null;
  const id = typeof proposal?.partySourceId === "string"
    ? proposal.partySourceId.trim()
    : "";
  return id || null;
}

function sameDepositV2Source(input: {
  facts: DepositInvoiceFacts;
  source: Awaited<ReturnType<typeof readCurrentCustomerContactResolution>>;
}): boolean {
  const { facts, source } = input;
  return source.dealId === facts.dealId &&
    source.customerVtigerId === facts.customerVtigerId &&
    source.name === facts.customerName &&
    (source.billingKind === "organisation" ? "organisation" : "contact") === facts.customerKind &&
    source.resolvedAt === facts.customerRefreshedAt &&
    facts.mappingEvidence[DEPOSIT_V2_CUSTOMER_SNAPSHOT_MAPPING_KEY] ===
      source.sourceSnapshotHash;
}

/** Independently revalidates the exact current Deal, Xero collision/contact/item/account and immutable payload before transport. */
export async function verifyDepositInvoiceAutomaticWriteAccess(input: {
  eventId: number;
  releaseKey: string;
  payload: FinancialDraftPayload;
  preparedBy: number;
}): Promise<void> {
  const policy = await getDepositInvoiceReleasePolicy();
  assertDepositInvoiceRelease(policy);
  const event = await getDepositInvoiceEvent(input.eventId);
  const auth = event?.authorisedPayload as {
    hash?: string;
    number?: string;
  } | null;
  if (
    !event ||
    event.status !== "reserved" ||
    !event.processingToken ||
    event.claimedDealId !== event.dealId ||
    event.claimedInvoiceNumber !== event.proposedInvoiceNumber ||
    event.releaseKey !== policy.releaseKey ||
    input.releaseKey !== policy.releaseKey ||
    input.preparedBy !== policy.approvedBy ||
    event.rulesSnapshotHash !== DEPOSIT_INVOICE_RULES_HASH ||
    !auth ||
    auth.hash !== depositInvoicePayloadHash(input.payload) ||
    auth.number !== event.proposedInvoiceNumber ||
    input.payload.documentNumber !== event.proposedInvoiceNumber
  )
    throw new Error(
      "Deposit Invoice has no release-backed immutable exact-payload reservation."
    );
  if (
    input.payload.method !== "POST" ||
    input.payload.endpoint !== "/Invoices" ||
    input.payload.documentFamily !== "customer_invoice" ||
    input.payload.expectedXeroDocumentId
  )
    throw new Error(
      "Deposit release permits only a new exact Draft ACCREC POST; main amendments are excluded."
    );
  if (
    !event.sourceSnapshot ||
    typeof event.sourceSnapshot !== "object" ||
    sourceSnapshotHash({
      ...(event.sourceSnapshot as object),
      rulesVersion: DEPOSIT_INVOICE_RULES_VERSION,
    }) !== event.sourceSnapshotHash ||
    !event.xeroPreflightHash ||
    financialSha256(event.xeroPreflight) !== event.xeroPreflightHash
  )
    throw new Error("Deposit evidence integrity failed.");
  const facts = await readDepositInvoiceFacts(event.dealId);
  if (
    sourceSnapshotHash({
      ...facts,
      rulesVersion: DEPOSIT_INVOICE_RULES_VERSION,
    }) !== event.sourceSnapshotHash ||
    !facts.sourceRefreshedAt ||
    Date.parse(facts.sourceRefreshedAt) < Date.parse(policy.effectiveFrom!)
  )
    throw new Error(
      "Current Deposit Deal changed or predates the new-events-only cutover."
    );
  const stored = event.proposal as any;
  const preview = buildDepositInvoice(facts, new Date(stored?.issueDate));
  if (!preview.eligible || !preview.document)
    throw new Error(preview.holdReason ?? "Current Deposit source is held.");
  const storedContactId = storedDepositContactId(event);
  if (!storedContactId)
    throw new Error(
      "Deposit reservation is missing its exact bound Xero ContactID."
    );
  // Verify uses the same current v2 Deal -> Xero name/email plan used by the
  // automatic path, but deliberately never reaches its creation executor.
  // The resulting ContactID must be the one already bound to the reservation;
  // an email match may legitimately retain a Xero Name different from VTiger.
  if (process.env.FINANCIAL_CUSTOMER_CONTACT_V2_ENABLED === "true") {
    const currentSource = await readCurrentCustomerContactResolution(event.dealId);
    if (!sameDepositV2Source({ facts, source: currentSource }))
      throw new Error(
        "Current Deposit billing identity metadata changed after reservation."
      );
    const currentPlan = await previewCustomerContactResolution(currentSource);
    if (
      currentPlan.status !== "matched" ||
      !currentPlan.contactId ||
      currentPlan.contactId !== storedContactId
    )
      throw new Error(
        "Current Deposit v2 customer match no longer resolves to the reserved exact Xero ContactID."
      );
  }
  // Assign before GET-only preflight. This forces /Contacts/{ContactID}
  // evidence instead of falling back to an unsafe name-only contact search.
  preview.document.partySourceId = storedContactId;
  const [preflight] = await preflightFinancialXeroIntents([preview.document]);
  const reason = depositPreflightHold(
    event.proposedInvoiceNumber,
    facts.customerName,
    preflight ?? null
  );
  if (reason || !preflight)
    throw new Error(reason ?? "Deposit preflight missing.");
  if (financialSha256(preflight) !== event.xeroPreflightHash)
    throw new Error(
      "Deposit Xero evidence changed since reservation; separate reconciliation is required."
    );
  const item = await readDepositInvoiceXeroItemConfiguration();
  if (preflight.contactCheck.contactId !== storedContactId)
    throw new Error(
      "Current Deposit Xero ContactID differs from the reserved exact customer."
    );
  preview.document.accountCode = item.accountCode;
  preview.document.lineItems[0]!.accountCode = item.accountCode;
  if (financialSha256(preview.document) !== financialSha256(event.proposal))
    throw new Error(
      "Deposit proposal no longer matches immutable current evidence."
    );
  const expected = prepareFinancialDraftPayload(
    preview.document,
    `${event.dealId}:deposit_invoice:${event.sourceSnapshotHash}`
  );
  (expected.body.Invoices as Record<string, unknown>[])[0]!.CurrencyCode =
    "AUD";
  if (depositInvoicePayloadHash(expected) !== auth.hash)
    throw new Error(
      "Deposit payload does not match current independently rebuilt evidence."
    );
}
export async function completeDepositInvoiceDraft(input: {
  eventId: number;
  token: string;
  executionId: number;
  xeroInvoiceId: string;
}): Promise<void> {
  const result = await (
    await database()
  )
    .update(financialDepositInvoiceEvents)
    .set({
      status: "drafts_created",
      executionId: input.executionId,
      xeroInvoiceId: input.xeroInvoiceId,
      processingToken: null,
      holdReason: null,
    })
    .where(
      and(
        eq(financialDepositInvoiceEvents.id, input.eventId),
        eq(financialDepositInvoiceEvents.status, "reserved"),
        eq(financialDepositInvoiceEvents.processingToken, input.token)
      )
    );
  if (!affected(result))
    throw new Error(
      "Deposit Draft receipt needs reconciliation; exclusive reservation was lost."
    );
}
export async function holdDepositInvoiceExecution(
  eventId: number,
  reason: string
): Promise<void> {
  await (
    await database()
  )
    .update(financialDepositInvoiceEvents)
    .set({
      status: "reconciliation_required",
      processingToken: null,
      holdReason: reason.slice(0, 2000),
    })
    .where(
      and(
        eq(financialDepositInvoiceEvents.id, eventId),
        eq(financialDepositInvoiceEvents.status, "reserved")
      )
    );
}
