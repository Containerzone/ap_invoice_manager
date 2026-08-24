import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  getXeroToken: vi.fn(),
  updateXeroRateLimitState: vi.fn(),
  getXeroApiCache: vi.fn(),
  setXeroApiCache: vi.fn(),
  invalidateXeroApiCache: vi.fn(),
}));

import {
  getXeroApiCache,
  getXeroToken,
  setXeroApiCache,
  updateXeroRateLimitState,
} from "./db";
import { runCachedXeroGet, runXeroRequest } from "./xeroRequestManager";

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
});
