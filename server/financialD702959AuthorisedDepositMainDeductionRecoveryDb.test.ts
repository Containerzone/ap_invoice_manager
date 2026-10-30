import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: vi.fn(), select: vi.fn(), insert: vi.fn(), values: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn(),
  policy: vi.fn(), preflight: vi.fn(), rows: [] as any[] }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialD702959AuthorisedDepositMainDeductionRecoveryRelease", async importOriginal => ({ ...await importOriginal<any>(), getD702959AuthorisedDepositMainDeductionRecoveryPolicy: m.policy }));
vi.mock("./financialD702959AuthorisedDepositMainDeductionRecoveryService", () => ({ readD702959AuthorisedDepositMainDeductionRecoveryPreflight: m.preflight }));
import {
  assertD702959AuthorisedDepositRecoveryAnchors,
  consumeD702959AuthorisedDepositMainDeductionRecoveryPayload,
  getPendingD702959AuthorisedDepositMainDeductionRecovery,
  reserveD702959AuthorisedDepositMainDeductionRecovery,
  verifyD702959AuthorisedDepositMainDeductionRecoveryWriteAccess,
} from "./financialD702959AuthorisedDepositMainDeductionRecoveryDb";
import { anchors, drafts, scope, source } from "./financialD702959AuthorisedDepositMainDeductionRecovery.testFixtures";
import { D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, prepareD702959AuthorisedDepositMainDeductionRecoveryPayload } from "./financialD702959AuthorisedDepositMainDeductionRecoveryScope";
import { financialSha256 } from "./financialProposalIntegrity";

const policy = () => ({ enabled: true, releaseKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, approvedBy: 7, approvedAt: "2026-10-29T00:00:00.000Z", scope });
function preview() {
  const pair = drafts(), anchorEvidence = anchors(), sourceSnapshot = { ...source(), tenantIdHash: financialSha256("tenant") };
  const evidence = { scopeKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber,
    originalMainEventId: scope.originalMainEventId, failedMainWriterExecutionId: scope.failedMainWriterExecutionId,
    depositEventId: scope.depositEventId, depositWriterExecutionId: scope.depositWriterExecutionId,
    mainInvoiceNumber: scope.mainInvoiceNumber, mainXeroInvoiceId: scope.mainXeroInvoiceId,
    depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId,
    anchorEvidenceHash: financialSha256(anchorEvidence), anchorEvidence, sourceSnapshotHash: financialSha256(sourceSnapshot), sourceSnapshot,
    xeroEvidenceHash: financialSha256({ main: pair.main, deposit: pair.deposit }), mainXeroSnapshot: pair.main, depositXeroSnapshot: pair.deposit };
  return { status: "ready" as const, noWrites: true as const, evidence,
    payload: prepareD702959AuthorisedDepositMainDeductionRecoveryPayload(pair.main, pair.deposit, financialSha256(evidence)) };
}
function receipt() {
  const p = preview(), approval = policy();
  return { id: 1, ...p.evidence, recoveryKey: financialSha256({ evidence: p.evidence, payload: p.payload, policy: approval }), payloadHash: financialSha256(p.payload),
    authorisedPayload: p.payload, releaseKey: approval.releaseKey, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt,
    policyHash: financialSha256(approval), processingToken: "token", status: "reserved", executionId: null, submittedAt: null };
}
const accessInput = () => ({ eventId: 1, token: "token", releaseKey: policy().releaseKey, preparedBy: 7, payload: preview().payload });

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("FINANCIAL_D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true"); m.rows = [];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [m.rows.shift()].filter(Boolean) }) }) }));
  m.insert.mockImplementation(() => ({ values: m.values })); m.values.mockResolvedValue(undefined);
  m.update.mockImplementation(() => ({ set: m.set })); m.set.mockImplementation(() => ({ where: m.where })); m.where.mockResolvedValue([{ affectedRows: 1 }]);
  m.db.mockResolvedValue({ select: m.select, insert: m.insert, update: m.update }); m.policy.mockResolvedValue(policy()); m.preflight.mockResolvedValue(preview());
});
afterEach(() => vi.unstubAllEnvs());

