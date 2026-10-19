import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: vi.fn(), select: vi.fn(), insert: vi.fn(), values: vi.fn(), update: vi.fn(), set: vi.fn(), where: vi.fn(),
  policy: vi.fn(), anchors: vi.fn(), conflicts: vi.fn(), preflight: vi.fn(), rows: [] as any[] }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialD702946DepositMainDeductionRecoveryDb", () => ({ readD702946RecoveryAnchors: m.anchors, assertNoD702946RecoveryCompetingPaths: m.conflicts }));
vi.mock("./financialD702946AuthorisedDepositMainDeductionRecoveryRelease", async importOriginal => ({ ...await importOriginal<any>(), getD702946AuthorisedDepositMainDeductionRecoveryPolicy: m.policy }));
vi.mock("./financialD702946AuthorisedDepositMainDeductionRecoveryService", () => ({ readD702946AuthorisedDepositMainDeductionRecoveryPreflight: m.preflight }));
import { reserveD702946AuthorisedDepositMainDeductionRecovery, verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess } from "./financialD702946AuthorisedDepositMainDeductionRecoveryDb";
import { D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY,
  D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, prepareD702946AuthorisedDepositMainDeductionRecoveryPayload, jsonEvidence } from "./financialD702946AuthorisedDepositMainDeductionRecoveryScope";
import { anchors, drafts, source } from "./financialD702946DepositMainDeductionRecovery.testFixtures";
import { financialSha256 } from "./financialProposalIntegrity";

const policy = () => ({ enabled: true, releaseKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_RELEASE_KEY, approvedBy: 7, approvedAt: "2026-10-19T00:00:00.000Z", scope });
function preview() {
  const pair = drafts(); pair.deposit.Status = "AUTHORISED"; (pair.deposit as any).AmountDue = 500;
  const anchorEvidence = anchors(), sourceSnapshot = { ...source(), tenantIdHash: financialSha256("tenant") };
  const evidence = { scopeKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber,
    originalMainEventId: scope.originalMainEventId, failedMainWriterExecutionId: scope.failedMainWriterExecutionId,
    mainRecoveryEventId: scope.mainRecoveryEventId, mainRecoveryWriterExecutionId: scope.mainRecoveryWriterExecutionId,
    depositEventId: scope.depositEventId, depositWriterExecutionId: 1090001, mainInvoiceNumber: scope.mainInvoiceNumber,
    mainXeroInvoiceId: scope.mainXeroInvoiceId, depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId,
    anchorEvidenceHash: financialSha256(anchorEvidence), anchorEvidence, sourceSnapshotHash: financialSha256(sourceSnapshot), sourceSnapshot,
    xeroEvidenceHash: financialSha256({ main: pair.main, deposit: pair.deposit }), mainXeroSnapshot: pair.main, depositXeroSnapshot: pair.deposit };
  return { status: "ready" as const, noWrites: true as const, evidence, payload: prepareD702946AuthorisedDepositMainDeductionRecoveryPayload(pair.main, pair.deposit, financialSha256(evidence)) };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("FINANCIAL_D702946_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_ENABLED", "true"); m.rows = [];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [m.rows.shift()].filter(Boolean) }) }) }));
  m.insert.mockImplementation(() => ({ values: m.values })); m.values.mockResolvedValue(undefined);
  m.update.mockImplementation(() => ({ set: m.set })); m.set.mockImplementation(() => ({ where: m.where })); m.where.mockResolvedValue([{ affectedRows: 1 }]);
  m.db.mockResolvedValue({ select: m.select, insert: m.insert, update: m.update }); m.policy.mockResolvedValue(policy()); m.anchors.mockResolvedValue(anchors()); m.conflicts.mockResolvedValue(undefined); m.preflight.mockResolvedValue(preview());
});
afterEach(() => vi.unstubAllEnvs());
describe("D702946 Authorised Deposit V2 immutable ledger", () => {
  it("reserves only complete V2 evidence/payload and preserves V1 anchors unchanged", async () => {
    const p = preview(), stored = { id: 2, ...p.evidence, recoveryKey: financialSha256({ evidence: p.evidence, payload: p.payload, policy: policy() }), payloadHash: financialSha256(p.payload), authorisedPayload: p.payload, releaseKey: policy().releaseKey, approvedBy: 7, approvedAt: policy().approvedAt, policyHash: financialSha256(policy()), status: "reserved", processingToken: "token" };
    m.rows = [stored];
    expect(await reserveD702946AuthorisedDepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "token" })).toMatchObject({ state: "reserved", event: { id: 2, scopeKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY } });
    expect(m.values).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: D702946_AUTHORISED_DEPOSIT_RECOVERY_SCOPE_KEY, payloadHash: financialSha256(p.payload), authorisedPayload: p.payload }));
    expect(m.conflicts).toHaveBeenCalled();
  });
  it("returns blocked, never adopts, when the shared unique Main identity is already held by V1", async () => {
    const p = preview(); m.values.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" }));
    m.rows = [{ id: 1, scopeKey: "D702946-deposit-main-deduction-recovery-v1", status: "reserved", processingToken: "v1", mainXeroInvoiceId: scope.mainXeroInvoiceId }];
    expect(await reserveD702946AuthorisedDepositMainDeductionRecovery({ evidence: p.evidence, payload: p.payload, policy: policy(), token: "v2" })).toMatchObject({ state: "blocked", event: { id: 1 } });
    expect(m.update).not.toHaveBeenCalled();
  });
  it("re-verifies the complete current V2 preflight before a write and rejects any evidence drift", async () => {
    const p = preview(); const event = { id: 2, ...p.evidence, payloadHash: financialSha256(p.payload), authorisedPayload: p.payload, releaseKey: policy().releaseKey, approvedBy: 7, approvedAt: policy().approvedAt, policyHash: financialSha256(policy()), status: "reserved", processingToken: "token", submittedAt: null, executionId: null };
    m.rows = [event];
    await expect(verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess({ eventId: 2, token: "token", releaseKey: policy().releaseKey, preparedBy: 7, payload: p.payload })).resolves.toBeUndefined();
    const changed = preview(); changed.evidence.depositXeroSnapshot.AmountDue = 499.99; m.rows = [event]; m.preflight.mockResolvedValue(changed);
    await expect(verifyD702946AuthorisedDepositMainDeductionRecoveryWriteAccess({ eventId: 2, token: "token", releaseKey: policy().releaseKey, preparedBy: 7, payload: p.payload })).rejects.toThrow(/Final Authorised-Deposit/);
  });
});
