import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offlineDb } from "./financialForHireMixedTestSupport";
import { buildInitialForHirePo, buildRecurringForHirePo } from "./financialForHireDrafts";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
const m = vi.hoisted(() => ({ db: vi.fn(), retrieve: vi.fn(), preflight: vi.fn(), policy: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./vtigerFinancialReadService", () => ({ retrieveCurrentVtigerFinancialRecord: m.retrieve }));
vi.mock("./financialReadOnlyXeroService", () => ({ preflightFinancialXeroIntents: m.preflight }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: m.policy, assertForHireRelease: () => undefined, assertForHireRecurringControlAllowed: () => undefined }));
import { bindForHirePayload, claimForHirePreview, forHirePreviewVersion, recordForHirePreview, verifyForHireAutomaticWriteAccess } from "./financialForHireDb";
import { readForHireContainerControl, FOR_HIRE_RULES_HASH, FOR_HIRE_RULES_VERSION } from "./financialForHireService";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";

let current: any;
let evidence: any;
const control = { id: "24x901", vtcmcontainercontrolsnumber: "C1860", cf_vtcmcontainercontrols_acquisition: "FOR HIRE", cf_vtcmcontainercontrols_status: "ON HIRE",
  fld_vtcmcontainercontrolsname: "OFFLINE20", cf_vtcmcontainercontrols_containertype: "20 FOOT", cf_vtcmcontainercontrols_collectiondate: "2026-10-01",
  cf_vtcmcontainercontrols_suppliername: "18x44", cf_vtcmcontainercontrols_costpermonth: "132", modifiedtime: "2026-11-01T00:00:00.000Z" };
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T02:00:00Z"));
  current = { ...control }; m.policy.mockResolvedValue({ releaseKey: "offline-release", approvedBy: 7 });
  m.retrieve.mockImplementation(async id => id === control.id ? { ...current } : { id, vendorname: "Offline supplier" });
  m.preflight.mockImplementation(async () => [structuredClone(evidence)]);
});
afterEach(() => { vi.useRealTimers(); });
async function reservation(kind: "initial" | "recurring") {
  const facts = await readForHireContainerControl(control.id);
  const prior: any = { id: 13, containerControlId: control.id, eventKind: "initial", proposedPoNumber: "HC1860", status: "drafts_created", processingToken: null,
    billingPeriodStart: "2026-10-01", billingPeriodEnd: "2026-10-31", executionId: 10, xeroPurchaseOrderId: "offline-prior", nextBillingDate: "2026-11-01" };
  const h = offlineDb(kind === "initial" ? [] : [prior]); m.db.mockResolvedValue(h.db);
  const built = kind === "initial" ? buildInitialForHirePo(facts) : buildRecurringForHirePo({ facts, priorPeriodEnd: prior.billingPeriodEnd, lastVerifiedExtensionSuffix: null, purchaseRate: 8, now: "2026-11-01" });
  built.document!.partySourceId = "offline-contact";
  evidence = { documentNumber: built.proposedPoNumber, documentFamily: "purchase_order", duplicateState: "not_found", xeroDocumentId: null, status: null, partyName: null,
    contactCheck: { partyName: "Offline supplier", found: true, count: 1, contactId: "offline-contact" },
    itemChecks: [{ itemCode: kind === "initial" ? "HC 20" : "HC 20 E", found: true, purchaseUnitPrice: 8, salesUnitPrice: 999, nativeDescription: "Offline native description" }], error: null };
  const row = await recordForHirePreview({ containerControlId: control.id, containerControlNumber: facts.controlNumber, eventKind: kind,
    billingPeriodStart: built.periodStart!, billingPeriodEnd: built.periodEnd!, proposedPoNumber: built.proposedPoNumber!, containerNumber: facts.containerNumber,
    containerType: facts.containerType, supplierVtigerId: facts.supplierVtigerId, supplierName: facts.supplierName, sourceRefreshedAt: new Date(facts.sourceRefreshedAt!),
    sourceSnapshotHash: sourceSnapshotHash({ ...facts, rulesVersion: FOR_HIRE_RULES_VERSION }), rulesSnapshotHash: FOR_HIRE_RULES_HASH,
    xeroPreflightHash: financialSha256(evidence), proposal: built.document, xeroPreflight: structuredClone(evidence), status: "previewed", holdReason: null });
  const expected = forHirePreviewVersion(row); const priorEventId = kind === "recurring" ? 13 : undefined;
  expect(await claimForHirePreview(row.id, "offline-token", { expectedPreview: expected, priorEventId })).toBe(true);
  const payload = prepareFinancialDraftPayload(built.document!, `${control.id}:${kind}:${built.periodStart}`); (payload.body.PurchaseOrders as any[])[0].CurrencyCode = "AUD";
  await bindForHirePayload(row.id, "offline-release", payload, { token: "offline-token", expectedPreview: expected, preparedDocument: built.document! }, undefined, priorEventId);
  const request = { eventId: row.id, releaseKey: "offline-release", payload, workflowType: kind === "initial" ? "initial_for_hire" as const : "recurring_for_hire" as const, preparedBy: 7 };
  return { ...h, request };
}

