import { describe, expect, it } from "vitest";
import { financialSha256 } from "./financialProposalIntegrity";
import { assertForHireOpeningSuccessorChain, assertManualForHireApHistory, bindManualForHireMixedHistory, forHireApAnchor, latestForHireApAnchor } from "./financialForHireMixedAnchor";

export function mixedFixture() {
  // Deliberately synthetic: no owner coverage date or supplier choice is asserted.
  const ap: any = { id: 120001, containerControlId: "79x489745", eventKind: "initial", proposedPoNumber: "HC1920",
    billingPeriodStart: "2026-10-16", billingPeriodEnd: "2026-11-15", status: "drafts_created", processingToken: null,
    xeroPurchaseOrderId: "offline-ap-po", executionId: 100, proposal: { number: "HC1920", historicalBody: "untouched" }, nextBillingDate: "2026-11-16", updatedAt: new Date() };
  const base: any = { containerControlId: "79x489745", containerControlNumber: "C1920", manualPoId: "offline-manual-po", manualPoNumber: "HC1920-1", manualSuffix: 1,
    manualPeriodStart: null, coveredThrough: "2026-12-15", nextPeriodStart: "2026-12-16", nextPeriodEnd: "2027-01-14", nextPoNumber: "HC1920-2",
    supplierVtigerId: "18x44", supplierName: "Offline Same Supplier", supplierContactId: "offline-contact", rulesHash: "rules", planHash: "replaced", numberingConvention: "legacy_suffix_zero_initial" };
  const plan = bindManualForHireMixedHistory(base, forHireApAnchor(ap), { ContactID: "offline-contact", Name: "Offline Same Supplier" });
  const first: any = { ...ap, id: 120002, eventKind: "recurring", proposedPoNumber: plan.nextPoNumber, billingPeriodStart: plan.nextPeriodStart,
    billingPeriodEnd: plan.nextPeriodEnd, status: "reserved", processingToken: "token", authorisedPayload: { manualHandoverId: 9, manualHandoverPlanHash: plan.planHash, priorEventId: ap.id } };
  const opening: any = { id: 9, status: "reserved", containerControlId: ap.containerControlId, firstApEventId: first.id, processingToken: "token", plan, planHash: plan.planHash };
  return { ap, base, plan, first, opening };
}

