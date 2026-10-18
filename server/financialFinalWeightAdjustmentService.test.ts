import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ facts: vi.fn(), xero: vi.fn(), policy: vi.fn(), record: vi.fn(), previous: vi.fn(), claim: vi.fn(), bind: vi.fn(), complete: vi.fn(), hold: vi.fn(), writer: vi.fn(), billingSync: vi.fn(), currentParty: vi.fn(), currentPlan: vi.fn() }));
vi.mock("./financialFinalWeightAdjustmentSource", () => ({ readFinalWeightFacts: m.facts }));
vi.mock("./financialReadOnlyXeroService", () => ({ readFinalWeightXeroEvidence: m.xero }));
vi.mock("./financialFinalWeightAdjustmentRelease", async original => ({ ...(await original<any>()), getFinalWeightReleasePolicy: m.policy }));
vi.mock("./financialFinalWeightAdjustmentDb", () => ({ recordFinalWeightEvidence: m.record, getFinalWeightClaim: m.previous, claimFinalWeightEvent: m.claim, bindFinalWeightPayload: m.bind, completeFinalWeightEvent: m.complete, holdFinalWeightEvent: m.hold }));
vi.mock("./financialWriterExecutionService", () => ({ executeGuardedFinancialWriterCommand: m.writer }));
vi.mock("./financialBillingPartySyncService", () => ({ processAutomaticBillingPartySync: m.billingSync }));
vi.mock("./financialCustomerContactSourceV2", () => ({ readCurrentCustomerContactResolution: m.currentParty }));
vi.mock("./financialCustomerContactServiceV2", () => ({ previewCustomerContactResolution: m.currentPlan }));
import { previewFinalWeightAdjustment, processAutomaticFinalWeightAdjustment, getFinalWeightReadiness } from "./financialFinalWeightAdjustmentService";
import { facts, policy, xero } from "./_test/finalWeightFixtures";
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "false"); m.billingSync.mockResolvedValue({ status: "unchanged", xeroWritesAttempted: 0 }); m.facts.mockResolvedValue(facts()); m.xero.mockResolvedValue(xero()); m.policy.mockResolvedValue(policy()); m.record.mockResolvedValue({ id: 5 }); m.previous.mockResolvedValue(null); m.claim.mockResolvedValue(true); m.writer.mockResolvedValue({ outcome: "succeeded", executionId: 9, result: { documentNumber: "INV-702877", xeroDocumentId: "invoice-exact", status: "DRAFT" } }); });
afterEach(() => vi.unstubAllEnvs());
const noLedger = () => { for (const method of [m.record, m.previous, m.claim, m.bind, m.complete, m.hold, m.writer, m.billingSync]) expect(method).not.toHaveBeenCalled(); };
describe("Final weight read-only preview and immutable protected lifecycle", () => {
  it("preview rereads exact current Deal/Xero but NEVER persists evidence even if released", async () => {
    const result = await previewFinalWeightAdjustment("5x77", "overweight", "D702877");
    expect(result).toMatchObject({ noWrites: true, state: "previewed", preview: { eligible: true } });
    expect(m.facts).toHaveBeenCalledWith("5x77", "overweight"); expect(m.xero).toHaveBeenCalledWith("INV-702877", "Synthetic Customer", "overweight", { skipCustomerMatch: true }); noLedger();
  });
  it("source ambiguity holds preview before Xero and never saves evidence", async () => {
    m.facts.mockResolvedValue(facts({ sourceHoldReason: "Ambiguous metadata" }));
    expect((await previewFinalWeightAdjustment("5x77", "overweight")).holdReason).toBe("Ambiguous metadata"); expect(m.xero).not.toHaveBeenCalled(); noLedger();
  });
  it("wrong exact named D-number holds before any Xero/persistence", async () => {
    await expect(previewFinalWeightAdjustment("5x77", "overweight", "D88")).rejects.toThrow(/no longer matches/); expect(m.xero).not.toHaveBeenCalled(); noLedger();
  });
  it("Xero GET failure holds read-only preview", async () => { m.xero.mockRejectedValue(new Error("Exact GET unavailable")); expect((await previewFinalWeightAdjustment("5x77", "overweight")).holdReason).toBe("Exact GET unavailable"); noLedger(); });
  it("disabled automatic gate rejects before source/evidence/execution", async () => { vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", ""); await expect(processAutomaticFinalWeightAdjustment("5x77", "overweight")).rejects.toThrow(/release disabled/); expect(m.facts).not.toHaveBeenCalled(); noLedger(); });
  it("readiness is truthful and default off with no execution/source persistence", async () => { vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", ""); const result = await getFinalWeightReadiness(); expect(result.branches.every(branch => !branch.writerEnabled)).toBe(true); noLedger(); });
  it("historical source is held in immutable receipt without reservation or Xero amendment", async () => { m.facts.mockResolvedValue(facts({ sourceRefreshedAt: "2026-01-01T00:00:00Z" })); const result = await processAutomaticFinalWeightAdjustment("5x77", "overweight"); expect(result).toMatchObject({ status: "held", xeroWritesAttempted: 0 }); expect(m.record.mock.calls[0]![0].holdReason).toMatch(/predates/); expect(m.claim).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled(); });
  it.each(["reserved", "submitted", "reconciliation_required", "draft_updated"])("cross-direction existing %s claim remains held with zero amendment", async status => { m.previous.mockResolvedValue({ direction: "underweight", status }); const result = await processAutomaticFinalWeightAdjustment("5x77", "overweight"); expect(result).toMatchObject({ status: "held", xeroWritesAttempted: 0 }); expect(m.claim).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled(); });
  it("reservation collision does not bind or send a second payload", async () => { m.claim.mockResolvedValue(false); expect(await processAutomaticFinalWeightAdjustment("5x77", "overweight")).toMatchObject({ status: "held", xeroWritesAttempted: 0 }); expect(m.bind).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled(); });
  it("released path binds exact amendment and readback evidence without CRM actions", async () => { const result = await processAutomaticFinalWeightAdjustment("5x77", "overweight"); expect(result).toMatchObject({ status: "draft_updated", xeroWritesAttempted: 1 }); const command = m.writer.mock.calls[0]![0]; expect(command).toMatchObject({ workflowType: "final_weight_adjustment", proposedAction: "update_draft", payload: { method: "POST", endpoint: "/Invoices/invoice-exact" }, authorisation: { finalWeightDirection: "overweight", finalWeightAutomaticEventId: 5 } }); expect(command.sourceRecordId).toBeUndefined(); expect(command.postSuccessPlan).toBeUndefined(); expect(command.expectedFinalWeightDraft.LineItems[0]).toEqual(xero().invoice!.LineItems[0]); expect(m.complete).toHaveBeenCalled(); });
  it("underweight exact due-date-only path retains all existing lines", async () => { m.facts.mockResolvedValue(facts({ actualWeight: 9, requiredDueDate: "2026-10-20" })); await processAutomaticFinalWeightAdjustment("5x77", "underweight"); const command = m.writer.mock.calls[0]![0]; expect(command.expectedFinalWeightDraft.LineItems).toEqual(xero().invoice!.LineItems); expect(command.expectedFinalWeightDraft.DueDate).toBe("2026-10-20"); });
  it.each(["duplicate", "reconciliation_required"])("%s execution outcome keeps claim and enters reconciliation, never completes", async outcome => { m.writer.mockResolvedValue({ outcome, executionId: 9 }); expect(await processAutomaticFinalWeightAdjustment("5x77", "overweight")).toMatchObject({ status: "reconciliation_required" }); expect(m.hold).toHaveBeenCalled(); expect(m.complete).not.toHaveBeenCalled(); });
  it("exception after reservation retains reconciliation hold; never advertises zero attempts", async () => { m.writer.mockRejectedValue(new Error("Uncertain exact-resource POST")); await expect(processAutomaticFinalWeightAdjustment("5x77", "overweight")).rejects.toThrow(/Uncertain/); expect(m.hold).toHaveBeenCalledWith(5, expect.any(String), "Uncertain exact-resource POST"); expect(m.complete).not.toHaveBeenCalled(); });
  it("syncs billing first then uses a fresh full Draft baseline for finalisation", async () => {
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.billingSync.mockResolvedValue({ status: "updated", contactId: "new-billing-party", sourceSnapshotHash: "fresh-billing-source", xeroWritesAttempted: 1 });
    m.currentParty.mockResolvedValue({ sourceSnapshotHash: "fresh-billing-source" });
    m.currentPlan.mockResolvedValue({ status: "matched", contactId: "new-billing-party" });
    const fresh = xero();
    fresh.invoice!.Contact = { ContactID: "new-billing-party" };
    fresh.exactMatches[0].Contact = { ContactID: "new-billing-party" };
    fresh.contact.contactId = "new-billing-party";
    m.xero.mockResolvedValueOnce(xero()).mockResolvedValueOnce(fresh);
    expect(await processAutomaticFinalWeightAdjustment("5x77", "overweight")).toMatchObject({ status: "draft_updated", xeroWritesAttempted: 2 });
    expect(m.billingSync).toHaveBeenCalledWith("5x77", "main_invoice_finalisation");
    expect(m.claim.mock.invocationCallOrder[0]).toBeGreaterThan(m.billingSync.mock.invocationCallOrder[0]!);
    expect(m.writer.mock.calls[0][0].expectedFinalWeightDraft.Contact).toEqual({ ContactID: "new-billing-party" });
  });
  it("a different current party after the billing POST holds before a weight/date amendment", async () => {
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.billingSync.mockResolvedValue({ status: "updated", contactId: "new-billing-party", sourceSnapshotHash: "fresh-billing-source", xeroWritesAttempted: 1 });
    m.currentParty.mockResolvedValue({ sourceSnapshotHash: "another-source" });
    m.currentPlan.mockResolvedValue({ status: "matched", contactId: "third-party" });
    const fresh = xero(); fresh.invoice!.Contact = { ContactID: "new-billing-party" };
    fresh.exactMatches[0].Contact = { ContactID: "new-billing-party" };
    fresh.contact.contactId = "new-billing-party";
    m.xero.mockResolvedValueOnce(xero()).mockResolvedValueOnce(fresh);
    expect(await processAutomaticFinalWeightAdjustment("5x77", "overweight")).toMatchObject({ status: "held", xeroWritesAttempted: 1, warning: expect.stringMatching(/changed again/) });
    expect(m.claim).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });
  it("a billing sync hold prevents finalisation reservation and amendment", async () => {
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.billingSync.mockResolvedValue({ status: "reconciliation_required", warning: "Billing POST readback pending", xeroWritesAttempted: 1 });
    expect(await processAutomaticFinalWeightAdjustment("5x77", "overweight")).toMatchObject({ status: "held", warning: "Billing POST readback pending", xeroWritesAttempted: 1 });
    expect(m.claim).not.toHaveBeenCalled(); expect(m.writer).not.toHaveBeenCalled();
  });
  it("does not refresh billing for historical or already claimed finalisation", async () => {
    vi.stubEnv("FINANCIAL_BILLING_PARTY_SYNC_ENABLED", "true");
    m.previous.mockResolvedValue({ direction: "overweight", status: "reconciliation_required" });
    await processAutomaticFinalWeightAdjustment("5x77", "overweight");
    expect(m.billingSync).not.toHaveBeenCalled();
  });
});