describe("D702959 isolated immutable recovery ledger", () => {
  it("accepts only the named original reconciliation receipt and named successful Deposit writer receipt", () => {
    expect(() => assertD702959AuthorisedDepositRecoveryAnchors(anchors())).not.toThrow();
    // Historic MySQL JSON omitted undefined payload properties before the event
    // hash was retained; structural receipt/writer proof must remain valid.
    const historic = anchors();
    historic.deposit.authorisedPayload.hash = "a".repeat(64);
    expect(() => assertD702959AuthorisedDepositRecoveryAnchors(historic)).not.toThrow();
    for (const [key, patch] of [
      ["originalMain", { id: 1290002 }], ["originalMain", { status: "drafts_created" }], ["failedMainWriter", { status: "failed" }],
      ["failedMainWriter", { errorMessage: "other" }], ["deposit", { xeroInvoiceId: "other" }], ["deposit", { status: "reconciliation_required" }],
      ["depositWriter", { status: "submitted" }], ["depositWriter", { xeroDocumentId: "other" }],
    ] as const) {
      const evidence = anchors(); evidence[key] = { ...evidence[key], ...patch };
      expect(() => assertD702959AuthorisedDepositRecoveryAnchors(evidence)).toThrow();
    }
  });

  it("reserves complete immutable D702959 evidence and payload in one insert, with no later payload bind", async () => {
    const p = preview(), stored = receipt(); m.rows = [anchors().originalMain, anchors().failedMainWriter, anchors().deposit, anchors().depositWriter, ...Array(7).fill(undefined), stored];
    await expect(reserveD702959AuthorisedDepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "token" })).resolves.toMatchObject({ state: "reserved", event: { id: 1 } });
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: D702959_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, payloadHash: financialSha256(p.payload), authorisedPayload: p.payload }));
    expect(m.update).not.toHaveBeenCalled();
  });

  it("blocks rather than adopts a colliding reservation and never reopens a consumed/uncertain one", async () => {
    const p = preview(); m.values.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }));
    m.rows = [anchors().originalMain, anchors().failedMainWriter, anchors().deposit, anchors().depositWriter, ...Array(7).fill(undefined), { ...receipt(), scopeKey: "another-closed-scope", status: "reserved" }];
    await expect(reserveD702959AuthorisedDepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "new" })).resolves.toMatchObject({ state: "blocked" });
    m.rows = [anchors().originalMain, anchors().failedMainWriter, anchors().deposit, anchors().depositWriter, ...Array(7).fill(undefined), { ...receipt(), status: "reconciliation_required" }];
    await expect(reserveD702959AuthorisedDepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "new" })).resolves.toMatchObject({ state: "blocked" });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("revalidates the complete fresh evidence/payload and rejects source, Xero, payload, or context drift", async () => {
    for (const kind of ["source", "xero", "payload", "already"] as const) {
      const current = preview();
      if (kind === "source") current.evidence.sourceSnapshot.depositFacts.depositAmountRequiredInclusive = 501;
      if (kind === "xero") current.evidence.mainXeroSnapshot.Reference = "changed";
      if (kind === "payload") (current.payload.body.Invoices as any[])[0].LineItems[0].Description = "changed";
      m.rows = [receipt()]; m.preflight.mockResolvedValue(kind === "already" ? { status: "already_deducted" } : current);
      await expect(verifyD702959AuthorisedDepositMainDeductionRecoveryWriteAccess(accessInput())).rejects.toThrow(/Final D702959 verifier/);
    }
    m.rows = [receipt()]; m.preflight.mockResolvedValue(preview());
    await expect(verifyD702959AuthorisedDepositMainDeductionRecoveryWriteAccess(accessInput())).resolves.toBeUndefined();
    for (const patch of [{ token: "other" }, { releaseKey: "generic" }, { preparedBy: 8 }]) {
      m.rows = [receipt()];
      await expect(verifyD702959AuthorisedDepositMainDeductionRecoveryWriteAccess({ ...accessInput(), ...patch })).rejects.toThrow(/reservation/);
    }
  });

  it("consumes exactly one matching submitted writer receipt before transport and rejects a second consume", async () => {
    const r = receipt(), p = preview().payload;
    const writer = { id: 2200001, status: "submitted", workflowType: scope.workflowType, documentFamily: "customer_invoice", proposedAction: "update_draft",
      proposedDocumentNumber: scope.mainInvoiceNumber, targetXeroDocumentId: scope.mainXeroInvoiceId, method: "POST", endpoint: p.endpoint,
      idempotencyKey: p.idempotencyKey, payloadFingerprint: `${p.idempotencyKey.slice(0, 24)}:POST:${p.endpoint}`, approvalReference: policy().releaseKey, preparedBy: 7, submittedAt: new Date() };
    m.rows = [r, writer];
    await consumeD702959AuthorisedDepositMainDeductionRecoveryPayload({ eventId: 1, token: "token" }, writer.id);
    expect(m.set).toHaveBeenCalledWith(expect.objectContaining({ status: "submitted", executionId: writer.id, submittedAt: expect.any(Date) }));
    m.rows = [r, writer]; m.where.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(consumeD702959AuthorisedDepositMainDeductionRecoveryPayload({ eventId: 1, token: "token" }, writer.id)).rejects.toThrow(/never POST again/);
  });

  it("exposes only a pending receipt for the fixed Main ID to other amendment writers", async () => {
    m.rows = [{ ...receipt(), status: "submitted" }];
    await expect(getPendingD702959AuthorisedDepositMainDeductionRecovery(scope.mainXeroInvoiceId)).resolves.toMatchObject({ status: "submitted" });
    await expect(getPendingD702959AuthorisedDepositMainDeductionRecovery("other")).resolves.toBeNull();
  });
});
