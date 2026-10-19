import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: vi.fn(), select: vi.fn(), insert: vi.fn(), values: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn(),
  policy: vi.fn(), preflight: vi.fn(), rows: [] as any[] }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialD702946DepositMainDeductionRecoveryRelease", async importOriginal => ({ ...await importOriginal<any>(), getD702946DepositMainDeductionRecoveryPolicy: m.policy }));
vi.mock("./financialD702946DepositMainDeductionRecoveryService", () => ({ readD702946DepositMainDeductionRecoveryPreflight: m.preflight }));
import { assertD702946RecoveryAnchors, reserveD702946DepositMainDeductionRecovery, verifyD702946DepositMainDeductionRecoveryWriteAccess,
  consumeD702946DepositMainDeductionRecoveryPayload, holdD702946DepositMainDeductionRecovery, assertNoD702946RecoveryCompetingPaths,
  getPendingD702946DepositMainDeductionRecovery } from "./financialD702946DepositMainDeductionRecoveryDb";
import { anchors, policy, receipt, previewFixture } from "./financialD702946DepositMainDeductionRecovery.testFixtures";
import { financialSha256 } from "./financialProposalIntegrity";
import { financialD702946DepositMainDeductionRecoveryEvents as events } from "../drizzle/schema";
import { D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope } from "./financialD702946DepositMainDeductionRecoveryScope";
const input = () => ({ eventId: 1, token: "token", releaseKey: policy().releaseKey, preparedBy: 7, payload: previewFixture().payload });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("FINANCIAL_D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true"); m.rows = [];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [m.rows.shift()].filter(Boolean) }) }) }));
  m.insert.mockImplementation(() => ({ values: m.values })); m.values.mockResolvedValue(undefined);
  m.update.mockImplementation(() => ({ set: m.set })); m.set.mockImplementation(() => ({ where: m.where })); m.where.mockResolvedValue([{ affectedRows: 1 }]);
  m.db.mockResolvedValue({ select: m.select, insert: m.insert, update: m.update }); m.policy.mockResolvedValue(policy()); m.preflight.mockResolvedValue(previewFixture());
});
afterEach(() => vi.unstubAllEnvs());
describe("immutable D702946 recovery ledger", () => {
  it("uses original uncertain receipt only through exact completed recovery and Deposit successful writer anchors", () => {
    expect(() => assertD702946RecoveryAnchors(anchors())).not.toThrow();
    expect(anchors().originalMain.status).toBe("reconciliation_required");
  });
  it("accepts only the historic omitted creation InvoiceID serialization for the two known anchor receipts", () => {
    const anchor = anchors();
    for (const [receiptKey, number] of [["mainRecovery", scope.mainInvoiceNumber], ["deposit", scope.depositInvoiceNumber]] as const) {
      const stored = structuredClone(anchor[receiptKey].authorisedPayload.payload);
      const historic = structuredClone(stored);
      (historic.body.Invoices[0] as Record<string, unknown>).InvoiceID = undefined;
      anchor[receiptKey].authorisedPayload = { hash: financialSha256(historic), payload: stored, number };
    }
    expect(() => assertD702946RecoveryAnchors(anchor)).not.toThrow();
    anchor.mainRecovery.authorisedPayload.payload.body.Invoices[0].InvoiceID = "unexpected";
    expect(() => assertD702946RecoveryAnchors(anchor)).toThrow();
  });
  it.each([ ["originalMain", { status: "drafts_created" }], ["originalMain", { id: 750002 }], ["failedMainWriter", { status: "reconciliation_required" }],
    ["mainRecovery", { id: 2 }], ["mainRecovery", { executionId: 1170002 }], ["mainRecovery", { originalEventHash: "changed" }],
    ["mainRecovery", { status: "submitted" }], ["mainRecoveryWriter", { status: "failed" }], ["mainRecoveryWriter", { xeroDocumentId: "wrong" }],
    ["deposit", { id: 270002 }], ["deposit", { status: "reconciliation_required" }], ["deposit", { xeroInvoiceId: "other" }],
    ["depositWriter", { status: "submitted" }], ["depositWriter", { idempotencyKey: "changed" }] ])("rejects any changed ownership receipt %#", (key, patch) => {
      const a = anchors(); a[key as string] = { ...a[key as string], ...(patch as object) }; expect(() => assertD702946RecoveryAnchors(a)).toThrow();
  });
  it("creates immutable evidence and complete payload together; no later bind/update can replace it", async () => {
    const p = previewFixture(); m.rows = [receipt()];
    expect(await reserveD702946DepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "token" })).toMatchObject({ state: "reserved" });
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ ...p.evidence, payloadHash: financialSha256(p.payload), authorisedPayload: p.payload, approvedBy: 7 }));
    expect(m.update).not.toHaveBeenCalled();
  });
  it("simultaneous reservations produce exactly one winner even if both observe the same token", async () => {
    let stored: any = null;
    m.values.mockImplementation(async value => { if (stored) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }); stored = { id: 1, ...value }; });
    m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => stored ? [stored] : [] }) }) }));
    const p = previewFixture(), reservation = { evidence: p.evidence, payload: p.payload, policy: policy(), token: "same-token" };
    const results = await Promise.all([reserveD702946DepositMainDeductionRecovery(reservation), reserveD702946DepositMainDeductionRecovery(reservation)]);
    expect(results.map(result => result.state).sort()).toEqual(["blocked", "reserved"]); expect(m.update).not.toHaveBeenCalled();
  });
  it("returns a safe block rather than adopting an Authorised-Deposit V2 receipt with the same Main identity", async () => {
    const p = previewFixture(); m.values.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }));
    m.rows = [{ ...receipt(), scopeKey: "D702946-authorised-deposit-main-deduction-recovery-v2", status: "reserved", processingToken: "v2" }];
    expect(await reserveD702946DepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "v1" })).toMatchObject({ state: "blocked", event: { scopeKey: "D702946-authorised-deposit-main-deduction-recovery-v2" } });
    expect(m.update).not.toHaveBeenCalled();
  });
  it("never reopens an uncertain/completed reservation regardless of changed evidence", async () => {
    const p = previewFixture(); m.values.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }));
    m.rows = [{ ...receipt(), status: "reconciliation_required" }];
    expect(await reserveD702946DepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "second" })).toMatchObject({ state: "blocked" });
    m.rows = [{ ...receipt(), status: "draft_updated" }];
    expect(await reserveD702946DepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "second" })).toMatchObject({ state: "completed" });
    expect(m.update).not.toHaveBeenCalled();
  });
  it("final verifier proves exact same complete evidence/payload, not just a hash supplied by caller", async () => {
    m.rows = [receipt()]; await expect(verifyD702946DepositMainDeductionRecoveryWriteAccess(input())).resolves.toBeUndefined();
    for (const drift of ["source", "xero", "payload", "already"]) {
      const p = previewFixture();
      if (drift === "source") p.evidence.sourceSnapshot.mainFacts.customerName = "changed";
      if (drift === "xero") p.evidence.mainXeroSnapshot.Reference = "changed";
      if (drift === "payload") (p.payload.body.Invoices as any[])[0].LineItems[0].Description = "changed";
      m.preflight.mockResolvedValue(drift === "already" ? { status: "already_deducted" } : p); m.rows = [receipt()];
      await expect(verifyD702946DepositMainDeductionRecoveryWriteAccess(input())).rejects.toThrow(/Final recovery verifier/);
    }
    expect(m.insert).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
  it.each([{ token: "other" }, { releaseKey: "generic" }, { preparedBy: 8 }])("requires exact context %#", async patch => {
    m.rows = [receipt()]; await expect(verifyD702946DepositMainDeductionRecoveryWriteAccess({ ...input(), ...patch })).rejects.toThrow(/reservation/);
    expect(m.preflight).not.toHaveBeenCalled();
  });
  it("only consumes one exact submitted writer ID, before transport, never re-reserves", async () => {
    const r = receipt(), p = previewFixture().payload;
    const writer = { id: 1200001, status: "submitted", workflowType: "d702946_deposit_main_deduction_recovery", documentFamily: "customer_invoice", proposedAction: "update_draft",
      proposedDocumentNumber: "INV-702946", targetXeroDocumentId: p.expectedXeroDocumentId, method: "POST", endpoint: p.endpoint,
      idempotencyKey: p.idempotencyKey, payloadFingerprint: `${p.idempotencyKey.slice(0,24)}:POST:${p.endpoint}`, approvalReference: policy().releaseKey, preparedBy: 7, submittedAt: new Date() };
    m.rows = [r, writer]; await consumeD702946DepositMainDeductionRecoveryPayload({ eventId: 1, token: "token" }, writer.id);
    expect(m.set).toHaveBeenCalledWith(expect.objectContaining({ status: "submitted", executionId: writer.id, submittedAt: expect.any(Date) }));
    m.rows = [r, writer]; m.where.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(consumeD702946DepositMainDeductionRecoveryPayload({ eventId: 1, token: "token" }, writer.id)).rejects.toThrow(/never POST again/);
  });
  it("holds submitted or reserved receipt without changing immutable payload/evidence or original tables", async () => {
    await holdD702946DepositMainDeductionRecovery(1, "token", "uncertain");
    expect(m.update).toHaveBeenCalledWith(events); expect(m.set).toHaveBeenCalledWith({ status: "reconciliation_required", processingToken: null, holdReason: "uncertain" });
  });
  it("exposes only a pending D702946 receipt to collaborating writers", async () => {
    m.rows = [{ ...receipt(), status: "submitted" }];
    expect(await getPendingD702946DepositMainDeductionRecovery(scope.mainXeroInvoiceId)).toMatchObject({ status: "submitted" });
    expect(await getPendingD702946DepositMainDeductionRecovery("other-invoice")).toBeNull();
  });
  it.each([0, 1, 2, 3, 4, 5, 6])("fails closed on each competing financial path %#", async index => {
    m.rows = Array.from({ length: 7 }, (_, i) => i === index ? { id: 9 } : undefined);
    await expect(assertNoD702946RecoveryCompetingPaths()).rejects.toThrow(/Competing/);
    expect(m.update).not.toHaveBeenCalled();
  });
});
