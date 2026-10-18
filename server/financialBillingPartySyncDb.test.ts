import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ db: null as any, lock: null as any, events: [] as any[], writes: [] as any[], available: true }));
vi.mock("drizzle-orm", async original => ({
  ...(await original<any>()),
  and: (...terms: any[]) => ({ op: "and", terms }),
  eq: (column: any, value: any) => ({ op: "eq", key: column.name, value }),
  ne: (column: any, value: any) => ({ op: "ne", key: column.name, value }),
  inArray: (column: any, value: any[]) => ({ op: "in", key: column.name, value }),
}));
vi.mock("./db", () => ({ getDb: vi.fn(async () => state.available ? state.db : null) }));
import { financialBillingPartySyncEvents, financialBillingPartySyncLocks } from "../drizzle/schema";
import {
  reserveBillingPartySyncInvoiceLock, setBillingPartySyncInvoiceLockState,
  getBillingPartySyncPendingInvoiceLock, recordBillingPartySyncEvent,
} from "./financialBillingPartySyncDb";
const input = (patch: Record<string, unknown> = {}) => ({
  xeroInvoiceId: "invoice-exact", eventFingerprint: "new-event", dealId: "5x77",
  originalContactId: "party-B", targetContactId: "party-C", ...patch,
});
function matches(row: any, expression: any): boolean {
  if (!expression) return true;
  if (expression.op === "and") return expression.terms.every((term: any) => matches(row, term));
  if (expression.op === "eq") return row[expression.key] === expression.value;
  if (expression.op === "ne") return row[expression.key] !== expression.value;
  if (expression.op === "in") return expression.value.includes(row[expression.key]);
  throw new Error("Unsupported mocked predicate");
}
beforeEach(() => {
  state.available = true; state.lock = null; state.events = []; state.writes = [];
  state.db = {
    insert: (table: any) => ({ values: async (value: any) => {
      if (table === financialBillingPartySyncLocks) {
        if (state.lock) throw Object.assign(new Error("duplicate invoice"), { code: "ER_DUP_ENTRY" });
        state.lock = { id: 1, ...value };
      } else if (table === financialBillingPartySyncEvents) {
        if (state.events.some(row => row.eventFingerprint === value.eventFingerprint)) throw Object.assign(new Error("duplicate event"), { code: "ER_DUP_ENTRY" });
        state.events.push({ id: 2, ...value });
      }
      state.writes.push({ type: "insert", table, value });
    } }),
    select: () => ({ from: (table: any) => ({ where: (expression: any) => ({ limit: async () => {
      const rows = table === financialBillingPartySyncLocks ? state.lock ? [state.lock] : [] : state.events;
      return rows.filter((row: any) => matches(row, expression)).map((row: any) => ({ ...row }));
    } }) }) }),
    update: (table: any) => ({ set: (patch: any) => ({ where: async (expression: any) => {
      if (table !== financialBillingPartySyncLocks) throw new Error("Immutable evidence must never be updated");
      const count = state.lock && matches(state.lock, expression) ? 1 : 0;
      if (count) { state.writes.push({ type: "update", table, patch }); state.lock = { ...state.lock, ...patch }; }
      return [{ affectedRows: count }];
    } }) }),
  };
});
describe("billing sync atomic and immutable ledger guards", () => {
  it("inserts and grants exactly one new invoice reservation", async () => {
    expect(await reserveBillingPartySyncInvoiceLock(input())).toMatchObject({ kind: "reserved", lock: { state: "reserved", eventFingerprint: "new-event" } });
    expect(await reserveBillingPartySyncInvoiceLock(input())).toMatchObject({ kind: "existing" });
  });
  it.each(["reserved", "submitted", "held", "reconciliation_required"])("never reopens a %s transition", async lockState => {
    state.lock = { id: 1, ...input({ eventFingerprint: "old-event", targetContactId: "party-B" }), state: lockState };
    expect(await reserveBillingPartySyncInvoiceLock(input())).toMatchObject({ kind: "existing", lock: { state: lockState } });
    expect(state.writes).toEqual([]);
  });
  it("allows a verified A-to-B update to become a later B-to-C reservation", async () => {
    state.lock = { id: 1, ...input({ eventFingerprint: "old-event", targetContactId: "party-B" }), state: "updated" };
    expect(await reserveBillingPartySyncInvoiceLock(input())).toMatchObject({ kind: "reserved", lock: { targetContactId: "party-C", state: "reserved" } });
  });
  it.each([{ originalContactId: "wrong-original" }, { dealId: "5x88" }, { eventFingerprint: "old-event" }])("refuses unsafe verified-lock reuse %#", async patch => {
    state.lock = { id: 1, ...input({ eventFingerprint: "old-event", targetContactId: "party-B" }), state: "updated" };
    expect(await reserveBillingPartySyncInvoiceLock(input(patch))).toMatchObject({ kind: "existing" });
    expect(state.writes).toEqual([]);
  });
  it("only one simultaneous later transition wins the updated-to-reserved CAS", async () => {
    state.lock = { id: 1, ...input({ eventFingerprint: "old-event", targetContactId: "party-B" }), state: "updated" };
    const results = await Promise.all([
      reserveBillingPartySyncInvoiceLock(input({ eventFingerprint: "event-C", targetContactId: "party-C" })),
      reserveBillingPartySyncInvoiceLock(input({ eventFingerprint: "event-D", targetContactId: "party-D" })),
    ]);
    expect(results.filter(result => result.kind === "reserved")).toHaveLength(1);
    expect(results.filter(result => result.kind === "existing")).toHaveLength(1);
    expect(state.writes.filter(write => write.type === "update")).toHaveLength(1);
  });
  it("a stale callback cannot modify the next event's shared invoice lock", async () => {
    state.lock = { id: 1, ...input(), state: "submitted" };
    expect(await setBillingPartySyncInvoiceLockState({ lockId: 1, eventFingerprint: "old-event", from: ["submitted"], to: "updated" })).toBe(false);
    expect(state.lock.state).toBe("submitted");
    expect(await setBillingPartySyncInvoiceLockState({ lockId: 1, eventFingerprint: "new-event", from: ["submitted"], to: "updated" })).toBe(true);
  });
  it.each(["reserved", "submitted", "reconciliation_required"])("exposes a %s lock to other writers but allows own-event exclusion", async lockState => {
    state.lock = { id: 1, ...input(), state: lockState };
    expect(await getBillingPartySyncPendingInvoiceLock("invoice-exact")).toMatchObject({ state: lockState });
    expect(await getBillingPartySyncPendingInvoiceLock("other-invoice")).toBeNull();
    expect(await getBillingPartySyncPendingInvoiceLock("invoice-exact", "new-event")).toBeNull();
  });
  it("does not expose a fully read-back-verified lock as pending", async () => {
    state.lock = { id: 1, ...input(), state: "updated" };
    expect(await getBillingPartySyncPendingInvoiceLock("invoice-exact")).toBeNull();
  });
  it("a duplicate event reads immutable evidence instead of replacing the source snapshot", async () => {
    const first = { ...input(), sourceSnapshot: { original: true } } as any;
    await recordBillingPartySyncEvent(first);
    expect(await recordBillingPartySyncEvent({ ...first, sourceSnapshot: { changed: true } })).toMatchObject({ sourceSnapshot: { original: true } });
    expect(state.writes.filter(write => write.type === "insert")).toHaveLength(1);
    expect(state.writes.filter(write => write.type === "update")).toHaveLength(0);
  });
  it("fails shut when the migration or database is unavailable", async () => {
    state.available = false;
    await expect(reserveBillingPartySyncInvoiceLock(input())).rejects.toThrow(/ledger is unavailable/);
  });
});