describe("signed manual/AP mixed history contract", () => {
  it("binds immutable identity/execution/proposal fields before approval, not next-due or update metadata", () => {
    const { ap, plan } = mixedFixture();
    const { planHash, ...unsigned } = plan;
    expect(financialSha256(unsigned)).toBe(planHash);
    expect(plan.priorApAnchor).toEqual({ id: 120001, containerControlId: "79x489745", eventKind: "initial", proposedPoNumber: "HC1920", billingPeriodStart: "2026-10-16", billingPeriodEnd: "2026-11-15", xeroPurchaseOrderId: "offline-ap-po", executionId: 100, proposalHash: financialSha256(ap.proposal) });
    expect(forHireApAnchor({ ...ap, nextBillingDate: null, updatedAt: new Date(0) })).toEqual(plan.priorApAnchor);
    expect(plan.supplierHistory).toMatchObject({ manualContactId: "offline-contact", currentContactId: "offline-contact", currentSupplierName: "Offline Same Supplier" });
  });
  it("allows an exact completed AP initial before a later manual suffix, and no fake manual AP receipt", () => {
    const { ap, plan } = mixedFixture();
    expect(latestForHireApAnchor([ap])).toEqual(plan.priorApAnchor);
    expect(() => assertManualForHireApHistory([ap], plan)).not.toThrow();
    expect(ap.status).toBe("drafts_created"); expect(plan.manualPoId).not.toBe(ap.xeroPurchaseOrderId);
  });
  it.each(["id", "containerControlId", "eventKind", "proposedPoNumber", "billingPeriodStart", "billingPeriodEnd", "xeroPurchaseOrderId", "executionId", "proposal"])("rejects changed immutable AP field %s", field => {
    const { ap, plan } = mixedFixture();
    const change: any = { id: ap.id + 1, containerControlId: "79x999", eventKind: "recurring", proposedPoNumber: "HC1920-9", billingPeriodStart: "2026-10-17", billingPeriodEnd: "2026-11-14", xeroPurchaseOrderId: "other", executionId: 101, proposal: { changed: true } };
    expect(() => assertManualForHireApHistory([{ ...ap, [field]: change[field] }], plan)).toThrow(/anchor|history/i);
  });
  it("blocks any reserved/uncertain/newer completed AP and a missing anchor", () => {
    const { ap, plan } = mixedFixture();
    for (const status of ["reserved", "reconciliation_required", "drafts_created"]) {
      const later = { ...ap, id: ap.id + 10, status, billingPeriodStart: "2026-11-16", billingPeriodEnd: "2026-12-15", proposedPoNumber: "HC1920-2" };
      expect(() => assertManualForHireApHistory([ap, later], plan)).toThrow();
    }
    expect(() => assertManualForHireApHistory([], plan)).toThrow();
    expect(() => latestForHireApAnchor([{ ...ap, processingToken: "claimed" }])).toThrow();
  });
  it("allows only the exact first opening reservation and token", () => {
    const { ap, plan, first } = mixedFixture();
    expect(() => assertManualForHireApHistory([ap, first], plan, { eventId: first.id, token: "token" })).not.toThrow();
    for (const patch of [{ processingToken: "wrong" }, { proposedPoNumber: "HC1920-3" }, { billingPeriodEnd: "2027-01-15" }, { status: "drafts_created" }])
      expect(() => assertManualForHireApHistory([ap, { ...first, ...patch }], plan, { eventId: first.id, token: "token" })).toThrow();
    expect(() => assertManualForHireApHistory([ap], plan, { eventId: first.id, token: "token" })).toThrow();
  });
  it("rejects ordinal regression, AP future/overlap, and historical/current contact override", () => {
    const { ap, base } = mixedFixture();
    for (const patch of [{ manualSuffix: 0 }, { coveredThrough: "2026-11-14" }, { manualPeriodStart: "2026-11-15" }, { manualPoId: ap.xeroPurchaseOrderId }])
      expect(() => bindManualForHireMixedHistory({ ...base, ...patch }, forHireApAnchor(ap), { ContactID: "offline-contact" })).toThrow();
    expect(() => bindManualForHireMixedHistory(base, forHireApAnchor(ap), { ContactID: "old-other-supplier" })).toThrow();
  });
});

describe("completed opening only follows its actual AP successor chain", () => {
  it("accepts first and consecutive AP successors, never the historical anchor", () => {
    const { ap, first, opening } = mixedFixture();
    Object.assign(first, { status: "drafts_created", processingToken: null }); opening.status = "completed";
    const second = { ...first, id: first.id + 1, proposedPoNumber: "HC1920-3", billingPeriodStart: "2027-01-15", billingPeriodEnd: "2027-02-13", authorisedPayload: { priorEventId: first.id } };
    expect(() => assertForHireOpeningSuccessorChain([ap, first, second], opening, first.id)).not.toThrow();
    expect(() => assertForHireOpeningSuccessorChain([ap, first, second], opening, second.id)).not.toThrow();
    expect(() => assertForHireOpeningSuccessorChain([ap, first, second], opening, ap.id)).toThrow(/older AP anchor/);
    for (const patch of [{ authorisedPayload: { priorEventId: ap.id } }, { billingPeriodStart: "2027-01-16" }, { status: "reconciliation_required" }])
      expect(() => assertForHireOpeningSuccessorChain([ap, first, { ...second, ...patch }], opening, second.id)).toThrow();
  });
  it.each(["approved", "reserved", "reconciliation_required", "dehired"])("keeps partial or %s openings locked", status => {
    const { ap, first, opening } = mixedFixture(); opening.status = status;
    expect(() => assertForHireOpeningSuccessorChain([ap, first], opening, ap.id)).toThrow(/manual opening point/);
  });
});
