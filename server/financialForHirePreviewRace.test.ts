import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./financialForHireRelease", () => ({ getForHireReleasePolicy: vi.fn(), assertForHireRelease: vi.fn() }));
import { claimForHirePreview, recordForHirePreview } from "./financialForHireDb";

const proposal = {
  containerControlId: "test-control", containerControlNumber: "C1929", eventKind: "recurring" as const,
  billingPeriodStart: "2026-12-14", billingPeriodEnd: "2027-01-12", proposedPoNumber: "HC1929-2",
  containerNumber: "TEST40", containerType: "40 Foot Standard", supplierVtigerId: "test-vendor", supplierName: "Test supplier",
  sourceRefreshedAt: null, sourceSnapshotHash: "new-source", rulesSnapshotHash: "test-rules", xeroPreflightHash: "new-preflight",
  proposal: { unitAmount: 20 }, xeroPreflight: {}, status: "previewed" as const, holdReason: null,
};

beforeEach(() => vi.clearAllMocks());

describe("atomic For Hire preview protection under overlapping callbacks", () => {
  it.each(["reserved", "drafts_created", "reconciliation_required"])("preserves a concurrent %s receipt after the stale pre-read and cannot re-claim it", async status => {
    let row: any = { ...proposal, id: 50, status: "previewed", processingToken: null, proposal: { unitAmount: 10 }, executionId: null, xeroPurchaseOrderId: null };
    const dialect = new MySqlDialect();
    const duplicate = vi.fn(async ({ set }: any) => {
      // Callback A completes its transition after B's pre-read, before B's insert.
      row = { ...row, status, processingToken: status === "reserved" ? "owner-A" : null, executionId: 77, xeroPurchaseOrderId: status === "drafts_created" ? "verified-po" : null, holdReason: status === "reconciliation_required" ? "Uncertain write evidence" : null };
      expect(Object.keys(set)).toEqual(["id"]);
      expect(dialect.sqlToQuery(set.id).sql).toContain("`id`");
    });
    let updateValues: any;
    const updateWhere = vi.fn(async (condition: any) => {
      const query = dialect.sqlToQuery(condition);
      if (updateValues.processingToken === "owner-B") {
        expect(query.params).toContain("previewed");
        return [{ affectedRows: row.status === "previewed" && row.processingToken === null ? 1 : 0 }];
      }
      expect(query.sql).toContain("`status` in (?, ?, ?)");
      expect(query.params.slice(-3)).toEqual(["previewed", "held", "dehired"]);
      expect(query.sql).toContain("`processingToken` is null");
      if (["previewed", "held", "dehired"].includes(row.status) && row.processingToken === null) {
        row = { ...row, ...updateValues };
        return [{ affectedRows: 1 }];
      }
      return [{ affectedRows: 0 }];
    });
    const select = () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...row }] }) }) });
    mocks.getDb.mockResolvedValue({
      select,
      insert: () => ({ values: () => ({ onDuplicateKeyUpdate: duplicate }) }),
      update: () => ({ set: (values: any) => { updateValues = values; return { where: updateWhere }; } }),
    });
    const result = await recordForHirePreview(proposal);
    expect(result).toMatchObject({ status, executionId: 77, proposal: { unitAmount: 10 } });
    expect(result.holdReason).toBe(status === "reconciliation_required" ? "Uncertain write evidence" : null);
    expect(result.xeroPurchaseOrderId).toBe(status === "drafts_created" ? "verified-po" : null);
    expect(await claimForHirePreview(50, "owner-B")).toBe(false);
    expect(row.status).toBe(status);
    expect(duplicate).toHaveBeenCalledOnce();
  });

  it("allows a fresh unclaimed preview refresh while leaving financial receipt fields outside the update", async () => {
    let row: any = { ...proposal, id: 50, proposal: { unitAmount: 10 }, processingToken: null };
    let updateValues: any;
    const duplicate = vi.fn(async ({ set }: any) => expect(Object.keys(set)).toEqual(["id"]));
    mocks.getDb.mockResolvedValue({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
      insert: () => ({ values: () => ({ onDuplicateKeyUpdate: duplicate }) }),
      update: () => ({ set: (values: any) => { updateValues = values; return { where: async () => { row = { ...row, ...values }; return [{ affectedRows: 1 }]; } }; } }),
    });
    expect((await recordForHirePreview(proposal)).proposal).toEqual({ unitAmount: 20 });
    expect(updateValues).not.toHaveProperty("executionId");
    expect(updateValues).not.toHaveProperty("xeroPurchaseOrderId");
    expect(updateValues).not.toHaveProperty("processingToken");
    expect(updateValues).not.toHaveProperty("nextBillingDate");
  });
});
