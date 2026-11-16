import { describe, expect, it, vi } from "vitest";
const candidateLookup = vi.hoisted(() => ({ find: vi.fn() }));
const initialProcessor = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock("./vtigerFinancialCandidateService", () => ({ findExactFinancialCandidate: candidateLookup.find }));
vi.mock("./financialForHireLiveService", () => ({ processAutomaticInitialForHire: initialProcessor.process }));

import { disabledForHireWebhookHandler, parseForHireWebhookEnvelope, registerForHireWebhook, resolveForHireRecordId } from "./financialForHireWebhook";

describe("dormant For Hire webhook contract", () => {
  it("accepts only an exact VTiger Container Control ID or record_id", () => {
    expect(parseForHireWebhookEnvelope({ record_id: "24x901", event: "container-control.request" })).toEqual({ recordId: "24x901", event: "container-control.request" });
    expect(parseForHireWebhookEnvelope({ id: "24x901" })).toEqual({ recordId: "24x901", event: null });
    expect(parseForHireWebhookEnvelope({ id: "C1860" })).toEqual({ recordId: "C1860", event: null });
    expect(() => parseForHireWebhookEnvelope({ id: "D702930" })).toThrow(/requires an exact VTiger/i);
  });

  it("resolves a VTiger C-number through one exact read-only candidate lookup", async () => {
    candidateLookup.find.mockResolvedValueOnce({
      outcome: "found",
      sourceCategory: "container_control",
      businessNumber: "C1912",
      candidates: [{ recordId: "5x489278" }],
      message: "Exact VTiger candidate found",
    });
    await expect(resolveForHireRecordId("C1912")).resolves.toBe("5x489278");
    expect(candidateLookup.find).toHaveBeenCalledWith({ sourceCategory: "container_control", businessNumber: "C1912" });
  });

  it("remains a 503 no-write stub even with a valid secret", async () => {
    const previous = process.env.FINANCIAL_AP_WEBHOOK_SECRET;
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await disabledForHireWebhookHandler({ header: (name: string) => name === "x-financial-webhook-secret" ? "test-secret" : undefined, body: { id: "24x901" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "for-hire-route-not-activated", xeroWritesAttempted: 0 }));
    if (previous === undefined) delete process.env.FINANCIAL_AP_WEBHOOK_SECRET; else process.env.FINANCIAL_AP_WEBHOOK_SECRET = previous;
  });

  it("mounts the protected future route but returns a non-writing hold while the For Hire gate is off", async () => {
    const previousSecret = process.env.FINANCIAL_AP_WEBHOOK_SECRET;
    const previousGate = process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED;
    process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
    delete process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED;
    const handlers = new Map<string, any>();
    registerForHireWebhook({ post: (path: string, handler: any) => handlers.set(path, handler) } as any);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handlers.get("/api/webhooks/vtiger/container-control-for-hire")({ header: () => "test-secret", body: { id: "24x901" } }, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "for-hire-release-disabled", xeroWritesAttempted: 0 }));
    if (previousSecret === undefined) delete process.env.FINANCIAL_AP_WEBHOOK_SECRET; else process.env.FINANCIAL_AP_WEBHOOK_SECRET = previousSecret;
    if (previousGate === undefined) delete process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED; else process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED = previousGate;
  });

  it("forwards only server-issued authenticated initial provenance and ignores forged JSON origin/cutover/time", async () => {
    const previousSecret = process.env.FINANCIAL_AP_WEBHOOK_SECRET;
    const previousGate = process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED;
    try {
      process.env.FINANCIAL_AP_WEBHOOK_SECRET = "test-secret";
      process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED = "true";
      initialProcessor.process.mockReset().mockResolvedValue({ ok: true, status: "drafts_created", xeroWritesAttempted: 1 });
      const handlers = new Map<string, any>();
      registerForHireWebhook({ post: (path: string, handler: any) => handlers.set(path, handler) } as any);
      const before = Date.now();
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
      await handlers.get("/api/webhooks/vtiger/container-control-for-hire")({
        header: (name: string) => name === "x-financial-webhook-secret" ? "test-secret" : undefined,
        body: { id: "79x9000", origin: "manual", receivedAt: "2099-01-01T00:00:00Z", recurringFutureInitialsEnabled: true, cutoff: "2000-01-01" },
      }, res);
      expect(initialProcessor.process).toHaveBeenCalledTimes(1);
      const [recordId, context] = initialProcessor.process.mock.calls[0];
      expect(recordId).toBe("79x9000");
      expect(context.origin).toBe("authenticated_initial_for_hire_webhook");
      expect(context.receivedAt).toBeInstanceOf(Date);
      expect(context.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(context.receivedAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(Object.keys(context).sort()).toEqual(["origin", "receivedAt"]);
      expect(res.status).toHaveBeenCalledWith(200);
    } finally {
      if (previousSecret === undefined) delete process.env.FINANCIAL_AP_WEBHOOK_SECRET; else process.env.FINANCIAL_AP_WEBHOOK_SECRET = previousSecret;
      if (previousGate === undefined) delete process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED; else process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED = previousGate;
    }
  });

  it("never forwards provenance for unauthenticated requests even with forged trusted fields", async () => {
    initialProcessor.process.mockClear();
    const handlers = new Map<string, any>();
    registerForHireWebhook({ post: (path: string, handler: any) => handlers.set(path, handler) } as any);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    await handlers.get("/api/webhooks/vtiger/container-control-for-hire")({
      header: () => undefined, body: { id: "79x9000", origin: "authenticated_initial_for_hire_webhook" },
    }, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(initialProcessor.process).not.toHaveBeenCalled();
  });
});
