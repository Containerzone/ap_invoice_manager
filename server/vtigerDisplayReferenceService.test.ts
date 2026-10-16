import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

const { mockGetDb, mockRetrieve } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockRetrieve: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mockGetDb }));
vi.mock("./vtigerFinancialReadService", () => ({
  retrieveCurrentVtigerFinancialRecord: mockRetrieve,
}));

type ReferenceRow = { recordId: string | null; businessNumber: string | null };
type RowsByTable = Record<string, ReferenceRow[]>;

function readOnlyDb(rowsByTable: RowsByTable) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(rowsByTable[getTableName(table as any)] ?? []),
      }),
    }),
  };
}

async function subject() {
  return import("./vtigerDisplayReferenceService");
}

describe("resolveVtigerDisplayReferences", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetDb.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a persisted Container Control mapping rather than a technical numeric suffix", async () => {
    mockGetDb.mockResolvedValue(readOnlyDb({
      financial_for_hire_po_events: [{ recordId: "79x489399", businessNumber: "C1915" }],
    }));

    await expect((await subject()).resolveVtigerDisplayReferences(["79X489399"]))
      .resolves.toEqual([{ recordId: "79x489399", businessNumber: "C1915" }]);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("never infers a business number from a technical ID suffix", async () => {
    mockRetrieve.mockResolvedValue({ id: "79x489399" });

    await expect((await subject()).resolveVtigerDisplayReferences(["79x489399"]))
      .resolves.toEqual([{ recordId: "79x489399", businessNumber: null }]);
    expect(mockRetrieve).toHaveBeenCalledWith("79x489399");
  });

  it("rejects an upstream record whose returned ID does not exactly match the requested ID", async () => {
    mockRetrieve.mockResolvedValue({ id: "5x9", potential_no: "D1915" });

    await expect((await subject()).resolveVtigerDisplayReferences(["5x8"]))
      .resolves.toEqual([{ recordId: "5x8", businessNumber: null }]);
  });

  it("rejects IDs and business numbers with the wrong prefix", async () => {
    await expect((await subject()).resolveVtigerDisplayReferences(["4x8"]))
      .rejects.toThrow("only 5x… or 79x…");

    mockRetrieve.mockResolvedValue({ id: "5x8", potential_no: "C1915" });
    await expect((await subject()).resolveVtigerDisplayReferences(["5x8"]))
      .resolves.toEqual([{ recordId: "5x8", businessNumber: null }]);
  });

  it("normalizes duplicate IDs and coalesces their one exact upstream retrieval", async () => {
    mockRetrieve.mockResolvedValue({ id: "79x489399", vtcmcontainercontrolsnumber: "C1915" });

    await expect((await subject()).resolveVtigerDisplayReferences(["79X489399", "79x489399"]))
      .resolves.toEqual([{ recordId: "79x489399", businessNumber: "C1915" }]);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it("returns null for conflicting persisted business numbers without consulting VTiger", async () => {
    mockGetDb.mockResolvedValue(readOnlyDb({
      financial_main_customer_invoice_events: [{ recordId: "5x12", businessNumber: "D100" }],
      financial_deposit_invoice_events: [{ recordId: "5x12", businessNumber: "D101" }],
    }));

    await expect((await subject()).resolveVtigerDisplayReferences(["5x12"]))
      .resolves.toEqual([{ recordId: "5x12", businessNumber: null }]);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("ignores absent persisted business numbers while retaining a verified paired mapping", async () => {
    mockGetDb.mockResolvedValue(readOnlyDb({
      financial_main_customer_invoice_events: [{ recordId: "5x12", businessNumber: "D100" }],
      financial_deposit_invoice_events: [{ recordId: "5x12", businessNumber: null }],
      financial_final_weight_adjustment_events: [{ recordId: "5x12", businessNumber: "" }],
    }));

    await expect((await subject()).resolveVtigerDisplayReferences(["5x12"]))
      .resolves.toEqual([{ recordId: "5x12", businessNumber: "D100" }]);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("rejects a malformed nonempty persisted business number without consulting VTiger", async () => {
    mockGetDb.mockResolvedValue(readOnlyDb({
      financial_main_customer_invoice_events: [{ recordId: "5x12", businessNumber: "C100" }],
    }));

    await expect((await subject()).resolveVtigerDisplayReferences(["5x12"]))
      .resolves.toEqual([{ recordId: "5x12", businessNumber: null }]);
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("returns null and short-caches an upstream error without surfacing its message", async () => {
    mockRetrieve.mockRejectedValue(new Error("VTIGER_ACCESS_KEY=credential-must-not-leak"));
    const resolver = await subject();

    await expect(resolver.resolveVtigerDisplayReferences(["5x8"]))
      .resolves.toEqual([{ recordId: "5x8", businessNumber: null }]);
    await expect(resolver.resolveVtigerDisplayReferences(["5x8"]))
      .resolves.toEqual([{ recordId: "5x8", businessNumber: null }]);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it("caches a successful exact upstream result for repeated resolution", async () => {
    mockRetrieve.mockResolvedValue({ id: "5x8", potential_no: "D1915" });
    const resolver = await subject();

    await expect(resolver.resolveVtigerDisplayReferences(["5x8"]))
      .resolves.toEqual([{ recordId: "5x8", businessNumber: "D1915" }]);
    await expect(resolver.resolveVtigerDisplayReferences(["5x8"]))
      .resolves.toEqual([{ recordId: "5x8", businessNumber: "D1915" }]);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it("expires a successful upstream cache entry after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockRetrieve.mockResolvedValue({ id: "5x8", potential_no: "D1915" });
    const resolver = await subject();

    await resolver.resolveVtigerDisplayReferences(["5x8"]);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await resolver.resolveVtigerDisplayReferences(["5x8"]);

    expect(mockRetrieve).toHaveBeenCalledTimes(2);
  });

  it("enforces the fifty-ID batch cap before any database or upstream read", async () => {
    const recordIds = Array.from({ length: 51 }, (_, index) => `5x${index + 1}`);

    await expect((await subject()).resolveVtigerDisplayReferences(recordIds))
      .rejects.toThrow("At most 50");
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("coalesces an in-flight exact upstream lookup across concurrent batches", async () => {
    let releaseUpstream!: () => void;
    const upstream = new Promise<Record<string, unknown>>((resolve) => {
      releaseUpstream = () => resolve({ id: "5x8", potential_no: "D1915" });
    });
    mockRetrieve.mockReturnValue(upstream);
    const resolver = await subject();

    const firstBatch = resolver.resolveVtigerDisplayReferences(["5x8"]);
    await vi.waitFor(() => expect(mockRetrieve).toHaveBeenCalledTimes(1));
    const secondBatch = resolver.resolveVtigerDisplayReferences(["5x8"]);
    releaseUpstream();

    await expect(Promise.all([firstBatch, secondBatch])).resolves.toEqual([
      [{ recordId: "5x8", businessNumber: "D1915" }],
      [{ recordId: "5x8", businessNumber: "D1915" }],
    ]);
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it("limits exact upstream reads to two globally across concurrent batches", async () => {
    const releases: Array<() => void> = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    mockRetrieve.mockImplementation((recordId: string) => new Promise<Record<string, unknown>>((resolve) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      releases.push(() => {
        activeReads -= 1;
        resolve({ id: recordId, potential_no: "D1" });
      });
    }));
    const resolver = await subject();
    const batches = [
      resolver.resolveVtigerDisplayReferences(["5x1", "5x2"]),
      resolver.resolveVtigerDisplayReferences(["5x3", "5x4"]),
      resolver.resolveVtigerDisplayReferences(["5x5", "5x6"]),
    ];

    await vi.waitFor(() => expect(mockRetrieve).toHaveBeenCalledTimes(2));
    for (let released = 0; released < 6; released += 1) {
      const release = releases.shift();
      expect(release).toBeDefined();
      release!();
      if (released < 4) await vi.waitFor(() => expect(mockRetrieve).toHaveBeenCalledTimes(released + 3));
    }

    await expect(Promise.all(batches)).resolves.toHaveLength(3);
    expect(maxActiveReads).toBe(2);
  });
});
