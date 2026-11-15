import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { financialForHireManualHandovers, financialForHireManualHandoverAudits } from "../drizzle/schema";
import { buildManualForHireHandoverPlan, type ManualForHireEvidence } from "./financialForHireManualHandoverRules";
import type { ForHireContainerControlFacts } from "./financialForHireDrafts";
const m = vi.hoisted(() => ({ db: vi.fn(), insert: vi.fn(), values: vi.fn(), upsert: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn(), select: vi.fn(), selectWhere: vi.fn(), limit: vi.fn(), orderBy: vi.fn(), rows: [] as any[] }));
vi.mock("./db", () => ({ getDb: m.db }));
import { approveManualForHireHandover, claimManualForHireHandover, completeManualForHireHandover, dueManualForHireHandovers, holdManualForHireHandover, isManualForHireHandoverEnabled } from "./financialForHireManualHandoverDb";

function fixture() {
  const facts: ForHireContainerControlFacts = { recordId: "24x1929", controlNumber: "C1929", acquisition: "FOR HIRE", status: "ON HIRE", containerNumber: "TGHU1234567", containerType: "40 Foot Standard", collectionDate: "2026-11-13", supplierVtigerId: "18x44", supplierName: "Hire Supplier", monthlyCostInclusive: null, purchasePriceInclusive: null, liftAndBookingFeesInclusive: null, sourceRefreshedAt: null };
  const evidence: ManualForHireEvidence = { complete: false, supplierContactId: "contact-44", tenantId: "tenant-1", coverageAttestation: { confirmedLatestCoverage: true, confirmedNoOtherFutureCoverage: true, reviewedBy: 7 }, relatedPurchaseOrders: [], manualPo: { PurchaseOrderID: "manual-po-id", PurchaseOrderNumber: "HC1929", Status: "AUTHORISED", CurrencyCode: "AUD", Contact: { ContactID: "contact-44" }, LineItems: [{ ItemCode: "HC 40", Quantity: 1, UnitAmount: 240, AccountCode: "312", TaxType: "INPUT", Description: "40' Container Hire from 13/11/26 to 13/12/26" }] } };
  const plan = buildManualForHireHandoverPlan({ facts, evidence, manualPoNumber: "HC1929", coveredThrough: "2026-12-13", effectiveFrom: "2026-12-14", now: "2026-11-15" });
  const input = { plan, evidence, approvedBy: 7, manualCreationStopped: true as const, acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER" as const };
  const row = { id: 9, containerControlId: facts.recordId, manualPoNumber: plan.manualPoNumber, coveredThrough: plan.coveredThrough, nextBillingDate: plan.nextPeriodStart, status: "approved", planHash: plan.planHash };
  return { input, row };
}
const query = () => new MySqlDialect().sqlToQuery(m.where.mock.calls.at(-1)![0]);
function clause(column: string, operation = "= ?") { expect(query().sql).toContain(`\`${column}\` ${operation}`); }
function onlyApTables() {
  for (const call of [...m.insert.mock.calls, ...m.update.mock.calls]) expect([financialForHireManualHandovers, financialForHireManualHandoverAudits]).toContain(call[0]);
  expect([...m.insert.mock.calls, ...m.update.mock.calls].map(call => getTableName(call[0])).join(" ")).not.toMatch(/invoice_data|xero|vtiger/i);
  expect(m.upsert).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", "true"); m.rows = [fixture().row];
  m.where.mockResolvedValue([{ affectedRows: 1 }]); m.set.mockImplementation(() => ({ where: m.where })); m.update.mockImplementation(() => ({ set: m.set }));
  m.values.mockResolvedValue(undefined); m.insert.mockImplementation(() => ({ values: m.values, onDuplicateKeyUpdate: m.upsert }));
  m.limit.mockImplementation(async () => m.rows); m.orderBy.mockImplementation(() => ({ limit: m.limit })); m.selectWhere.mockImplementation(() => ({ limit: m.limit, orderBy: m.orderBy }));
  m.select.mockImplementation(() => ({ from: () => ({ where: m.selectWhere, orderBy: m.orderBy }) }));
  m.db.mockResolvedValue({ insert: m.insert, update: m.update, select: m.select });
});
afterEach(() => vi.unstubAllEnvs());

