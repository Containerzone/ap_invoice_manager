import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { DEFAULT_FINANCIAL_AUTOMATION_RULES } from "./financialAutomationRules";
import { FOR_HIRE_RECURRING_CRON, isForHireDailySchedule } from "./financialForHireSchedule";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getPolicy: vi.fn(), assertPolicy: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: mocks.getPolicy, assertForHireRelease: mocks.assertPolicy }));
import { bindApprovedForHireSchedule, dueForHireRecurringRoots } from "./financialForHireDb";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPolicy.mockResolvedValue({ releaseKey: "test-for-hire", approvedBy: 1 });
  mocks.assertPolicy.mockImplementation(() => undefined);
});

describe("prepared daily container-specific For Hire schedule", () => {
  it("shares one daily UTC cron without changing recurring storage cadence", () => {
    expect(FOR_HIRE_RECURRING_CRON).toBe("0 5 20 * * *");
    expect(DEFAULT_FINANCIAL_AUTOMATION_RULES.defaults.recurringHireCadence).toBe(FOR_HIRE_RECURRING_CRON);
    expect(DEFAULT_FINANCIAL_AUTOMATION_RULES.defaults.recurringStorageCadence).toBe("0 0 0 1 * *");
  });

  it.each([
    ["2026-12-13T20:05:00Z", "2026-12-14", "07"],
    ["2026-06-13T20:05:00Z", "2026-06-14", "06"],
    ["2026-10-03T20:05:00Z", "2026-10-04", "07"],
    ["2027-04-03T20:05:00Z", "2027-04-04", "06"],
  ])("maps %s to the correct Sydney business date %s across DST", (timestamp, date, hour) => {
    const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
    const value = (type: string) => parts.find(part => part.type === type)?.value;
    expect(`${value("year")}-${value("month")}-${value("day")}`).toBe(date);
    expect(value("hour")).toBe(hour);
  });

  it("requires the exact enabled daily task; a legacy monthly task cannot appear active", () => {
    expect(isForHireDailySchedule({ taskUid: "task-1", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON })).toBe(true);
    expect(isForHireDailySchedule({ taskUid: "task-1", enabled: true, cronExpression: "0 0 0 1 * *" })).toBe(false);
    expect(isForHireDailySchedule({ taskUid: "task-1", enabled: false, cronExpression: FOR_HIRE_RECURRING_CRON })).toBe(false);
    expect(isForHireDailySchedule({ taskUid: " ", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON })).toBe(false);
    expect(isForHireDailySchedule(null)).toBe(false);
  });

  it("selects completed AP predecessors due on/before a mid-month Sydney date, with a bounded batch", async () => {
    const limit = vi.fn(async () => []);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    mocks.getDb.mockResolvedValue({ select: () => ({ from }) });
    await dueForHireRecurringRoots("2026-12-14", 500);
    const query = new MySqlDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.sql).toContain("`status` = ?");
    expect(query.sql).toContain("`nextBillingDate` <= ?");
    expect(query.params).toEqual(["drafts_created", "2026-12-14"]);
    expect(limit).toHaveBeenCalledWith(10);
  });

  it("binds only an approved schedule UID to daily cadence, without calling a scheduler", async () => {
    const onDuplicateKeyUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
    mocks.getDb.mockResolvedValue({ insert: () => ({ values }) });
    await bindApprovedForHireSchedule("returned-task-uid", 1);
    expect(mocks.assertPolicy).toHaveBeenCalledWith(expect.anything(), "recurring");
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ taskUid: "returned-task-uid", enabled: true, cronExpression: FOR_HIRE_RECURRING_CRON, auditData: expect.objectContaining({ cadence: "DAILY_CONTAINER_DUE_DATE", businessTimezone: "Australia/Sydney" }) }));
  });

  it("refuses to bind or enable any schedule while recurring handover is not approved", async () => {
    mocks.assertPolicy.mockImplementation(() => { throw new Error("Recurring handover disabled"); });
    await expect(bindApprovedForHireSchedule("returned-task-uid", 1)).rejects.toThrow("Recurring handover disabled");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
