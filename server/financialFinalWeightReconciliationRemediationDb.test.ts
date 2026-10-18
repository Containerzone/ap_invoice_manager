import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ db: vi.fn(), rows: [] as any[], select: vi.fn(), insert: vi.fn(), update: vi.fn(), values: vi.fn(), set: vi.fn(), where: vi.fn(), source: vi.fn(), xero: vi.fn(), policy: vi.fn() }));
vi.mock("./db", () => ({ getDb: m.db }));
vi.mock("./financialFinalWeightAdjustmentSource", () => ({ readFinalWeightFacts: m.source }));
vi.mock("./financialReadOnlyXeroService", () => ({ readFinalWeightXeroEvidence: m.xero }));
vi.mock("./financialFinalWeightAdjustmentRelease", async original => ({ ...(await original<any>()), getFinalWeightReleasePolicy: m.policy }));

import {
  finalWeightReconciliationRemediationPriorEvidence,
  isEligibleFinalWeightReconciliationVerifierDefectReceipt,
  verifyFinalWeightReconciliationRemediationWriteAccess,
} from "./financialFinalWeightReconciliationRemediationDb";
import { buildFinalWeightAdjustment, FINAL_WEIGHT_RULES_VERSION, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { FINAL_WEIGHT_RECONCILIATION_VERIFIER_DEFECT_HOLD_REASON, FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON, finalWeightReconciliationOriginalHash } from "./financialFinalWeightReconciliationOrigin";
import { financialSha256, sourceSnapshotHash } from "./financialProposalIntegrity";
import { facts, invoice, policy, xero } from "./_test/finalWeightFixtures";

function d702941XeroEvidence() {
  const exactInvoice = invoice({ InvoiceNumber: "INV-702941" });
  return xero({ exactMatches: [exactInvoice], invoice: exactInvoice, contact: { count: 1, contactId: "customer-exact", partyName: "Kyle Ram" } });
}

function reconciliationReceipt(patch: Record<string, unknown> = {}) {
  const source = facts({ dealId: "5x941", dealNumber: "D702941", customerName: "Kyle Ram 1" });
  const currentXero = d702941XeroEvidence();
  const preview = buildFinalWeightAdjustment(source, "overweight", currentXero);
  const payload = prepareFinalWeightPayload(preview, sourceSnapshotHash({ ...source, direction: "overweight", rulesVersion: FINAL_WEIGHT_RULES_VERSION }));
  return {
    id: 1, originalEventId: 660001, recoveryKey: "prior-key", direction: "overweight", dealId: source.dealId, dealNumber: source.dealNumber,
    invoiceNumber: preview.invoiceNumber, xeroInvoiceId: preview.invoiceId, originalEventHash: "original-hash", sourceSnapshotHash: sourceSnapshotHash({ ...source, direction: "overweight", rulesVersion: FINAL_WEIGHT_RULES_VERSION }),
    xeroPreflightHash: financialSha256(currentXero), sourceSnapshot: source, xeroPreflight: currentXero, originalDraft: preview.originalDraft,
    expectedDraft: preview.expectedDraft, originalDraftHash: financialSha256(preview.originalDraft), expectedDraftHash: financialSha256(preview.expectedDraft),
    releaseKey: policy().releaseKey, authorisedPayload: { hash: financialSha256(payload), payload }, processingToken: null,
    status: "reconciliation_required", holdReason: FINAL_WEIGHT_RECONCILIATION_VERIFIER_DEFECT_HOLD_REASON, executionId: null, submittedAt: null,
    readbackEvidence: null, createdAt: new Date("2026-10-12T00:00:00Z"), updatedAt: new Date("2026-10-12T00:00:00Z"), ...patch,
  };
}
function fixture() {
  const original = { id: 660001, status: "reconciliation_required", holdReason: FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON, executionId: null,
    invoiceNumber: "INV-702941", xeroInvoiceId: "invoice-exact", sourceSnapshotHash: "", rulesSnapshotHash: "", xeroPreflightHash: null,
    sourceSnapshot: {}, xeroPreflight: {}, originalDraft: {}, expectedDraft: {}, originalDraftHash: "old", expectedDraftHash: "expected", direction: "overweight", dealId: "5x941" };
  const originalEventHash = finalWeightReconciliationOriginalHash(original);
  const prior = reconciliationReceipt({ originalEventHash });
  const evidence = finalWeightReconciliationRemediationPriorEvidence(prior as any);
  const payload = (prior.authorisedPayload as any).payload;
  const event = {
    id: 2, priorReconciliationEventId: 1, remediationKey: "remediation-key", priorReceiptHash: financialSha256(evidence), priorReceiptEvidence: evidence,
    originalEventId: 660001, direction: "overweight", dealId: prior.dealId, dealNumber: prior.dealNumber, invoiceNumber: prior.invoiceNumber,
    xeroInvoiceId: prior.xeroInvoiceId, originalEventHash: "original-hash", sourceSnapshotHash: prior.sourceSnapshotHash,
    xeroPreflightHash: prior.xeroPreflightHash, sourceSnapshot: prior.sourceSnapshot, xeroPreflight: prior.xeroPreflight,
    originalDraft: prior.originalDraft, expectedDraft: prior.expectedDraft, originalDraftHash: prior.originalDraftHash, expectedDraftHash: prior.expectedDraftHash,
    releaseKey: policy().releaseKey, authorisedPayload: { hash: financialSha256(payload), payload }, processingToken: "token", status: "reserved",
    holdReason: null, executionId: null, submittedAt: null, readbackEvidence: null,
  };
  event.originalEventHash = originalEventHash;
  return { prior, event, original, payload, input: { eventId: 2, token: "token", releaseKey: policy().releaseKey, preparedBy: 7, payload } };
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); vi.stubEnv("FINANCIAL_FINAL_WEIGHT_RECONCILIATION_ENABLED", "true");
  const current = fixture(); m.rows = [current.event, current.prior, current.original];
  m.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [m.rows.shift()] }) }) }));
  m.insert.mockImplementation(() => ({ values: m.values })); m.update.mockImplementation(() => ({ set: m.set })); m.set.mockImplementation(() => ({ where: m.where })); m.where.mockResolvedValue([{ affectedRows: 1 }]);
  m.db.mockResolvedValue({ select: m.select, insert: m.insert, update: m.update }); m.source.mockResolvedValue(facts({ dealId: "5x941", dealNumber: "D702941", customerName: "Kyle Ram 1" }));
  m.xero.mockResolvedValue(d702941XeroEvidence()); m.policy.mockResolvedValue(policy());
});
afterEach(() => vi.unstubAllEnvs());

