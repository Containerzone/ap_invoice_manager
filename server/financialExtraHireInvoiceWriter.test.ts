import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  verify: vi.fn(),
  consume: vi.fn(),
  auth: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  request: vi.fn(),
  prepare: vi.fn(),
  submitted: vi.fn(),
  success: vi.fn(),
  failed: vi.fn(),
  queue: vi.fn(),
  readback: vi.fn(),
  getAction: vi.fn(),
  claimAction: vi.fn(),
}));
vi.mock("./financialExtraHireInvoiceDb", () => ({
  verifyExtraHireAutomaticWriteAccess: m.verify,
  consumeExtraHirePayload: m.consume,
}));
vi.mock("./xeroService", () => ({
  EXPECTED_AP_XERO_TENANT_LABEL: "CONTAINERZONE",
  getXeroReadAuthWithRefresh: m.auth,
}));
vi.mock("./xeroRequestManager", () => ({ runXeroRequest: m.request }));
vi.mock("axios", () => ({ default: { post: m.post, put: m.put } }));
vi.mock("./financialReadOnlyXeroService", () => ({
  readBackFinancialDraft: m.readback,
}));
vi.mock("./financialWorkflowDb", () => ({
  prepareFinancialWriterExecution: m.prepare,
  markFinancialWriterExecutionSubmitted: m.submitted,
  markFinancialWriterExecutionSucceeded: m.success,
  markFinancialWriterExecutionFailed: m.failed,
  createFinancialPostSuccessAction: m.queue,
  recordVerifiedStorageBillingExecution: vi.fn(),
  getFinancialPostSuccessActionById: m.getAction,
  claimFinancialPostSuccessAction: m.claimAction,
  getFinancialWorkflowConfig: vi.fn(),
}));
import {
  assertFinancialDraftWriteAuthorised,
  executeFinancialDraftWrite,
  prepareFinancialDraftPayload,
  type FinancialDraftPayload,
} from "./financialProductionWriter";
import { executeGuardedFinancialWriterCommand } from "./financialWriterExecutionService";
import { planFinancialPostSuccessActions } from "./financialPostSuccessPlan";
import { runFinancialPostSuccessAction } from "./vtigerFinancialWriteService";
import { buildExtraHireInvoice } from "./financialExtraHireInvoiceRules";
const context = () => ({
  workflowType: "extra_hire",
  approvalReference: "EXTRA-test",
  globalShadowMode: false,
  familyLiveEnabled: true,
  releaseManifestApproved: true,
  cutoverPackApproved: true,
  currentDocumentPreflightPassed: true,
  legacyWriterHandoffComplete: true,
  extraHireAutomaticEventId: 41,
  extraHireReleaseKey: "EXTRA-test",
  extraHireApprovedBy: 7,
});
const document = () => {
  const d = buildExtraHireInvoice(
    {
      dealId: "5x77",
      dealNumber: "D77",
      containerNumber: "ABCU1234567",
      containerType: "20 Foot Standard",
      containerFeet: 20,
      hireDuration: 30,
      hireEndDate: "2026-01-31",
      customerVtigerId: "3x88",
      customerName: "Synthetic",
      customerKind: "organisation",
      sourceRefreshedAt: "2026-01-01",
      customerRefreshedAt: null,
      mappingEvidence: {},
      sourceHoldReason: null,
    },
    "INV-77-EH1",
    {
      itemCode: "20' Hire",
      unitAmount: 45,
      accountCode: "210",
      taxType: "OUTPUT",
    },
    "CURRENT_HIRE_END_DATE_NO_DUE_DATE"
  ).document!;
  d.partySourceId = "contact-1";
  return d;
};
const payload = (): FinancialDraftPayload => {
  const p = prepareFinancialDraftPayload(document(), "synthetic");
  (p.body.Invoices as any[])[0].CurrencyCode = "AUD";
  return p;
};
const command = () => ({
  workflowType: "extra_hire",
  proposedAction: "create_draft" as const,
  payload: payload(),
  authorisation: context(),
  preparedBy: 7,
  expectedDraftDocument: document(),
});
beforeEach(() => {
  vi.clearAllMocks();
  m.verify.mockReset().mockResolvedValue(undefined);
  m.consume.mockReset().mockResolvedValue(undefined);
  m.auth.mockResolvedValue({ token: "synthetic", tenantId: "tenant" });
  m.request.mockImplementation(async (_auth, _op, fn) => fn());
  m.post.mockResolvedValue({
    data: {
      Invoices: [
        { InvoiceID: "xero-1", InvoiceNumber: "INV-77-EH1", Status: "DRAFT" },
      ],
    },
  });
  m.prepare.mockResolvedValue({ duplicate: false, execution: { id: 11 } });
  m.readback
    .mockReset()
    .mockResolvedValue({
      xeroDocumentId: "xero-1",
      documentNumber: "INV-77-EH1",
      status: "DRAFT",
    });
});
afterEach(() => vi.unstubAllEnvs());
describe("Extra Hire isolated writer contract", () => {
  it("never inherits global, storage, Deposit or Main gates", () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    expect(() =>
      assertFinancialDraftWriteAuthorised(context(), {
        requireExecutionId: false,
      })
    ).toThrow(/Extra Hire independent/);
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    expect(() =>
      assertFinancialDraftWriteAuthorised(context(), {
        requireExecutionId: false,
      })
    ).not.toThrow();
    expect(() =>
      assertFinancialDraftWriteAuthorised(
        { ...context(), depositInvoiceAutomaticEventId: 3 },
        { requireExecutionId: false }
      )
    ).toThrow(/Extra Hire independent/);
    expect(() =>
      assertFinancialDraftWriteAuthorised(
        { ...context(), workflowType: "asset_purchase" },
        { requireExecutionId: false }
      )
    ).toThrow(/Extra Hire independent/);
    expect(() => assertFinancialDraftWriteAuthorised(context())).toThrow(
      /execution ledger/
    );
  });
  it("bare generic extra_hire is blocked even if global writer is armed", () => {
    vi.stubEnv("FINANCIAL_LIVE_WRITES_ENABLED", "true");
    const {
      extraHireAutomaticEventId,
      extraHireReleaseKey,
      extraHireApprovedBy,
      ...generic
    } = context();
    expect(() =>
      assertFinancialDraftWriteAuthorised(generic, {
        requireExecutionId: false,
      })
    ).toThrow(/Extra Hire independent/);
  });
  it.each([
    { method: "PUT" },
    { endpoint: "/PurchaseOrders" },
    { documentFamily: "purchase_order" },
    { documentNumber: "INV-77-D" },
    { expectedXeroDocumentId: "existing" },
  ])("rejects forbidden payload %j before auth/transport", async patch => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    await expect(
      executeFinancialDraftWrite({ ...payload(), ...patch } as any, {
        ...context(),
        executionId: 11,
      })
    ).rejects.toThrow(/Extra Hire permits/);
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();
  });
  it.each([
    { Status: "AUTHORISED" },
    { Type: "ACCPAY" },
    { CurrencyCode: "USD" },
    { LineAmountTypes: "Inclusive" },
    { DueDate: "2026-03-01" },
    { InvoiceNumber: "INV-77" },
    { LineItems: [] },
    {
      LineItems: [
        {
          ItemCode: "20' Hire",
          Quantity: 30,
          UnitAmount: 45,
          TaxType: "OUTPUT",
          AccountCode: "210",
        },
      ],
    },
  ])("rejects forbidden row %j", async patch => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    const p = payload();
    p.body.Invoices = [{ ...(p.body.Invoices as any[])[0], ...patch }];
    await expect(
      executeFinancialDraftWrite(p, { ...context(), executionId: 11 })
    ).rejects.toThrow(/Extra Hire permits/);
    expect(m.auth).not.toHaveBeenCalled();
  });
  it("verifies and atomically consumes once before transport with transient retry disabled", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    await expect(
      executeFinancialDraftWrite(payload(), { ...context(), executionId: 11 })
    ).resolves.toMatchObject({ status: "DRAFT", xeroDocumentId: "xero-1" });
    expect(m.verify).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 41, preparedBy: 7 })
    );
    expect(m.consume).toHaveBeenCalledWith(41, 11);
    expect(m.consume.mock.invocationCallOrder[0]).toBeLessThan(
      m.auth.mock.invocationCallOrder[0]
    );
    expect(m.request.mock.calls[0][3]).toEqual({
      retryTransientGatewayFailures: false,
    });
    expect(m.post).toHaveBeenCalledTimes(1);
    expect(m.put).not.toHaveBeenCalled();
  });
  it("lost/consumed immutable claim blocks transport even with dedicated flag", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.consume.mockRejectedValue(new Error("Already submitted"));
    await expect(
      executeFinancialDraftWrite(payload(), { ...context(), executionId: 11 })
    ).rejects.toThrow(/Already submitted/);
    expect(m.post).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
  });
  it("success is recorded only after exact readback; no CRM queue", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    expect(
      (await executeGuardedFinancialWriterCommand(command())).outcome
    ).toBe("succeeded");
    expect(m.success.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.readback.mock.invocationCallOrder[0]
    );
    expect(m.queue).not.toHaveBeenCalled();
  });
  it("readback mismatch requires reconciliation and never queues CRM", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    m.readback.mockRejectedValue(new Error("Exact totals mismatch"));
    expect(
      (await executeGuardedFinancialWriterCommand(command())).outcome
    ).toBe("reconciliation_required");
    expect(m.success).not.toHaveBeenCalled();
    expect(m.queue).not.toHaveBeenCalled();
  });
  it("forged future post-success plan is rejected before any execution ledger work even if all CRM flags true", async () => {
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED", "true");
    vi.stubEnv("FINANCIAL_VTIGER_POST_SUCCESS_ENABLED", "true");
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_POST_SUCCESS_ENABLED", "true");
    await expect(
      executeGuardedFinancialWriterCommand({
        ...command(),
        sourceRecordId: "5x77",
        postSuccessPlan: [
          {
            actionType: "vtiger_hire_end_update",
            safePayloadSummary: { nextHireEndDate: "2026-03-02" },
          },
        ],
      })
    ).rejects.toThrow(/CRM post-success/);
    expect(m.prepare).not.toHaveBeenCalled();
    expect(m.queue).not.toHaveBeenCalled();
  });
  it("global/storage post-success never plans Extra Hire without dedicated gate", () => {
    vi.stubEnv("FINANCIAL_VTIGER_POST_SUCCESS_ENABLED", "true");
    vi.stubEnv("FINANCIAL_EXTRA_HIRE_POST_SUCCESS_ENABLED", "");
    expect(
      planFinancialPostSuccessActions({
        workflowType: "extra_hire",
        document: document(),
        sourceData: { hireEndDate: "2026-01-31" },
      })
    ).toEqual([]);
  });
  it.each(["", "true"])(
    "legacy queued hire-end actions stay held and unclaimed with dedicated flag %s",
    async flag => {
      vi.stubEnv("FINANCIAL_VTIGER_POST_SUCCESS_ENABLED", "true");
      vi.stubEnv("FINANCIAL_EXTRA_HIRE_POST_SUCCESS_ENABLED", flag);
      m.getAction.mockResolvedValue({
        id: 1,
        status: "pending",
        workflowType: "extra_hire",
        actionType: "vtiger_hire_end_update",
      });
      expect((await runFinancialPostSuccessAction(1)).outcome).toBe("failed");
      expect(m.claimAction).not.toHaveBeenCalled();
      expect(m.post).not.toHaveBeenCalled();
    }
  );
});