describe("manual handover AP-only immutable ledger", () => {
  it("environment defaults strictly off; approval/claim reject before getDb for every nonliteral true value", async () => {
    for (const value of [undefined, "false", "TRUE", "1", " true", "true ", ""]) {
      vi.stubEnv("FINANCIAL_FOR_HIRE_MANUAL_HANDOVER_ENABLED", value); expect(isManualForHireHandoverEnabled()).toBe(false);
      await expect(approveManualForHireHandover(fixture().input)).rejects.toThrow(/disabled/i);
      await expect(claimManualForHireHandover({ id: 9, planHash: fixture().row.planHash, token: "token", eventId: 41 })).rejects.toThrow(/disabled/i);
    }
    expect(m.db).not.toHaveBeenCalled(); expect(m.insert).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
  it("requires a positive integer admin, true stopped flag and literal acknowledgement before any DB read/write", async () => {
    for (const invalid of [{ approvedBy: 0 }, { approvedBy: -1 }, { approvedBy: 1.5 }, { approvedBy: "7" }, { manualCreationStopped: false }, { acknowledgement: "APPROVE" }]) await expect(approveManualForHireHandover({ ...fixture().input, ...invalid } as any)).rejects.toThrow(/approval|required/i);
    expect(m.db).not.toHaveBeenCalled(); expect(m.insert).not.toHaveBeenCalled();
  });
  it("unique control and PO identities use a single INSERT, retain complete:false evidence and append approval audit, never overwrite/upsert", async () => {
    const { input, row } = fixture(); expect(await approveManualForHireHandover(input)).toEqual(row);
    const indexes = getTableConfig(financialForHireManualHandovers).indexes;
    expect(indexes.filter(index => index.config.unique).map(index => index.config.columns.map(column => (column as any).name))).toEqual(expect.arrayContaining([["containerControlId"], ["manualPoId"]]));
    expect(m.insert.mock.calls.map(call => call[0])).toEqual([financialForHireManualHandovers, financialForHireManualHandoverAudits]);
    expect(m.values.mock.calls[0][0]).toMatchObject({ containerControlId: "24x1929", manualPoId: "manual-po-id", status: "approved", nextBillingDate: input.plan.nextPeriodStart, plan: input.plan, planHash: input.plan.planHash, evidence: input.evidence, approvedBy: 7, manualCreationStopped: true });
    expect(m.values.mock.calls[0][0].evidence.complete).toBe(false);
    expect(m.values.mock.calls[1][0]).toMatchObject({ action: "approved_future_only", actorId: 7, planHash: input.plan.planHash, details: { xeroWritesAttempted: 0 } });
    expect(m.update).not.toHaveBeenCalled(); onlyApTables();
    const duplicate = Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }); m.values.mockRejectedValueOnce(duplicate);
    await expect(approveManualForHireHandover(input)).rejects.toBe(duplicate); expect(m.update).not.toHaveBeenCalled(); onlyApTables();
  });
  it("mismatched readback cannot issue an approved audit or silently replace the row", async () => {
    for (const patch of [{ planHash: "0".repeat(64) }, { status: "completed" }]) {
      vi.clearAllMocks(); m.rows = [{ ...fixture().row, ...patch }];
      await expect(approveManualForHireHandover(fixture().input)).rejects.toThrow(/exact approved/i);
      expect(m.insert).toHaveBeenCalledTimes(1); expect(m.update).not.toHaveBeenCalled(); onlyApTables();
    }
  });
  it("claim CAS requires approved/unclaimed + exact id/planHash + null firstEvent, and never overwrites immutable baseline", async () => {
    const input = { id: 9, planHash: fixture().row.planHash, token: "claim-token", eventId: 41 };
    expect(await claimManualForHireHandover(input)).toBe(true);
    for (const column of ["id", "planHash", "status"]) clause(column);
    clause("processingToken", "is null"); clause("firstApEventId", "is null");
    expect(query().params).toEqual([9, input.planHash, "approved"]);
    expect(m.set.mock.calls[0][0]).toMatchObject({ status: "reserved", processingToken: "claim-token", firstApEventId: 41 });
    for (const immutable of ["plan", "planHash", "evidence", "manualPoId", "manualPoNumber", "coveredThrough", "approvedBy"]) expect(m.set.mock.calls[0][0]).not.toHaveProperty(immutable);
    m.where.mockResolvedValueOnce([{ affectedRows: 0 }]); expect(await claimManualForHireHandover(input)).toBe(false); onlyApTables();
  });
  it("complete CAS matches reserved/token/event, clears nextDue/token and appends audit only after exactly one match", async () => {
    const input = { id: 9, containerControlId: "24x1929", token: "claim-token", eventId: 41 }; await completeManualForHireHandover(input);
    for (const column of ["id", "status", "processingToken", "firstApEventId"]) clause(column);
    expect(query().params).toEqual([9, "reserved", "claim-token", 41]);
    expect(m.set.mock.calls[0][0]).toMatchObject({ status: "completed", processingToken: null, nextBillingDate: null });
    expect(m.set.mock.calls[0][0]).not.toHaveProperty("firstApEventId"); expect(m.set.mock.calls[0][0]).not.toHaveProperty("evidence");
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ action: "first_ap_draft_verified", details: { eventId: 41 } }));
    vi.clearAllMocks(); m.where.mockResolvedValueOnce([{ affectedRows: 0 }]);
    await expect(completeManualForHireHandover(input)).rejects.toThrow(/exact exclusive claim/i); expect(m.insert).not.toHaveBeenCalled(); onlyApTables();
  });
  it("preclaim hold is audit-only; reserved-token and approved-dehire predicates cannot downgrade a completed baseline", async () => {
    const input = { id: 9, containerControlId: "24x1929", reason: "uncertain" };
    await holdManualForHireHandover(input); expect(m.update).not.toHaveBeenCalled(); expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ action: "preclaim_held" }));
    await holdManualForHireHandover({ ...input, token: "claim-token" }); expect(query().params).toEqual([9, "reserved", "claim-token"]);
    expect(m.set.mock.calls.at(-1)![0]).toMatchObject({ status: "reconciliation_required", nextBillingDate: null });
    await holdManualForHireHandover({ ...input, dehired: true }); expect(query().params).toEqual([9, "approved"]); clause("processingToken", "is null");
    expect(m.set.mock.calls.at(-1)![0]).toMatchObject({ status: "dehired", nextBillingDate: null });
    expect(query().params).not.toContain("completed"); onlyApTables();
  });
  it("due traversal only returns approved baselines due on date, with bounded limit and keyset cursor", async () => {
    await dueManualForHireHandovers("2026-12-14", 99, 8);
    const q = new MySqlDialect().sqlToQuery(m.selectWhere.mock.calls[0][0]);
    expect(q.sql).toContain("`status` = ?"); expect(q.sql).toContain("`nextBillingDate` <= ?"); expect(q.sql).toContain("`id` > ?");
    expect(q.params).toEqual(["approved", "2026-12-14", 8]); expect(m.limit).toHaveBeenCalledWith(10); expect(m.insert).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
});
