import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: vi.fn(), upsertFinancialWorkflowConfig: vi.fn() }));
import type { FinancialForHirePoEvent, FinancialWriterExecution } from "../drizzle/schema";
import { buildInitialForHirePo, buildRecurringForHirePo, type ForHireContainerControlFacts } from "./financialForHireDrafts";
import { financialSha256 } from "./financialProposalIntegrity";
import { buildForHireInitialReceiptSnapshot, buildVerifiedForHireFutureChainProof, FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH, FOR_HIRE_FUTURE_INITIAL_ORIGIN, FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH, isVerifiedForHireFutureChainProof, type ForHireFutureChainEvidence } from "./financialForHireFutureEligibility";
import { assertForHireRecurringControlAllowed, FOR_HIRE_RECURRING_RULES_HASH, FOR_HIRE_RULES_HASH, resolveForHireRelease } from "./financialForHireRelease";

const cutoff = "2026-11-16T10:30:00.000Z";
const recordId = "79x600001";
const releaseKey = "FOR-HIRE-UNIT-FUTURE";
const exclusions = Array.from({ length: 17 }, (_, n) => `79x${489600 + n}`);
const facts: ForHireContainerControlFacts = { recordId, controlNumber: "C2001", acquisition: "FOR HIRE", status: "ON HIRE",
  containerNumber: "ABCD1234567", containerType: "20 FT", collectionDate: "2026-11-16", supplierVtigerId: "18x45", supplierName: "Hire Supplier",
  monthlyCostInclusive: 132, purchasePriceInclusive: null, liftAndBookingFeesInclusive: null, sourceRefreshedAt: cutoff };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function eventAndWriter(kind: "initial" | "recurring", id: number, prior?: FinancialForHirePoEvent) {
  const preview = kind === "initial" ? buildInitialForHirePo(facts) : buildRecurringForHirePo({ facts,
    priorPeriodEnd: prior!.billingPeriodEnd, lastVerifiedExtensionSuffix: prior!.eventKind === "initial" ? null : Number(prior!.proposedPoNumber.split("-")[1]),
    purchaseRate: 4, now: Temporal.PlainDate.from(prior!.billingPeriodEnd).add({ days: 1 }).toString() });
  const document = { ...preview.document!, partySourceId: "contact-45" };
  const idempotencyKey = sha({ workflowIdempotencyKey: `${recordId}:${kind}:${preview.periodStart}`, documentFamily: document.documentFamily,
    documentType: document.documentType, number: preview.proposedPoNumber, action: document.proposedAction, targetId: null,
    total: document.total.toFixed(2), lines: document.lineItems.map(line => ({ itemCode: line.itemCode, description: line.description,
      quantity: line.quantity, unitAmount: line.unitAmount, accountCode: line.accountCode, gstTreatment: line.gstTreatment })) });
  const payload = { endpoint: "/PurchaseOrders", method: "POST", documentFamily: "purchase_order", documentNumber: preview.proposedPoNumber,
    expectedXeroDocumentId: null, idempotencyKey, body: { PurchaseOrders: [{ PurchaseOrderID: undefined,
      PurchaseOrderNumber: preview.proposedPoNumber, Reference: document.reference, Contact: { ContactID: "contact-45" }, Status: "DRAFT",
      Date: document.issueDate!.toISOString().slice(0, 10), LineAmountTypes: "Exclusive", LineItems: document.lineItems.map(line => ({
        ItemCode: line.itemCode || undefined, Description: line.description, Quantity: line.quantity, UnitAmount: line.unitAmount,
        AccountCode: line.accountCode, TaxType: "INPUT" })), CurrencyCode: "AUD" }] } };
  const createdAt = new Date(kind === "initial" ? cutoff : "2026-12-17T10:30:00.000Z");
  const xeroPreflight = { duplicateState: "not_found", contactId: "contact-45" };
  const event = { id, containerControlId: recordId, containerControlNumber: facts.controlNumber, eventKind: kind,
    billingPeriodStart: preview.periodStart!, billingPeriodEnd: preview.periodEnd!, proposedPoNumber: preview.proposedPoNumber!,
    containerNumber: facts.containerNumber, containerType: facts.containerType, supplierVtigerId: facts.supplierVtigerId, supplierName: facts.supplierName,
    sourceRefreshedAt: createdAt, sourceSnapshotHash: "s".repeat(64).replace(/s/g, "a"), rulesSnapshotHash: FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH,
    xeroPreflightHash: financialSha256(xeroPreflight), proposal: JSON.parse(JSON.stringify(document)), xeroPreflight,
    xeroPurchaseOrderId: `xero-${id}`, releaseKey, processingToken: null, nextBillingDate: "2026-12-17", status: "drafts_created",
    holdReason: null, executionId: id + 100, alertStatus: null, createdAt, updatedAt: createdAt, authorisedPayload: {
      hash: sha(payload), number: preview.proposedPoNumber, bodyHash: financialSha256(payload.body), claimToken: `historical-claim-${id}`,
      expectedPreview: { containerControlId: recordId, eventKind: kind, billingPeriodStart: preview.periodStart, billingPeriodEnd: preview.periodEnd,
        proposedPoNumber: preview.proposedPoNumber, sourceSnapshotHash: "a".repeat(64), rulesSnapshotHash: FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH,
        xeroPreflightHash: financialSha256(xeroPreflight), proposalHash: financialSha256(JSON.parse(JSON.stringify(document))) },
      ...(prior ? { priorEventId: prior.id } : {}),
    } } as FinancialForHirePoEvent;
  const writer = { id: event.executionId!, executionKey: `FWX-${id}`, workflowRunId: null, documentIntentId: null,
    releaseManifestId: null, releaseFamilyId: null, cutoverPackId: null, workflowType: kind === "initial" ? "initial_for_hire" : "recurring_for_hire",
    documentFamily: "purchase_order", proposedAction: "create_draft", proposedDocumentNumber: event.proposedPoNumber,
    targetXeroDocumentId: null, endpoint: "/PurchaseOrders", method: "POST", idempotencyKey,
    payloadFingerprint: `${idempotencyKey.slice(0, 24)}:POST:/PurchaseOrders`, status: "succeeded", approvalReference: releaseKey,
    safePayloadSummary: { documentFamily: "purchase_order", documentNumber: event.proposedPoNumber, method: "POST", endpoint: "/PurchaseOrders",
      targetXeroDocumentId: null, lineCount: document.lineItems.length, lineAmountTypes: "Exclusive", reference: document.reference },
    xeroDocumentId: event.xeroPurchaseOrderId, xeroDocumentStatus: "DRAFT", xeroResponseSummary: { documentNumber: event.proposedPoNumber,
      endpoint: "/PurchaseOrders", idempotencyKey }, errorMessage: null, preparedBy: 9, submittedAt: createdAt, completedAt: createdAt,
    createdAt, updatedAt: createdAt } as FinancialWriterExecution;
  return { event, writer };
}
function fixture(successor = false): ForHireFutureChainEvidence {
  const initial = eventAndWriter("initial", 10), receipt = buildForHireInitialReceiptSnapshot(initial.event);
  const provenance = { containerControlId: recordId, initialEventId: initial.event.id, origin: FOR_HIRE_FUTURE_INITIAL_ORIGIN,
    initialCreatedAt: initial.event.createdAt, initialWriterExecutionId: initial.writer.id, initialXeroPurchaseOrderId: initial.event.xeroPurchaseOrderId!,
    initialReleaseKey: releaseKey, initialRulesHash: FOR_HIRE_FUTURE_INITIAL_EVENT_RULES_HASH, initialSourceSnapshotHash: initial.event.sourceSnapshotHash,
    initialReceiptHash: financialSha256(receipt), initialReceipt: receipt, recordedAt: initial.writer.completedAt! };
  const next = successor ? eventAndWriter("recurring", 11, initial.event) : null;
  return { provenance, events: next ? [next.event, initial.event] : [initial.event], writers: next ? [next.writer, initial.writer] : [initial.writer], priorEventId: next?.event.id ?? initial.event.id };
}
function policy(overrides: Record<string, unknown> = {}) {
  return resolveForHireRelease({ releaseKey, rulesHash: FOR_HIRE_RULES_HASH, initialEnabled: true, recurringEnabled: true,
    approvedBy: 9, approvedAt: "2026-10-01T00:00:00.000Z", effectiveFrom: "2026-10-02T00:00:00.000Z",
    forHireOnlyVtigerBranch: true, initialOperationsHandoff: true, recurringOperationsHandoff: true,
    recurringRulesHash: FOR_HIRE_RECURRING_RULES_HASH, recurringControlIds: [], recurringApprovedAt: cutoff, recurringEffectiveFrom: cutoff,
    recurringFutureInitialsEnabled: true, recurringFutureInitialsFrom: cutoff, recurringFutureExcludedControlIds: exclusions, ...overrides });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-18T10:30:00.000Z")); vi.stubEnv("FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED", "true"); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("authenticated future initial For Hire eligibility", () => {
  it("issues only an immutable opaque proof for a matching successful authenticated root", () => {
    const proof = buildVerifiedForHireFutureChainProof(fixture());
    expect(isVerifiedForHireFutureChainProof(proof)).toBe(true); expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.ancestryEventIds)).toBe(true);
    expect(() => assertForHireRecurringControlAllowed(policy(), recordId, proof)).not.toThrow();
    for (const fake of [true, { chainValidated: true, initialCreatedAt: cutoff }, { ...proof }, JSON.parse(JSON.stringify(proof))]) {
      expect(isVerifiedForHireFutureChainProof(fake)).toBe(false);
      expect(() => assertForHireRecurringControlAllowed(policy(), recordId, fake as any)).toThrow(/outside/);
    }
    expect(() => assertForHireRecurringControlAllowed(policy({ approvedBy: 7 }), recordId, proof)).toThrow(/outside/);
  });
  it("allows exact named legacy controls independently, even if in future exclusions", () => {
    expect(() => assertForHireRecurringControlAllowed(policy({ recurringControlIds: [recordId], recurringFutureExcludedControlIds: [recordId] }), recordId)).not.toThrow();
    const proof = buildVerifiedForHireFutureChainProof(fixture());
    expect(() => assertForHireRecurringControlAllowed(policy({ recurringFutureExcludedControlIds: [recordId] }), recordId, proof)).toThrow(/outside/);
  });
  it("validates the current AP initial -> -2 -> -3 canonical chain", () => {
    const f = fixture(true), previous = f.events[0]!, next = eventAndWriter("recurring", 12, previous);
    f.events = [...f.events, next.event]; f.writers = [...f.writers, next.writer]; f.priorEventId = next.event.id;
    const proof = buildVerifiedForHireFutureChainProof(f);
    expect(proof.ancestryEventIds).toEqual([12, 11, 10]);
    expect(() => assertForHireRecurringControlAllowed(policy(), recordId, proof)).not.toThrow();
  });
  it("validates an unbound next-period preview and its reserved exact link without minting caller booleans", () => {
    const f = fixture(), next = eventAndWriter("recurring", 11, f.events[0]!);
    f.currentEvent = { ...next.event, status: "previewed", releaseKey: null, authorisedPayload: null, executionId: null, xeroPurchaseOrderId: null };
    expect(() => buildVerifiedForHireFutureChainProof(f)).not.toThrow();
    f.currentEvent = { ...next.event, status: "reserved", processingToken: "own-live-token", executionId: null, xeroPurchaseOrderId: null };
    expect(() => buildVerifiedForHireFutureChainProof(f)).not.toThrow();
    f.currentEvent = { ...f.currentEvent, billingPeriodStart: "2026-12-18" };
    expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
  });
  it("hashes immutable receipt fields but excludes changed due markers, updatedAt and historical claim token", () => {
    const f = fixture(), before = financialSha256(buildForHireInitialReceiptSnapshot(f.events[0]!));
    const proofBefore = financialSha256(buildVerifiedForHireFutureChainProof(f));
    f.events = [{ ...f.events[0]!, nextBillingDate: null, updatedAt: new Date("2026-12-18T00:00:00Z"), authorisedPayload: { ...(f.events[0]!.authorisedPayload as object), claimToken: "different-token" } }];
    expect(financialSha256(buildForHireInitialReceiptSnapshot(f.events[0]!))).toBe(before);
    expect(() => buildVerifiedForHireFutureChainProof(f)).not.toThrow();
    expect(financialSha256(buildVerifiedForHireFutureChainProof(f))).toBe(proofBefore);
  });
  it("never makes an old root future through a fresh modification, webhook receipt, or newly recorded provenance", () => {
    const f = fixture(); const old = new Date("2026-11-01T10:30:00Z");
    f.events = [{ ...f.events[0]!, createdAt: old, updatedAt: new Date(), sourceRefreshedAt: new Date() }];
    f.writers = [{ ...f.writers[0]!, createdAt: old, submittedAt: old, completedAt: old }];
    f.provenance = { ...f.provenance, initialCreatedAt: old, recordedAt: new Date(), initialReceipt: buildForHireInitialReceiptSnapshot(f.events[0]!) };
    f.provenance = { ...f.provenance, initialReceiptHash: financialSha256(f.provenance.initialReceipt) };
    const proof = buildVerifiedForHireFutureChainProof(f);
    expect(() => assertForHireRecurringControlAllowed(policy(), recordId, proof)).toThrow(/outside/);
  });
  it("rejects old AP initials C1911/C1912/C1920 even after freshly updated timestamps", () => {
    for (const number of ["C1911", "C1912", "C1920"]) {
      const f = fixture(); f.events = [{ ...f.events[0]!, containerControlNumber: number, proposedPoNumber: `H${number}`, updatedAt: new Date() }];
      expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
    }
  });
  it.each(["", "unknown", "manual", "authenticated_initial_for_hire_webhook "])("rejects non-authenticated origin %s", origin => {
    const f = fixture(); f.provenance = { ...f.provenance, origin }; expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
  });
  it.each(["2026-11-31T10:30:00Z", "2026-11-16", "invalid", "2026-11-16T10:30:00Z "])("rejects invalid root creation date %s", initialCreatedAt => {
    const f = fixture(); f.provenance = { ...f.provenance, initialCreatedAt }; expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
  });
  it.each(["79x600001 ", "C2001", "79X600001", "*"])("rejects malformed/whitespace control identity %s", containerControlId => {
    const f = fixture(); f.provenance = { ...f.provenance, containerControlId }; expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
  });
  it.each(["initialReceiptHash", "initialRulesHash", "initialSourceSnapshotHash", "initialReleaseKey", "initialXeroPurchaseOrderId"])("rejects changed provenance %s", field => {
    const f = fixture(); f.provenance = { ...f.provenance, [field]: field.endsWith("Hash") ? "b".repeat(64) : "wrong-value" };
    expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
  });
  it.each([ { status: "submitted" }, { status: "reconciliation_required" }, { workflowType: "asset_purchase" }, { proposedAction: "update_draft" },
    { documentFamily: "customer_invoice" }, { method: "PUT" }, { xeroDocumentId: "wrong-id" }, { xeroDocumentStatus: "AUTHORISED" },
    { approvalReference: "wrong-release" }, { proposedDocumentNumber: "HC2002" }, { preparedBy: null }, { idempotencyKey: "b".repeat(64) },
    { payloadFingerprint: "wrong" }, { safePayloadSummary: { documentNumber: "HC2001" } }, { xeroResponseSummary: { documentNumber: "HC2001" } },
  ])("rejects uncertain or mismatched writer evidence %j", patch => {
    const f = fixture(); f.writers = [{ ...f.writers[0]!, ...patch } as FinancialWriterExecution];
    expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
  });
  it.each([ { status: "reconciliation_required" }, { status: "reserved" }, { processingToken: "uncertain-claim" },
    { billingPeriodStart: "2026-11-31" }, { proposedPoNumber: "HC2001-1" }, { xeroPurchaseOrderId: "wrong" },
    { sourceSnapshotHash: "b".repeat(64) }, { proposal: { replaced: true } }, { xeroPreflight: { replaced: true } } ])("rejects invalid or replaced root receipt %j", patch => {
    const f = fixture(); f.events = [{ ...f.events[0]!, ...patch } as FinancialForHirePoEvent]; expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow();
  });
  it("rejects orphans, gaps, cycles, foreign ancestors, unrelated completed AP history and reconciliation", () => {
    for (const mutate of [
      (f: ForHireFutureChainEvidence) => { f.events = [f.events[0]!]; },
      (f: ForHireFutureChainEvidence) => { f.events = [{ ...f.events[0]!, proposedPoNumber: "HC2001-3" }, f.events[1]!]; },
      (f: ForHireFutureChainEvidence) => { f.events = [{ ...f.events[0]!, billingPeriodStart: "2026-12-18" }, f.events[1]!]; },
      (f: ForHireFutureChainEvidence) => { f.events = [{ ...f.events[0]!, authorisedPayload: { ...(f.events[0]!.authorisedPayload as object), priorEventId: 11 } }, f.events[1]!]; },
      (f: ForHireFutureChainEvidence) => { f.events = [{ ...f.events[0]!, containerControlId: "79x9999" }, f.events[1]!]; },
      (f: ForHireFutureChainEvidence) => { f.events = [...f.events, { ...f.events[1]!, id: 2 }]; },
      (f: ForHireFutureChainEvidence) => { f.events = [...f.events, { ...f.events[1]!, id: 2, status: "reconciliation_required" }]; },
      (f: ForHireFutureChainEvidence) => { f.events = [{ ...f.events[0]!, authorisedPayload: { ...(f.events[0]!.authorisedPayload as object), manualHandoverId: 4 } }, f.events[1]!]; },
    ]) { const f = fixture(true); mutate(f); expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow(); }
  });
  it("rejects missing root/writer, duplicate evidence and over-bound ancestry", () => {
    for (const mutate of [
      (f: ForHireFutureChainEvidence) => { f.writers = []; },
      (f: ForHireFutureChainEvidence) => { f.events = []; },
      (f: ForHireFutureChainEvidence) => { f.events = [...f.events, f.events[0]!]; },
      (f: ForHireFutureChainEvidence) => { f.writers = [...f.writers, f.writers[0]!]; },
      (f: ForHireFutureChainEvidence) => { f.events = Array.from({ length: FOR_HIRE_FUTURE_MAX_CHAIN_LENGTH + 1 }, (_, n) => ({ ...f.events[0]!, id: n + 1 })); },
    ]) { const f = fixture(); mutate(f); expect(() => buildVerifiedForHireFutureChainProof(f)).toThrow(); }
  });
});
