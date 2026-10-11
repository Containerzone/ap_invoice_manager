import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ verify: vi.fn(), prepare: vi.fn(), submitted: vi.fn(), succeeded: vi.fn(), failed: vi.fn(), write: vi.fn(), readback: vi.fn(), crm: vi.fn() }));
vi.mock("./financialFinalWeightAdjustmentDb", () => ({ verifyFinalWeightAutomaticWriteAccess: m.verify }));
vi.mock("./financialProductionWriter", async original => ({ ...(await original<any>()), executeFinancialDraftWrite: m.write }));
vi.mock("./financialWorkflowDb", () => ({ prepareFinancialWriterExecution: m.prepare, markFinancialWriterExecutionSubmitted: m.submitted, markFinancialWriterExecutionSucceeded: m.succeeded, markFinancialWriterExecutionFailed: m.failed, createFinancialPostSuccessAction: m.crm }));
vi.mock("./financialReadOnlyXeroService", () => ({ readBackFinancialDraft: m.readback }));
import { executeGuardedFinancialWriterCommand, type GuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { buildFinalWeightAdjustment, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { facts, policy, xero } from "./_test/finalWeightFixtures";
function command(patch: Partial<GuardedFinancialWriterCommand> = {}): GuardedFinancialWriterCommand {
  const preview = buildFinalWeightAdjustment(facts(), "overweight", xero());
  return { workflowType: "final_weight_adjustment", proposedAction: "update_draft", payload: prepareFinalWeightPayload(preview, "source"), preparedBy: 7, expectedFinalWeightDraft: preview.expectedDraft!,
    authorisation: { workflowType: "final_weight_adjustment", approvalReference: policy().releaseKey, globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, finalWeightAutomaticEventId: 5, finalWeightDirection: "overweight", finalWeightReleaseKey: policy().releaseKey, finalWeightApprovedBy: 7 }, ...patch };
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", "true"); m.verify.mockResolvedValue(undefined); m.prepare.mockResolvedValue({ duplicate: false, execution: { id: 9 } }); m.write.mockResolvedValue({ xeroDocumentId: "invoice-exact", documentNumber: "INV-702877", status: "DRAFT" }); m.readback.mockResolvedValue({ xeroDocumentId: "invoice-exact", status: "DRAFT", lineCount: 2 }); });
afterEach(() => vi.unstubAllEnvs());
describe("Final-weight guarded Draft amendment coordinator", () => {
  it.each([{ workflowType: "main_customer_invoice" }, { proposedAction: "create_draft" }, { sourceRecordId: "5x77" }, { preparedBy: 8 }, { expectedFinalWeightDraft: undefined }, { expectedDraftDocument: {} }, { postSuccessPlan: [{}] }])("rejects unrelated family/create/CRM/expected-evidence command %# before execution ledger", async patch => {
    await expect(executeGuardedFinancialWriterCommand(command(patch as any))).rejects.toThrow(/Final-weight execution/);
    expect(m.prepare).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled(); expect(m.crm).not.toHaveBeenCalled();
  });
  it("requires expected readback payload equal exact ledger-authorised body", async () => {
    const input = command(); input.expectedFinalWeightDraft = { ...input.expectedFinalWeightDraft, DueDate: "2027-01-01" };
    await expect(executeGuardedFinancialWriterCommand(input)).rejects.toThrow(/Final-weight execution/); expect(m.prepare).not.toHaveBeenCalled();
  });
  it("revalidates before execution, then exact full-line readback before success without CRM writes", async () => {
    const input = command(); expect(await executeGuardedFinancialWriterCommand(input)).toMatchObject({ outcome: "succeeded", executionId: 9 });
    expect(m.verify.mock.invocationCallOrder[0]).toBeLessThan(m.prepare.mock.invocationCallOrder[0]!);
    expect(m.readback).toHaveBeenCalledWith(expect.objectContaining({ expectedXeroDocumentId: "invoice-exact", expectedFinalWeightDraft: input.expectedFinalWeightDraft }));
    expect(m.readback.mock.invocationCallOrder[0]).toBeLessThan(m.succeeded.mock.invocationCallOrder[0]!); expect(m.crm).not.toHaveBeenCalled();
  });
  it("duplicate execution never submits or transports again", async () => {
    m.prepare.mockResolvedValue({ duplicate: true, execution: { id: 9, status: "submitted", xeroDocumentId: null } });
    expect(await executeGuardedFinancialWriterCommand(command())).toMatchObject({ outcome: "duplicate" }); expect(m.submitted).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
  });
  it("readback failure after PUT requires reconciliation and never success/CRM", async () => {
    m.readback.mockRejectedValue(new Error("Retained line changed"));
    expect(await executeGuardedFinancialWriterCommand(command())).toMatchObject({ outcome: "reconciliation_required", error: "Retained line changed" });
    expect(m.failed).toHaveBeenCalledWith(9, expect.any(Error), true); expect(m.succeeded).not.toHaveBeenCalled(); expect(m.crm).not.toHaveBeenCalled();
  });
  it("uncertain 504 never retries or infers success", async () => {
    m.write.mockRejectedValue({ response: { status: 504 } }); expect(await executeGuardedFinancialWriterCommand(command())).toMatchObject({ outcome: "reconciliation_required" }); expect(m.write).toHaveBeenCalledTimes(1); expect(m.readback).not.toHaveBeenCalled(); expect(m.succeeded).not.toHaveBeenCalled();
  });
  it("disabled isolated flag rejects before any local execution state or transport", async () => {
    vi.stubEnv("FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED", ""); await expect(executeGuardedFinancialWriterCommand(command())).rejects.toThrow(/independent/); expect(m.prepare).not.toHaveBeenCalled(); expect(m.verify).not.toHaveBeenCalled();
  });
});