describe("ordinary For Hire final transport current-evidence guard", () => {
  it.each(["initial", "recurring"] as const)("accepts unchanged %s source and canonical body with GET-only evidence, no persisted preview refresh", async kind => {
    const f = await reservation(kind); const before = structuredClone(f.state); const logStart = f.log.length;
    await expect(verifyForHireAutomaticWriteAccess(f.request)).resolves.toBeUndefined();
    expect(f.state).toEqual(before); expect(m.retrieve).toHaveBeenCalledTimes(4);
    expect(m.preflight).toHaveBeenCalledTimes(kind === "initial" ? 1 : 2);
    expect(f.log.slice(logStart).filter(row => ["insert", "update"].includes(row.operation))).toEqual([]);
  });
  it.each(["initial", "recurring"] as const)("holds changed current %s source before transport and preserves the claimed body/history", async kind => {
    const f = await reservation(kind); current.cf_vtcmcontainercontrols_costpermonth = "220";
    const before = structuredClone(f.state); const payloadBefore = structuredClone(f.request.payload);
    await expect(verifyForHireAutomaticWriteAccess(f.request)).rejects.toThrow(/source or rules changed before transport/);
    expect(m.preflight).not.toHaveBeenCalled(); expect(f.state).toEqual(before); expect(f.request.payload).toEqual(payloadBefore);
  });
  it.each(["initial", "recurring"] as const)("holds changed current %s rate/contact evidence instead of adopting another transport body", async kind => {
    const f = await reservation(kind); evidence.itemChecks[0].purchaseUnitPrice = 9;
    const before = structuredClone(f.state); const payloadBefore = structuredClone(f.request.payload);
    await expect(verifyForHireAutomaticWriteAccess(f.request)).rejects.toThrow(/preflight changed before transport/);
    expect(f.state).toEqual(before); expect(f.request.payload).toEqual(payloadBefore);
  });
  it("rejects a changed exact supplier contact immediately before transport", async () => {
    const f = await reservation("recurring"); evidence.contactCheck.contactId = "different-contact";
    await expect(verifyForHireAutomaticWriteAccess(f.request)).rejects.toThrow(/preflight changed before transport/);
  });
  it("holds the recurring callback if its verified predecessor changes during current-facts reads", async () => {
    const f = await reservation("recurring"); f.state.events.unshift({ ...f.state.events[0], id: 99, billingPeriodEnd: "2026-11-30", proposedPoNumber: "HC1860-2" });
    await expect(verifyForHireAutomaticWriteAccess(f.request)).rejects.toThrow(/predecessor changed/);
    expect(m.preflight).not.toHaveBeenCalled();
  });
});
