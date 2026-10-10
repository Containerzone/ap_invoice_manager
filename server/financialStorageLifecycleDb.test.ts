import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rows: [] as any[], policy: {} as any }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => state.rows }) }) }) })) }));
vi.mock("./financialStorageRelease", async importOriginal => ({ ...await importOriginal<typeof import("./financialStorageRelease")>(), getStorageReleasePolicy: vi.fn(async () => state.policy) }));
import { storagePayloadHash, verifyStorageAutomaticWriteAccess } from "./financialStorageLifecycleDb";
import { STORAGE_RULES_HASH } from "./financialStorageRelease";
import type { FinancialDraftPayload } from "./financialProductionWriter";
const payload = (): FinancialDraftPayload => ({ endpoint: "/Invoices", method: "POST", documentFamily: "customer_invoice", documentNumber: "INV-123-A", expectedXeroDocumentId: null, idempotencyKey: "a".repeat(64), body: { Invoices: [{ Status: "DRAFT", Contact: { ContactID: "c1" } }] } });
const request = () => ({ eventId: 1, releaseKey: "release", payload: payload(), workflowType: "storage_activation", preparedBy: 3 });
beforeEach(() => {
  vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
  state.policy = { releaseKey: "release", enabled: true, rulesHash: STORAGE_RULES_HASH, approvedBy: 3, approvedAt: "2026-08-01", effectiveFrom: "2026-08-01", recoveryEnabled: true, handoffs: { activation: true, recurring: true, finalisation: true } };
  state.rows = [{ id: 1, eventKind: "initial", status: "reserved", releaseKey: "release", authorisedPayloads: [{ hash: storagePayloadHash(payload()), number: "INV-123-A", mode: "storage_activation" }] }];
});
afterEach(() => vi.unstubAllEnvs());
describe("storage automatic persisted exact payload gate", () => {
  it("checks exact persisted hash, release identity and approver", async () => {
    await expect(verifyStorageAutomaticWriteAccess(request())).resolves.toBeUndefined();
    for (const patch of [{ preparedBy: 99 }, { releaseKey: "other" }]) await expect(verifyStorageAutomaticWriteAccess({ ...request(), ...patch })).rejects.toThrow(/claim/);
    const changed = request(); changed.payload.body = { Invoices: [{ Status: "AUTHORISED" }] };
    await expect(verifyStorageAutomaticWriteAccess(changed)).rejects.toThrow(/payload/);
  });
  it("rejects unlocked, missing and stale-policy events before transport", async () => {
    state.rows[0].status = "held";
    await expect(verifyStorageAutomaticWriteAccess(request())).rejects.toThrow(/claim/);
    state.rows = [];
    await expect(verifyStorageAutomaticWriteAccess(request())).rejects.toThrow(/claim/);
    state.policy.enabled = false;
    await expect(verifyStorageAutomaticWriteAccess(request())).rejects.toThrow(/disabled/);
  });
  it("cannot use an initial approval for a PUT, another family or unrelated document", async () => {
    const put = request(); put.payload.method = "PUT"; put.payload.expectedXeroDocumentId = "id1";
    state.rows[0].authorisedPayloads = [{ hash: storagePayloadHash(put.payload), number: put.payload.documentNumber, mode: put.workflowType }];
    await expect(verifyStorageAutomaticWriteAccess(put)).rejects.toThrow(/Only finalisation/);
    await expect(verifyStorageAutomaticWriteAccess({ ...request(), workflowType: "extra_hire" })).rejects.toThrow(/payload/);
  });
});
