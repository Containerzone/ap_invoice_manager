import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./financialInitialStorageService", () => ({ processInitialLoadedStorage: vi.fn() }));
vi.mock("./financialStorageLifecycleService", () => ({ processAutomaticInitialStorage: vi.fn(), processStorageFinalisation: vi.fn() }));
vi.mock("./workflowAlertService", () => ({ reportWorkflowFailureSafely: vi.fn() }));

type Handler = (req: any, res: any) => Promise<any>;
function response() {
  const body: { status?: number; payload?: any } = {};
  const res = { status: (code: number) => { body.status = code; return res; }, json: (payload: any) => { body.payload = payload; return res; } };
  return { body, res };
}

describe("narrow VTiger Deal storage webhook", () => {
  let handler: Handler;
  let finalHandler: Handler;
  beforeEach(async () => {
    vi.stubEnv("FINANCIAL_AP_WEBHOOK_SECRET", "test-storage-secret");
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "false");
    vi.clearAllMocks();
    const handlers = new Map<string, Handler>();
    const { registerInitialLoadedStorageWebhook, INITIAL_STORAGE_WEBHOOK_PATH } = await import("./financialInitialStorageWebhook");
    registerInitialLoadedStorageWebhook({ post: (path: string, fn: Handler) => { handlers.set(path, fn); } } as any);
    handler = handlers.get(INITIAL_STORAGE_WEBHOOK_PATH)!;
    finalHandler = handlers.get("/api/webhooks/vtiger/deal-storage-finalise")!;
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
  it("uses the isolated automatic policy path only when its environment gate is armed", async () => {
    vi.stubEnv("FINANCIAL_STORAGE_AUTOMATIC_ENABLED", "true");
    const lifecycle = await import("./financialStorageLifecycleService");
    vi.mocked(lifecycle.processAutomaticInitialStorage).mockResolvedValueOnce({ ok: true, status: "drafts_created", eventId: 7, documents: [] });
    const { res, body } = response();
    await handler({ header: () => "test-storage-secret", body: { event: "deal.storage-stage-changed", record_id: "5x123" } }, res);
    expect(body.status).toBe(200);
    expect(lifecycle.processAutomaticInitialStorage).toHaveBeenCalledWith("5x123");
    expect((await import("./financialInitialStorageService")).processInitialLoadedStorage).not.toHaveBeenCalled();
  });
  it("requires authentication and explicit storage location for finalisation", async () => {
    const lifecycle = await import("./financialStorageLifecycleService");
    const first = response();
    await finalHandler({ header: () => "invalid", body: {} }, first.res);
    expect(first.body.status).toBe(401);
    const second = response();
    await finalHandler({ header: () => "test-storage-secret", body: { record_id: "5x123", event: "deal.storage-finalised" } }, second.res);
    expect(second.body.status).toBe(400);
    expect(lifecycle.processStorageFinalisation).not.toHaveBeenCalled();
  });
  it("forwards only the exact record/location and holds rejected release without exposing upstream data", async () => {
    const lifecycle = await import("./financialStorageLifecycleService");
    vi.mocked(lifecycle.processStorageFinalisation).mockRejectedValueOnce(new Error("secret upstream details"));
    const { res, body } = response();
    await finalHandler({ header: () => "test-storage-secret", body: { record_id: "5x123", event: "deal.storage-finalised", storageLocation: "origin", amount: 9999 } }, res);
    expect(body.status).toBe(202);
    expect(lifecycle.processStorageFinalisation).toHaveBeenCalledWith("5x123", "origin");
    expect(JSON.stringify(body.payload)).not.toContain("secret upstream");
  });
});
