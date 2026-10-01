import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./financialInitialStorageService", () => ({ processInitialLoadedStorage: vi.fn() }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: vi.fn() }));

type Handler = (req: any, res: any) => Promise<any>;
function response() {
  const body: { status?: number; payload?: any } = {};
  const res = { status: (code: number) => { body.status = code; return res; }, json: (payload: any) => { body.payload = payload; return res; } };
  return { body, res };
}

describe("narrow VTiger Deal storage webhook", () => {
  let handler: Handler;
  beforeEach(async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "test-storage-secret");
    vi.clearAllMocks();
    const handlers = new Map<string, Handler>();
    const { registerInitialLoadedStorageWebhook, INITIAL_STORAGE_WEBHOOK_PATH } = await import("./financialInitialStorageWebhook");
    registerInitialLoadedStorageWebhook({ post: (path: string, fn: Handler) => { handlers.set(path, fn); } } as any);
    handler = handlers.get(INITIAL_STORAGE_WEBHOOK_PATH)!;
    expect(INITIAL_STORAGE_WEBHOOK_PATH).toBe("/api/webhooks/vtiger/deal-storage");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("rejects missing/incorrect secrets before a VTiger read", async () => {
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    for (const secret of ["", "bad-secret"]) {
      const { body, res } = response();
      await handler({ header: () => secret, body: { event: "deal.storage-stage-changed", record_id: "5x123" } }, res);
      expect(body.status).toBe(401);
    }
    expect(processInitialLoadedStorage).not.toHaveBeenCalled();
  });
  it("requires the exact minimal event and record_id", async () => {
    const { body, res } = response();
    await handler({ header: () => "test-storage-secret", body: { event: "deal.updated", record_id: "5x123" } }, res);
    expect(body.status).toBe(400);
  });
  it("reports a safely held Deal without calling any Xero writer itself", async () => {
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    vi.mocked(processInitialLoadedStorage).mockResolvedValueOnce({ ok: false, status: "held", dealNumber: "D123", location: "origin", warning: "Exact pilot approval required." });
    const { body, res } = response();
    await handler({ header: () => "test-storage-secret", body: { event: "deal.storage-stage-changed", record_id: "5x123" } }, res);
    expect(body).toMatchObject({ status: 202, payload: { ok: false, status: "held" } });
    expect(processInitialLoadedStorage).toHaveBeenCalledWith("5x123");
  });
  it("reports verified Draft receipt success", async () => {
    const { processInitialLoadedStorage } = await import("./financialInitialStorageService");
    vi.mocked(processInitialLoadedStorage).mockResolvedValueOnce({ ok: true, status: "drafts_created", dealNumber: "D123", location: "destination", customerInvoice: "INV-123-B", transportPurchaseOrder: "JD123-B", storagePurchaseOrder: "GD123-B" });
    const { body, res } = response();
    await handler({ header: () => "test-storage-secret", body: { event: "deal.storage-stage-changed", record_id: "5x123" } }, res);
    expect(body).toMatchObject({ status: 200, payload: { customerInvoice: "INV-123-B", storagePurchaseOrder: "GD123-B" } });
  });
});
