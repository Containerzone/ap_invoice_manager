import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInitialForHirePo, buildRecurringForHirePo } from "./financialForHireDrafts";
import { financialSha256 } from "./financialProposalIntegrity";
import { offlineDb } from "./financialForHireMixedTestSupport";
const m = vi.hoisted(() => ({ db: vi.fn(), initial: vi.fn(), recurring: vi.fn(), policy: vi.fn(), execute: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialForHireService", () => ({ previewInitialForHirePo: m.initial, previewRecurringForHirePo: m.recurring }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: m.policy, assertForHireRelease: () => undefined, assertForHireRecurringControlAllowed: () => undefined }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.execute }));
import { recordForHirePreview, bindForHirePayload, claimForHirePreview, forHirePreviewVersion } from "./financialForHireDb";
import { processAutomaticInitialForHire, processAutomaticRecurringForHire } from "./financialForHireLiveService";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";

const facts: any = { recordId: "24x901", controlNumber: "C1860", acquisition: "FOR HIRE", status: "ON HIRE", containerNumber: "OFFLINE20", containerType: "20 FOOT", collectionDate: "2026-10-01", supplierVtigerId: "18x44", supplierName: "Offline supplier", monthlyCostInclusive: 132 };
const preflight = { offline: true };
function preview(kind: "initial" | "recurring", version: "A" | "B") {
  const built = kind === "initial" ? buildInitialForHirePo({ ...facts, monthlyCostInclusive: version === "A" ? 132 : 143 })
    : buildRecurringForHirePo({ facts, priorPeriodEnd: "2026-10-31", lastVerifiedExtensionSuffix: null, purchaseRate: version === "A" ? 8 : 9, now: "2026-11-01" });
  built.document!.partySourceId = "offline-contact";
  return { kind, facts, preview: built, lifecycle: [], preflight, sourceSnapshotHash: financialSha256(version), rulesSnapshotHash: "r".repeat(64),
    xeroPreflightHash: financialSha256(preflight), state: "previewed", noWrites: true, holdReason: null };
}
async function persist(result: ReturnType<typeof preview>) {
  return recordForHirePreview({ containerControlId: facts.recordId, containerControlNumber: facts.controlNumber, eventKind: result.kind,
    billingPeriodStart: result.preview.periodStart!, billingPeriodEnd: result.preview.periodEnd!, proposedPoNumber: result.preview.proposedPoNumber!,
    containerNumber: facts.containerNumber, containerType: facts.containerType, supplierVtigerId: facts.supplierVtigerId, supplierName: facts.supplierName, sourceRefreshedAt: null,
    sourceSnapshotHash: result.sourceSnapshotHash, rulesSnapshotHash: result.rulesSnapshotHash, xeroPreflightHash: result.xeroPreflightHash,
    proposal: result.preview.document, xeroPreflight: preflight, status: "previewed", holdReason: null });
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "false"); m.policy.mockResolvedValue({ releaseKey: "offline-release", approvedBy: 7, recurringControlIds: ["24x901"] }); });
afterEach(() => vi.unstubAllEnvs());

describe("caller preview / refreshed ledger concurrency boundary", () => {
  it.each(["initial", "recurring"] as const)("does not invoke a writer for stale %s A after B refresh; B claims and writes only B", async kind => {
    const prior: any = { id: 13, containerControlId: facts.recordId, containerControlNumber: facts.controlNumber, eventKind: "initial", status: "drafts_created", processingToken: null,
      billingPeriodStart: "2026-10-01", billingPeriodEnd: "2026-10-31", proposedPoNumber: "HC1860", nextBillingDate: "2026-11-01", executionId: 10, xeroPurchaseOrderId: "offline-prior" };
    const h = offlineDb(kind === "recurring" ? [prior] : []); m.db.mockResolvedValue(h.db);
    const a = preview(kind, "A"); const b = preview(kind, "B");
    const callback = kind === "initial" ? m.initial : m.recurring;
    // Both callbacks have completed their source/preflight work, but A resumes
    // after B replaces the local preview. A must not adopt ledger B or post A.
    callback.mockImplementationOnce(async () => { await persist(a); await persist(b); return a; }).mockImplementationOnce(async () => { await persist(b); return b; });
    m.execute.mockImplementation(async command => ({ outcome: "succeeded", executionId: 41, result: { xeroDocumentId: "offline-next", documentNumber: command.payload.documentNumber } }));
    const run = () => kind === "initial" ? processAutomaticInitialForHire(facts.recordId) : processAutomaticRecurringForHire(facts.recordId, 13, "2026-11-01");
    expect(await run()).toMatchObject({ status: "held", xeroWritesAttempted: 0 });
    expect(m.execute).not.toHaveBeenCalled(); expect(h.state.events.at(-1)).toMatchObject({ status: "previewed", processingToken: null, proposal: b.preview.document });
    expect(await run()).toMatchObject({ status: "drafts_created", xeroWritesAttempted: 1 });
    expect(m.execute).toHaveBeenCalledOnce(); expect(m.execute.mock.calls[0][0].expectedDraftDocument).toEqual(b.preview.document);
    expect(h.state.events.at(-1).authorisedPayload).toMatchObject({ expectedPreview: expect.objectContaining({ proposalHash: financialSha256(b.preview.document) }), claimToken: expect.any(String) });
  });

  it.each(["token", "preparedDocument", "wireBody", "ledgerProposal"])("rejects %s tampering during payload binding without authorizing a different body", async kind => {
    const h = offlineDb(); m.db.mockResolvedValue(h.db); const a = preview("initial", "A"); const row = await persist(a);
    const expected = forHirePreviewVersion(row); expect(await claimForHirePreview(row.id, "claim-A", { expectedPreview: expected })).toBe(true);
    const payload = prepareFinancialDraftPayload(a.preview.document!, `${facts.recordId}:initial:${a.preview.periodStart}`); (payload.body.PurchaseOrders as any[])[0].CurrencyCode = "AUD";
    const claim = { token: "claim-A", expectedPreview: expected, preparedDocument: a.preview.document! };
    if (kind === "token") claim.token = "other";
    if (kind === "preparedDocument") claim.preparedDocument = { ...claim.preparedDocument, reference: "different" };
    if (kind === "wireBody") (payload.body.PurchaseOrders as any[])[0].LineItems[0].UnitAmount = 999;
    if (kind === "ledgerProposal") h.state.events[0].proposal = { ...a.preview.document, reference: "changed" };
    await expect(bindForHirePayload(row.id, "offline-release", payload, claim)).rejects.toThrow(/claimed preview version/);
    expect(h.state.events[0].authorisedPayload).toBeUndefined(); expect(m.execute).not.toHaveBeenCalled();
  });

  it("accepts only the persisted canonical prepared Draft snapshot, including JSON-restored dates", async () => {
    const h = offlineDb(); m.db.mockResolvedValue(h.db); const a = preview("initial", "A"); const row = await persist(a);
    h.state.events[0].proposal = JSON.parse(JSON.stringify(row.proposal));
    const expected = forHirePreviewVersion(row); expect(await claimForHirePreview(row.id, "claim-A", { expectedPreview: expected })).toBe(true);
    const payload = prepareFinancialDraftPayload(a.preview.document!, `${facts.recordId}:initial:${a.preview.periodStart}`); (payload.body.PurchaseOrders as any[])[0].CurrencyCode = "AUD";
    await bindForHirePayload(row.id, "offline-release", payload, { token: "claim-A", expectedPreview: expected, preparedDocument: a.preview.document! });
    expect(h.state.events[0].authorisedPayload).toMatchObject({ expectedPreview: expected, claimToken: "claim-A", bodyHash: financialSha256(payload.body) });
  });
});
