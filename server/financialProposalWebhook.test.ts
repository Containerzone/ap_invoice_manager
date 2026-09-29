import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./financialProposalWebhookService", () => ({
  evaluateFinancialWebhookProposal: vi.fn().mockResolvedValue({
    status: "proposed",
    route: { key: "main-customer-invoice", workflowType: "main_customer_invoice", displayName: "Main customer invoice" },
    envelope: { eventId: "evt-1", sourceEntityType: "deal", sourceRecordId: "4x1" },
    workflowRunId: 81,
    issueCount: 0,
    proposedDocuments: [{ documentNumber: "INV-1", documentType: "main_invoice", action: "create_draft", total: 100, gstTreatment: "GST on Income", validationStatus: "passed" }],
    safeSummary: { financialWritePermitted: false },
  }),
  financialWebhookPayloadFingerprint: vi.fn().mockReturnValue("fingerprint"),
}));

vi.mock("./financialWebhookEventDb", () => ({
  createFinancialWebhookEvent: vi.fn().mockResolvedValue({ event: { workflowRunId: 81 }, duplicate: false }),
  getFinancialWebhookEventByEventId: vi.fn().mockResolvedValue(undefined),
  updateFinancialWebhookEventOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./financialLiveExecutionService", () => ({
  executeApprovedFinancialDraft: vi.fn(),
}));

vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: vi.fn() }));

type Handler = (req: any, res: any) => Promise<void>;

function response() {
  const body: { status?: number; payload?: unknown } = {};
  return {
    status: (status: number) => {
      body.status = status;
      return { json: (payload: unknown) => { body.payload = payload; } };
    },
    body,
  };
}

const payload = {
  apiVersion: "2026-09-29",
  mode: "proposal",
  eventId: "evt-1",
  eventType: "deal.updated",
  sourceSystem: "VTiger",
  sourceEntityType: "deal",
  sourceRecordId: "4x1",
  data: { customerOrganisationName: "Example Customer" },
};

describe("AP financial proposal webhook", () => {
  let handler: Handler;

  beforeEach(async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "proposal-secret");
    vi.clearAllMocks();
    const { registerFinancialProposalWebhook } = await import("./financialProposalWebhook");
    const handlers = new Map<string, Handler>();
    registerFinancialProposalWebhook({ post: (path: string, route: Handler) => { handlers.set(path, route); } } as any);
    handler = handlers.get("/api/financial-workflows/events/main-customer-invoice")!;
  });

  afterEach(() => vi.unstubAllEnvs());

  it("registers a fixed path for each AP proposal family", async () => {
    const { getFinancialProposalWebhookStatus } = await import("./financialProposalWebhook");
    expect(getFinancialProposalWebhookStatus()).toMatchObject({ configured: true, financialWritePermitted: false, schedulesRegistered: false });
    expect(getFinancialProposalWebhookStatus().routes).toHaveLength(12);
  });

  it("rejects an event without the AP secret", async () => {
    const res = response();
    await handler({ header: () => "wrong", body: payload }, res);
    expect(res.body).toEqual({ status: 401, payload: { error: "Unauthorized AP financial webhook event." } });
  });

  it("records a proposal result without a Xero write or schedule change", async () => {
    const { executeApprovedFinancialDraft } = await import("./financialLiveExecutionService");
    const res = response();
    await handler({ header: () => "proposal-secret", body: payload }, res);
    expect(res.body).toEqual({
      status: 201,
      payload: expect.objectContaining({
        accepted: true,
        mode: "proposal_only",
        financialWritePermitted: false,
        xeroWriteMethodsCalled: [],
        schedulesRegistered: false,
        sourceSystemsChanged: false,
        routeKey: "main-customer-invoice",
        workflowRunId: 81,
      }),
    });
    expect(executeApprovedFinancialDraft).not.toHaveBeenCalled();
  });

  it("holds a non-dry event before Xero when the guarded execution gate is disabled", async () => {
    const { executeApprovedFinancialDraft } = await import("./financialLiveExecutionService");
    const { FinancialWriteDisabledError } = await import("./financialProductionWriter");
    const { updateFinancialWebhookEventOutcome } = await import("./financialWebhookEventDb");
    vi.mocked(executeApprovedFinancialDraft).mockRejectedValueOnce(new FinancialWriteDisabledError("the FINANCIAL_LIVE_WRITES_ENABLED deployment lock is not enabled"));
    const res = response();
    await handler({
      header: () => "proposal-secret",
      body: { ...payload, eventId: "evt-execution-held", mode: undefined, dryRun: false, executionApprovalId: 71 },
    }, res);
    expect(res.body).toEqual({
      status: 202,
      payload: expect.objectContaining({ mode: "held", status: "held", financialWritePermitted: false, xeroWriteMethodsCalled: [] }),
    });
    expect(executeApprovedFinancialDraft).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: 71,
      expectedWorkflowType: "main_customer_invoice",
      expectedSourceRecordId: "4x1",
    }));
    expect(updateFinancialWebhookEventOutcome).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-execution-held", status: "held" }));
  });

  it("records and alerts a held event when non-dry execution has no document-specific approval", async () => {
    const { executeApprovedFinancialDraft } = await import("./financialLiveExecutionService");
    const { updateFinancialWebhookEventOutcome } = await import("./financialWebhookEventDb");
    const res = response();
    await handler({
      header: () => "proposal-secret",
      body: { ...payload, eventId: "evt-missing-approval", mode: undefined, dryRun: false },
    }, res);
    expect(res.body).toEqual({
      status: 202,
      payload: expect.objectContaining({ mode: "held", status: "held", financialWritePermitted: false }),
    });
    expect(executeApprovedFinancialDraft).not.toHaveBeenCalled();
    expect(updateFinancialWebhookEventOutcome).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "evt-missing-approval",
      status: "held",
      errorMessage: expect.stringContaining("did not name an exact"),
    }));
  });

  it("can report a verified guarded Draft execution without exposing a browser or tRPC writer", async () => {
    const { executeApprovedFinancialDraft } = await import("./financialLiveExecutionService");
    vi.mocked(executeApprovedFinancialDraft).mockResolvedValueOnce({
      mode: "active_execution",
      approvalId: 71,
      outcome: { outcome: "succeeded", executionId: 501, result: { xeroDocumentId: "xero-501" } },
      postSuccess: { attempted: true, actionId: 91, outcome: "succeeded" },
    } as any);
    const res = response();
    await handler({
      header: () => "proposal-secret",
      body: { ...payload, eventId: "evt-execution-success", mode: undefined, dryRun: false, executionApprovalId: 71 },
    }, res);
    expect(res.body).toEqual({
      status: 200,
      payload: expect.objectContaining({
        mode: "draft_execution",
        status: "succeeded",
        execution: expect.objectContaining({ executionId: 501, postSuccess: "succeeded" }),
      }),
    });
  });

  it("returns an idempotent duplicate response before re-evaluation", async () => {
    const { getFinancialWebhookEventByEventId } = await import("./financialWebhookEventDb");
    vi.mocked(getFinancialWebhookEventByEventId).mockResolvedValueOnce({ workflowRunId: 99 } as any);
    const res = response();
    await handler({ header: () => "proposal-secret", body: payload }, res);
    expect(res.body).toEqual({
      status: 200,
      payload: expect.objectContaining({ status: "duplicate", duplicate: true, workflowRunId: 99, financialWritePermitted: false }),
    });
  });
});
