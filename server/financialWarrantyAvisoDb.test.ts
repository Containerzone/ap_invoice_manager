import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: vi.fn(), values: vi.fn(), select: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialWorkflowDb", () => ({ getFinancialWorkflowConfig: vi.fn() }));
import { warrantyFixture } from "./financialWarrantyAvisoFixtures";
import { consumeWarrantyStep, finishWarranty, recordWarrantyPreview, recordWarrantyReceipt, reserveWarranty } from "./financialWarrantyAvisoDb";
import { financialSha256 } from "./financialProposalIntegrity";

let f: ReturnType<typeof warrantyFixture>;
let rows: any[];
let inserted: any;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
  f = warrantyFixture(); rows = []; inserted = null;
  m.values.mockImplementation(async input => {
    if (rows.some(r => r.eventKey === input.eventKey || input.claimKey && r.claimKey === input.claimKey)) throw new Error("ER_DUP_ENTRY immutable unique key");
    inserted = { ...structuredClone(input), id: rows.length + 10, createdAt: new Date() }; rows.push(inserted);
  });
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ orderBy: async () => rows.slice(), limit: async () => inserted ? [inserted] : [] }) }) }));
  m.db.mockResolvedValue({ select: m.select, insert: () => ({ values: m.values }) });
});
afterEach(() => vi.useRealTimers());

describe("Warranty Drizzle-mocked immutable verified-receipt transition", () => {
  it.each([false, undefined, null, "true", "false", 1, {}])("PO consumption rejects main receipt with readbackVerified=%j", async readbackVerified => {
    rows = [{ eventKey: "main-receipt", status: "main_receipt", receipt: { xeroDocumentId: "main-id", readbackVerified } }];
    await expect(consumeWarrantyStep(f.reservation, "po")).rejects.toThrow(/verified main readback/);
    expect(m.values).not.toHaveBeenCalled();
  });
  it("PO rejects absent receipt, submitted-only receipt, or verified receipt under wrong status", async () => {
    for (const prior of [[], [{ status: "main_submitted" }], [{ status: "po_receipt", receipt: { readbackVerified: true } }]]) {
      rows = prior;
      await expect(consumeWarrantyStep(f.reservation, "po")).rejects.toThrow(/verified main readback/);
    }
    expect(m.values).not.toHaveBeenCalled();
  });
  it("only literal true under main_receipt allows the one-shot PO attempt insert", async () => {
    rows = [{ eventKey: "main-receipt", status: "main_receipt", receipt: { readbackVerified: true } }];
    expect(await consumeWarrantyStep(f.reservation, "po")).toMatchObject({ status: "po_submitted", eventKey: "group-id:po:attempt", executionGroup: "group-id" });
    expect(m.values).toHaveBeenCalledTimes(1);
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ status: "po_submitted", eventKey: "group-id:po:attempt" }));
  });
  it.each(["reconciliation_required", "drafts_created"])("terminal %s blocks both steps even with a true main receipt", async status => {
    rows = [{ status: "main_receipt", receipt: { readbackVerified: true } }, { status }];
    for (const step of ["main", "po"] as const) await expect(consumeWarrantyStep(f.reservation, step)).rejects.toThrow(/cannot retry/);
    expect(m.values).not.toHaveBeenCalled();
  });
  it.each(["main", "po"] as const)("the simulated immutable unique %s attempt prevents a second consumption", async step => {
    if (step === "po") rows = [{ status: "main_receipt", receipt: { readbackVerified: true } }];
    await consumeWarrantyStep(f.reservation, step);
    await expect(consumeWarrantyStep(f.reservation, step)).rejects.toThrow(/ER_DUP_ENTRY/);
    expect(rows.filter(r => r.eventKey === `group-id:${step}:attempt`)).toHaveLength(1);
  });
  it("response-only unsuccessful receipt stays false and cannot advance PO", async () => {
    const receipt = { httpStatus: 200, response: { Invoices: [{ InvoiceID: "main-id", Status: "DRAFT" }] }, readbackVerified: false };
    await recordWarrantyReceipt(f.reservation, "main", receipt);
    expect(rows[0]).toMatchObject({ status: "main_receipt", receipt });
    await expect(consumeWarrantyStep(f.reservation, "po")).rejects.toThrow(/verified main readback/);
    expect(m.values).toHaveBeenCalledTimes(1);
  });
  it("partial pair finalization is insert-only, retains evidence/claim and makes future attempts terminal", async () => {
    rows = [structuredClone(f.reservation), { eventKey: "main-receipt", status: "main_receipt", receipt: { readbackVerified: true } }];
    const authority = structuredClone(rows[0]);
    await finishWarranty(f.reservation, "reconciliation_required", "PO uncertain", { receipts: [{ readbackVerified: true }] });
    expect(rows[0]).toEqual(authority);
    expect(rows.at(-1)).toMatchObject({ status: "reconciliation_required", eventKey: "group-id:finish", holdReason: "PO uncertain" });
    await expect(consumeWarrantyStep(f.reservation, "po")).rejects.toThrow(/cannot retry/);
    expect(m.values).toHaveBeenCalledTimes(1);
  });
  it("preview evidence is a new immutable held insert with hashes, never claim or adoption", async () => {
    const facts = { ...f.facts, holdReason: "Actual mapping unproven" };
    await recordWarrantyPreview(facts, null, null, facts.holdReason);
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ status: "held", sourceSnapshot: facts, sourceSnapshotHash: financialSha256(facts), xeroPreflight: null, proposal: null }));
    expect(m.values.mock.calls[0][0]).not.toHaveProperty("claimKey");
  });
  it("reservation binds exact source/preflight/policy/payload hashes to one lifetime Deal claim", async () => {
    const preview = { ...f.reservation, status: "previewed" };
    const reservation = await reserveWarranty(preview, f.policy, f.plan);
    expect(reservation).toMatchObject({ status: "reserved", claimKey: "warranty:D77", sourceSnapshotHash: f.reservation.sourceSnapshotHash, xeroPreflightHash: f.reservation.xeroPreflightHash,
      authorisedPayload: { policyHash: financialSha256(f.policy), mainHash: financialSha256(f.plan.mainPayload), poHash: financialSha256(f.plan.poPayload) } });
    await expect(reserveWarranty(preview, f.policy, f.plan)).rejects.toThrow(/ER_DUP_ENTRY/);
  });
  it("unapplied/unavailable ledger fails closed rather than reporting a receipt", async () => {
    m.db.mockResolvedValue(null);
    await expect(consumeWarrantyStep(f.reservation, "main")).rejects.toThrow(/ledger unavailable/);
    expect(m.values).not.toHaveBeenCalled();
  });
});
