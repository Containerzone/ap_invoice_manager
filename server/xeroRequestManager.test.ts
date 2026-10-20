import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReportWorkflowFailureSafely } = vi.hoisted(() => ({
  mockReportWorkflowFailureSafely: vi.fn(),
}));

vi.mock("./db", () => ({
  getXeroToken: vi.fn(),
  updateXeroRateLimitState: vi.fn(),
  getXeroApiCache: vi.fn(),
  setXeroApiCache: vi.fn(),
  invalidateXeroApiCache: vi.fn(),
}));
vi.mock("./workflowAlertService", () => ({
  reportWorkflowFailureSafely: mockReportWorkflowFailureSafely,
}));

import {
  getXeroApiCache,
  getXeroToken,
  setXeroApiCache,
  updateXeroRateLimitState,
} from "./db";
import { runBoundedXeroGet, runCachedXeroGet, runXeroRequest, XeroRateLimitError } from "./xeroRequestManager";

describe("central Xero request manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getXeroApiCache).mockResolvedValue(null);
    vi.mocked(setXeroApiCache).mockResolvedValue(undefined);
    vi.mocked(updateXeroRateLimitState).mockResolvedValue(undefined);
  });

  it("persists Xero's daily pause and remaining allowances from a 429 response", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({
      tenantId: "tenant-day-limit",
      rateLimitPausedUntil: null,
    } as any);
    const operation = vi.fn().mockRejectedValue({
      response: {
        status: 429,
        headers: {
          "x-rate-limit-problem": "day",
          "retry-after": "72000",
          "x-minlimit-remaining": "60",
          "x-daylimit-remaining": "0",
        },
      },
    });

    await expect(runXeroRequest(
      { token: "token", tenantId: "tenant-day-limit" },
      "test request",
      operation,
    )).rejects.toThrow("Xero daily request limit has been reached");

    expect(updateXeroRateLimitState).toHaveBeenCalledWith(
      "tenant-day-limit",
      expect.objectContaining({
        rateLimitProblem: "day",
        rateLimitRetryAfterSeconds: 72000,
        rateLimitMinuteRemaining: 60,
        rateLimitDayRemaining: 0,
      }),
    );
  });

  it("blocks all Xero calls locally while a persisted tenant pause is active", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({
      tenantId: "tenant-paused",
      rateLimitPausedUntil: new Date(Date.now() + 60_000),
      rateLimitProblem: "day",
    } as any);
    const operation = vi.fn();

    await expect(runXeroRequest(
      { token: "token", tenantId: "tenant-paused" },
      "blocked request",
      operation,
    )).rejects.toThrow("Xero daily request limit is still active");
    expect(operation).not.toHaveBeenCalled();
  });

  it("deduplicates simultaneous reads for the same tenant and cache key", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({
      tenantId: "tenant-dedupe",
      rateLimitPausedUntil: null,
    } as any);
    let release!: () => void;
    const responsePromise = new Promise<any>((resolve) => {
      release = () => resolve({ data: { PurchaseOrders: [{ PurchaseOrderID: "po-1" }] }, headers: {} });
    });
    const operation = vi.fn(() => responsePromise);

    const first = runCachedXeroGet(
      { token: "token", tenantId: "tenant-dedupe" },
      "purchase-order:AD123456",
      60_000,
      operation,
    );
    const second = runCachedXeroGet(
      { token: "token", tenantId: "tenant-dedupe" },
      "purchase-order:AD123456",
      60_000,
      operation,
    );
    await Promise.resolve();
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(setXeroApiCache).toHaveBeenCalledTimes(1);
  });

  it("bypasses an existing cache entry when an explicit verification requires fresh Xero data", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({ tenantId: "tenant-fresh", rateLimitPausedUntil: null } as any);
    vi.mocked(getXeroApiCache).mockResolvedValue({ PurchaseOrders: [{ Quantity: 1 }] } as any);
    const operation = vi.fn().mockResolvedValue({
      data: { PurchaseOrders: [{ Quantity: 2 }] },
      headers: {},
    });

    await expect(runCachedXeroGet(
      { token: "token", tenantId: "tenant-fresh" },
      "purchase-order:DD702871",
      60_000,
      operation,
      { forceRefresh: true },
    )).resolves.toEqual({ PurchaseOrders: [{ Quantity: 2 }] });

    expect(getXeroApiCache).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(setXeroApiCache).toHaveBeenCalledWith(
      "tenant-fresh",
      "purchase-order:DD702871",
      { PurchaseOrders: [{ Quantity: 2 }] },
      60_000,
    );
  });

  it("does not create an operational alert for an expected missing purchase-order lookup", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({ tenantId: "tenant-not-found", rateLimitPausedUntil: null } as any);
    const operation = vi.fn().mockRejectedValue({ response: { status: 404 }, message: "Request failed with status code 404" });

    await expect(runXeroRequest(
      { token: "token", tenantId: "tenant-not-found" },
      "GET purchase-order:P702869",
      operation,
    )).rejects.toEqual(expect.objectContaining({ response: { status: 404 } }));

    expect(mockReportWorkflowFailureSafely).not.toHaveBeenCalled();
  });

  it("does not create an operational alert when a locally linked Xero bill is unavailable", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({ tenantId: "tenant-linked-bill-not-found", rateLimitPausedUntil: null } as any);
    const operation = vi.fn().mockRejectedValue({ response: { status: 404 }, message: "Request failed with status code 404" });

    await expect(runXeroRequest(
      { token: "token", tenantId: "tenant-linked-bill-not-found" },
      "GET invoice-id:bill-guid",
      operation,
    )).rejects.toEqual(expect.objectContaining({ response: { status: 404 } }));

    expect(mockReportWorkflowFailureSafely).not.toHaveBeenCalled();
  });

  it("still creates an operational alert for an unexpected Xero request failure", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({ tenantId: "tenant-server-error", rateLimitPausedUntil: null } as any);
    const operation = vi.fn().mockRejectedValue({ response: { status: 500 }, message: "Request failed with status code 500" });

    await expect(runXeroRequest(
      { token: "token", tenantId: "tenant-server-error" },
      "GET purchase-order:P702869",
      operation,
    )).rejects.toEqual(expect.objectContaining({ response: { status: 500 } }));

    expect(mockReportWorkflowFailureSafely).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: "xero-api",
      severity: "error",
      details: { operation: "GET purchase-order:P702869", httpStatus: 500 },
    }));
  });

  it("retries one transient gateway failure only when an idempotent operation opts in", async () => {
    vi.mocked(getXeroToken).mockResolvedValue({ tenantId: "tenant-attachment-retry", rateLimitPausedUntil: null } as any);
    const operation = vi.fn()
      .mockRejectedValueOnce({ response: { status: 504 }, message: "Request failed with status code 504" })
      .mockResolvedValueOnce({ data: { Attachments: [{ FileName: "invoice.pdf" }] }, headers: {} });

    await expect(runXeroRequest(
      { token: "token", tenantId: "tenant-attachment-retry" },
      "upload invoice attachment",
      operation,
      { retryTransientGatewayFailures: true },
    )).resolves.toEqual(expect.objectContaining({ data: expect.anything() }));

    expect(operation).toHaveBeenCalledTimes(2);
    expect(mockReportWorkflowFailureSafely).not.toHaveBeenCalled();
  });
});