describe("Final Weight verifier-defect remediation ledger", () => {
  it.each([
    { holdReason: "operator hold" }, { holdReason: `${FINAL_WEIGHT_RECONCILIATION_VERIFIER_DEFECT_HOLD_REASON} more` }, { executionId: 3 }, { submittedAt: new Date() }, { processingToken: "token" }, { authorisedPayload: null },
  ])("rejects an arbitrary, submitted, executed, or noncanonical receipt %#", patch => {
    expect(isEligibleFinalWeightReconciliationVerifierDefectReceipt(reconciliationReceipt(patch) as any)).toBe(false);
  });

  it("accepts only the exact no-execution receipt and preserves every prior evidence field for separate audit", () => {
    const prior = reconciliationReceipt(); const copy = finalWeightReconciliationRemediationPriorEvidence(prior as any);
    expect(isEligibleFinalWeightReconciliationVerifierDefectReceipt(prior as any)).toBe(true);
    expect(copy).toMatchObject({ id: 1, originalEventId: 660001, holdReason: FINAL_WEIGHT_RECONCILIATION_VERIFIER_DEFECT_HOLD_REASON, executionId: null, submittedAt: null, xeroPreflight: prior.xeroPreflight, authorisedPayload: prior.authorisedPayload });
  });

  it("revalidates source/Xero using authoritative existing Draft ContactID, not current renamed VTiger customer matching", async () => {
    const current = fixture();
    await verifyFinalWeightReconciliationRemediationWriteAccess(current.input);
    expect(m.xero).toHaveBeenCalledWith("INV-702941", "Kyle Ram 1", "overweight", { skipCustomerMatch: true });
  });

  it("refuses a changed or mismatched prior receipt before any Xero read", async () => {
    const current = fixture(); (current.prior as any).executionId = 9;
    m.rows = [current.event, current.prior, current.original];
    await expect(verifyFinalWeightReconciliationRemediationWriteAccess(current.input)).rejects.toThrow(/exact no-execution verifier-defect receipt/);
    expect(m.xero).not.toHaveBeenCalled();
  });
});
