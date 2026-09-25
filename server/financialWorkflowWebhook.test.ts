import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./financialWorkflowService", () => ({
  evaluateAndPersistFinancialWorkflow: vi.fn().mockResolvedValue({
    evaluation: { outcome: "warning", intents: [{ proposedDocumentNumber: "INV-1" }], issues: [{ code: "MISSING", severity: "warning" }] },
    persistence: { runId: 9, duplicate: false },
  }),
}));

type Handler = (req: any, res: any) => Promise<void>;

function response() {
  const body: { status?: number; payload?: unknown } = {};
  return {
    status: (status: number) => { body.status = status; return { json: (payload: unknown) => { body.payload = payload; } }; },
    body,
  };
}

describe("financial workflow shadow webhook", () => {
  let handler: Handler;

  beforeEach(async () => {
    vi.stubEnv("FINANCIAL_SHADOW_WEBHOOK_SECRET", "test-secret");
    const { registerFinancialWorkflowShadowWebhook } = await import("./financialWorkflowWebhook");
    registerFinancialWorkflowShadowWebhook({ post: (_path: string, route: Handler) => { handler = route; } } as any);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects unauthenticated external payloads", async () => {
    const res = response();
    await handler({ header: () => "wrong", body: {} }, res);
    expect(res.body).toEqual({ status: 401, payload: { error: "Unauthorized shadow event" } });
  });

  it("accepts only explicit shadow payloads and returns no-write result metadata", async () => {
    const res = response();
    await handler({
      header: () => "test-secret",
      body: { mode: "shadow", workflowType: "main_customer_invoice", sourceRecordId: "deal-1", sourceData: { customerOrganisationName: "Customer" }, eventId: "evt-1" },
    }, res);
    expect(res.body).toEqual({
      status: 201,
      payload: { mode: "shadow", xeroWritePermitted: false, runId: 9, duplicate: false, outcome: "warning", proposedDocumentNumbers: ["INV-1"], issueCount: 1 },
    });
  });

  it("refuses payloads that attempt a live mode", async () => {
    const res = response();
    await handler({ header: () => "test-secret", body: { mode: "live", workflowType: "main_customer_invoice", sourceData: {} } }, res);
    expect(res.body).toEqual({ status: 400, payload: { error: "workflowType and mode=shadow are required" } });
  });
});
