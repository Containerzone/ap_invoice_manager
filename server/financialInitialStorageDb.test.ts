import { beforeEach, describe, expect, it, vi } from "vitest";
const records = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => records.rows }) }) }) })) }));
import { verifyInitialStoragePilotWriteAccess } from "./financialInitialStorageDb";

const valid = () => ({ id: 17, dealNumber: "D123", suffix: "A", status: "reserved", pilotApprovalKey: "approved-event-17", approvedBy: 3,
  sourceHash: "a".repeat(64), approvedDocumentsHash: "b".repeat(64), approvedPreflightHash: "c".repeat(64),
  approvalExpiresAt: new Date(Date.now() + 60_000), legacyHandoffConfirmedAt: new Date() });
const request = { eventId: 17, approvalReference: "approved-event-17", documentNumber: "JD123", preparedBy: 3 };

describe("persisted initial storage approval", () => {
  beforeEach(() => { records.rows = [valid()]; });
  it("allows only the three Deal/suffix references for an unexpired claimed pilot", async () => {
    for (const number of ["INV-123-A", "JD123", "GD123"]) await expect(verifyInitialStoragePilotWriteAccess({ ...request, documentNumber: number })).resolves.toBeUndefined();
    await expect(verifyInitialStoragePilotWriteAccess({ ...request, documentNumber: "JD456" })).rejects.toThrow(/reserved suffix/);
  });
  it("holds expired, unclaimed, unapproved, changed or handoff-free records", async () => {
    for (const bad of [
      { status: "held" }, { approvalExpiresAt: new Date(Date.now() - 1000) }, { approvedPreflightHash: null },
      { legacyHandoffConfirmedAt: null }, { pilotApprovalKey: "other" }, { approvedBy: 99 },
    ]) {
      records.rows = [{ ...valid(), ...bad }];
      await expect(verifyInitialStoragePilotWriteAccess(request)).rejects.toThrow(/approval/);
    }
  });
});
