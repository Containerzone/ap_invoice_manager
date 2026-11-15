import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { forHireDailyTraversalCursor } from "./financialForHireSchedule";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
import { recordForHireDailyTraversal } from "./financialForHireDailyTraversalDb";

beforeEach(() => vi.clearAllMocks());

describe("AP-owned For Hire daily traversal metadata", () => {
  it("resumes the same day but resets a completed traversal on the next Sydney day", () => {
    const audit = { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: 10, complete: true } };
    expect(forHireDailyTraversalCursor(audit, "2026-12-14")).toBe(10);
    expect(forHireDailyTraversalCursor(audit, "2026-12-15")).toBe(0);
  });

  it("continues unfinished traversal across the daily managed retry limit instead of starving root 41", () => {
    const audit = { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: 40, complete: false } };
    expect(forHireDailyTraversalCursor(audit, "2026-12-15")).toBe(40);
    expect(forHireDailyTraversalCursor(audit, "2026-12-16")).toBe(40);
  });

  it.each([undefined, null, {}, { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: "999" } }, { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: -10 } }, { forHireDailyTraversal: { businessDate: "2026-12-14", afterEventId: 1.5 } }])("ignores missing or malformed cursor state", audit => {
    expect(forHireDailyTraversalCursor(audit, "2026-12-14")).toBe(0);
  });

  it("updates only this enabled task's audit JSON and cannot rewind concurrent cursor progress", async () => {
    const where = vi.fn(async (_condition: any) => [{ affectedRows: 1 }]);
    const set = vi.fn((_values: any) => ({ where }));
    const update = vi.fn((_table: any) => ({ set }));
    mocks.getDb.mockResolvedValue({ update });
    await recordForHireDailyTraversal("authenticated-task", "2026-12-14", 20, false);
    const dialect = new MySqlDialect();
    const condition = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(condition.sql).toContain("`taskUid` = ?");
    expect(condition.sql).toContain("`workflowType` = ?");
    expect(condition.sql).toContain("`enabled` = ?");
    expect(condition.sql).toContain(" AS UNSIGNED");
    expect(condition.sql).toContain(" < ?");
    expect(condition.params).toContain("authenticated-task");
    expect(condition.params).toContain("recurring_for_hire");
    const jsonUpdate = dialect.sqlToQuery(set.mock.calls[0][0].auditData);
    expect(jsonUpdate.sql).toContain("JSON_SET");
    expect(jsonUpdate.sql).toContain("COALESCE");
    expect(jsonUpdate.sql).toContain("JSON_EXTRACT");
    expect(JSON.parse(String(jsonUpdate.params[0]))).toEqual({ businessDate: "2026-12-14", afterEventId: 20, complete: false });
    expect(Object.keys(set.mock.calls[0][0]).sort()).toEqual(["auditData", "updatedAt"]);
  });

  it("allows marking an exhausted unchanged cursor complete without changing an invoice or due date", async () => {
    const where = vi.fn(async (_condition: any) => [{ affectedRows: 1 }]);
    const set = vi.fn((_values: any) => ({ where }));
    mocks.getDb.mockResolvedValue({ update: () => ({ set }) });
    await recordForHireDailyTraversal("authenticated-task", "2026-12-15", 40, true);
    const jsonUpdate = new MySqlDialect().sqlToQuery(set.mock.calls[0][0].auditData);
    expect(JSON.parse(String(jsonUpdate.params[0])).complete).toBe(true);
    expect(new MySqlDialect().sqlToQuery(where.mock.calls[0][0]).sql).toContain(" <= ?");
  });

  it("records manual-only traversal and guards both independent counters against rewind", async () => {
    const where = vi.fn(async (_condition: any) => [{ affectedRows: 1 }]);
    const set = vi.fn((_values: any) => ({ where }));
    mocks.getDb.mockResolvedValue({ update: () => ({ set }) });
    await recordForHireDailyTraversal("task", "2026-12-14", 0, false, 10);
    const dialect = new MySqlDialect();
    const update = dialect.sqlToQuery(set.mock.calls[0][0].auditData);
    expect(JSON.parse(String(update.params[0]))).toMatchObject({ afterEventId: 0, afterManualHandoverId: 10, complete: false });
    const condition = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(condition.sql).toContain("$.forHireDailyTraversal.afterManualHandoverId");
    expect((condition.sql.match(/<= \?/g) ?? []).length).toBe(2);
  });

  it("rejects invalid cursor input without accessing the database", async () => {
    await expect(recordForHireDailyTraversal("task", "2026-12-14", -1, false)).rejects.toThrow("Invalid AP-owned");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
