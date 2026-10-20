import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/mysql-proxy";

const m = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
import { bindDepositMainDeductionPayload, holdDepositMainDeduction, recordDepositMainDeductionAttempt, safeDepositMainDeductionReason } from "./financialDepositMainDeductionDb";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { financialDepositMainDeductionAttempts } from "../drizzle/schema";

// Real Drizzle SQL/parameter construction; this callback captures queries and
// returns local rows. There is no DB driver, socket or applied SQL in this test.
let calls: Array<{ sql: string; params: any[] }>;
let affectedRows: number;
let failure: Error | null;
beforeEach(() => {
  calls = []; affectedRows = 1; failure = null;
  m.db.mockResolvedValue(drizzle(async (sql, params) => {
    calls.push({ sql, params });
    if (failure) throw failure;
    return { rows: [{ affectedRows, insertId: calls.length }] };
  }));
});
const attempt = () => ({ dealId: "5x990", dealNumber: "D702990", trigger: "deposit" as const, outcome: "held" as const, phase: "xero_read" as const, reason: "Xero read failed" });
function inserted(call: { sql: string; params: any[] }): Record<string, unknown> {
  const columns = call.sql.match(/\((.*?)\) values/)![1]!.split(",").map(column => column.trim().replaceAll("`", ""));
  const expressions = call.sql.match(/values \((.*?)\)/)![1]!.split(",").map(value => value.trim());
  let offset = 0;
  return Object.fromEntries(columns.map((column, i) => [column, expressions[i] === "?" ? call.params[offset++] : undefined]));
}

describe("append-only Deposit-to-main attempts with real Drizzle queries", () => {
  it("appends distinct facts on repeated identical outcomes, never UPDATE/DELETE/upsert", async () => {
    await recordDepositMainDeductionAttempt(attempt()); await recordDepositMainDeductionAttempt(attempt());
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toMatch(/^insert into `financial_deposit_main_deduction_attempts`/);
      expect(call.sql).not.toMatch(/update|delete|on duplicate/i);
      expect(inserted(call)).toMatchObject({ dealId: "5x990", dealNumber: "D702990", trigger: "deposit", outcome: "held", phase: "xero_read", reason: "Xero read failed", details: "{}" });
    }
    expect(inserted(calls[0]!).attemptKey).not.toBe(inserted(calls[1]!).attemptKey);
  });

  it.each(["disabled", "not_ready", "already_deducted", "held", "reconciliation_required", "deducted"] as const)("stores factual %s outcomes with nullable pre-reservation identity", async outcome => {
    await recordDepositMainDeductionAttempt({ trigger: "replay", outcome, phase: "release" });
    expect(inserted(calls[0]!)).toMatchObject({ dealId: null, dealNumber: null, deductionEventId: null, executionId: null, reason: null, outcome });
  });

  it("retains exact event/execution IDs and only allowlisted scalar safe JSON", async () => {
    await recordDepositMainDeductionAttempt({ ...attempt(), deductionEventId: 91, executionId: 92, details: { httpStatus: 429, retryAfterSeconds: 60, reservationTransitioned: false, token: "secret", response: { config: { authorization: "Bearer secret" } } } as any });
    const row = inserted(calls[0]!);
    expect(row).toMatchObject({ deductionEventId: 91, executionId: 92 });
    expect(JSON.parse(row.details as string)).toEqual({ httpStatus: 429, retryAfterSeconds: 60, reservationTransitioned: false });
    expect(JSON.stringify(row)).not.toContain("Bearer secret");
  });

  it("bounds and redacts reasons rather than persisting an Axios error/credentials", async () => {
    await recordDepositMainDeductionAttempt({ ...attempt(), reason: "Authorization: Bearer sensitive token=other\nhttps://example.test/?secret=x " + "x".repeat(2100) });
    const row = inserted(calls[0]!);
    expect((row.reason as string).length).toBeLessThanOrEqual(2000);
    expect(row.reason).not.toMatch(/sensitive|other|example.test|\n/);
    expect(safeDepositMainDeductionReason({ config: { token: "sensitive" } })).not.toContain("sensitive");
  });

  it("propagates audit DB failures to the service safety wrapper without an upsert/retry", async () => {
    failure = new Error("audit unavailable");
    await expect(recordDepositMainDeductionAttempt(attempt())).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("fails closed without a database handle without applying any query", async () => {
    m.db.mockResolvedValueOnce(null);
    await expect(recordDepositMainDeductionAttempt(attempt())).rejects.toThrow("unavailable");
    expect(calls).toHaveLength(0);
  });

  it("defines only an append-only key and createdAt, without mutable state timestamps", () => {
    const config = getTableConfig(financialDepositMainDeductionAttempts);
    expect(config.columns.map(column => column.name)).not.toContain("updatedAt");
    expect(config.columns.map(column => column.name)).not.toContain("processingToken");
    expect(config.indexes).toHaveLength(1);
  });
});

describe("exact exclusive reservation hold with real Drizzle predicates", () => {
  it.each([0, 1, 2])("reports success only for exactly one transitioned row (%s)", async count => {
    affectedRows = count;
    expect(await holdDepositMainDeduction(91, "exact-token", "writer failed")).toBe(count === 1);
    expect(calls).toHaveLength(1);
    const query = calls[0]!;
    expect(query.sql).toMatch(/^update `financial_deposit_main_deduction_events`/);
    expect(query.sql).toContain("`financial_deposit_main_deduction_events`.`id` = ?");
    expect(query.sql).toContain("`financial_deposit_main_deduction_events`.`status` = ?");
    expect(query.sql).toContain("`financial_deposit_main_deduction_events`.`processingToken` = ?");
    expect(query.params).toEqual([null, "reconciliation_required", "writer failed", 91, "reserved", "exact-token"]);
  });

  it("propagates a transition DB failure without another mutation", async () => {
    failure = new Error("hold unavailable");
    await expect(holdDepositMainDeduction(91, "exact-token", "uncertain")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("rejects a bind that did not claim its exact still-unbound reserved token", async () => {
    affectedRows = 0;
    await expect(bindDepositMainDeductionPayload(91, "exact-token", "release", { method: "POST", endpoint: "/Invoices/main-id", documentFamily: "customer_invoice", documentNumber: "INV-702990", expectedXeroDocumentId: "main-id", body: { Invoices: [] }, idempotencyKey: "key" })).rejects.toThrow("only be bound once");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("`financial_deposit_main_deduction_events`.`authorisedPayload` is null");
    expect(calls[0]!.params.slice(-3)).toEqual([91, "reserved", "exact-token"]);
  });
});