describe("bounded strict GET rate-limit handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(getXeroToken).mockResolvedValue(null);
    vi.mocked(updateXeroRateLimitState).mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const auth = (tenantId: string) => ({ token: "token", tenantId });
  const limit = (seconds?: string) => ({ response: { status: 429, headers: seconds === undefined ? {} : { "retry-after": seconds } } });

  it.each(["1", "5"])("retries a %s-second GET 429 once through the queue, respecting the recorded pause", async seconds => {
    const tenantId = `tenant-bounded-${seconds}`;
    let token: any = { tenantId, rateLimitPausedUntil: null };
    vi.mocked(getXeroToken).mockImplementation(async () => token);
    vi.mocked(updateXeroRateLimitState).mockImplementation(async (_id, state) => { token = { ...token, ...state }; });
    const times: number[] = [];
    const get = vi.spyOn(axios, "get").mockImplementationOnce(async () => { times.push(Date.now()); throw limit(seconds); })
      .mockImplementationOnce(async () => { times.push(Date.now()); return { data: { Invoices: [] }, headers: {} } as any; });
    const result = expect(runBoundedXeroGet(auth(tenantId), "GET exact evidence", "https://example.test/Invoices")).resolves.toMatchObject({ data: { Invoices: [] } });
    await vi.runAllTimersAsync();
    await result;
    expect(get).toHaveBeenCalledTimes(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(Math.max(1100, Number(seconds) * 1000));
    expect(updateXeroRateLimitState).toHaveBeenCalledWith(tenantId, expect.objectContaining({ rateLimitRetryAfterSeconds: Number(seconds), rateLimitPausedUntil: expect.any(Date) }));
    expect(updateXeroRateLimitState).toHaveBeenCalledWith(tenantId, expect.objectContaining({ rateLimitPausedUntil: null }));
  });

  it.each(["6", "72000", undefined, "not-a-number"])("does not retry a long/missing/invalid Retry-After (%s)", async seconds => {
    const get = vi.spyOn(axios, "get").mockRejectedValue(limit(seconds));
    await expect(runBoundedXeroGet(auth(`tenant-long-${seconds}`), "GET exact evidence", "https://example.test/Invoices"))
      .rejects.toMatchObject({ name: "XeroRateLimitError", retryAfterSeconds: seconds === undefined ? 1 : /^\d+$/.test(seconds) ? Number(seconds) : 60, hasExplicitRetryAfter: seconds !== undefined && /^\d+$/.test(seconds) });
    expect(get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never performs a third GET if its single retry is also rate limited", async () => {
    const get = vi.spyOn(axios, "get").mockRejectedValue(limit("1"));
    const result = expect(runBoundedXeroGet(auth("tenant-twice"), "GET exact evidence", "https://example.test/Invoices")).rejects.toBeInstanceOf(XeroRateLimitError);
    await vi.runAllTimersAsync(); await result;
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not override a longer tenant pause recorded while waiting", async () => {
    const tenantId = "tenant-concurrent-pause";
    vi.mocked(getXeroToken).mockResolvedValueOnce(null).mockResolvedValue({ tenantId, rateLimitPausedUntil: new Date(Date.now() + 60000) } as any);
    const get = vi.spyOn(axios, "get").mockRejectedValue(limit("1"));
    const result = expect(runBoundedXeroGet(auth(tenantId), "GET exact evidence", "https://example.test/Invoices")).rejects.toThrow("still active");
    await vi.runAllTimersAsync(); await result;
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PUT"])("offers no arbitrary %s callback or method override", async method => {
    const get = vi.spyOn(axios, "get");
    const callback = vi.fn();
    await expect(runBoundedXeroGet(auth(method), `${method} forbidden` as any, "https://example.test/Invoices")).rejects.toThrow("only GET");
    await expect(runBoundedXeroGet(auth(method), "GET forbidden", callback as any)).rejects.toThrow("only GET");
    await expect(runBoundedXeroGet(auth(method), "GET forbidden", "https://example.test/Invoices", { method } as any)).rejects.toThrow("only GET");
    if (false) {
      // @ts-expect-error A write operation is not accepted by the bounded GET API.
      void runBoundedXeroGet(auth(method), "POST forbidden", "https://example.test/Invoices");
      // @ts-expect-error An arbitrary callback cannot be supplied as its transport.
      void runBoundedXeroGet(auth(method), "GET forbidden", callback);
      // @ts-expect-error Method overrides cannot be supplied in read configuration.
      void runBoundedXeroGet(auth(method), "GET forbidden", "https://example.test/Invoices", { method: "PUT" });
    }
    expect(get).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT"])("keeps ordinary %s 429 calls single-attempt", async method => {
    const operation = vi.fn().mockRejectedValue(limit("1"));
    await expect(runXeroRequest(auth(`tenant-write-${method}`), `${method} financial write`, operation)).rejects.toBeInstanceOf(XeroRateLimitError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
