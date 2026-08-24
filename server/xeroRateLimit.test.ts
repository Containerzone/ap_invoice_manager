import { describe, expect, it } from "vitest";
import { getXeroRateLimitRetryDelayMs, withXeroRateLimitRetry } from "./xeroService";

describe("Xero rate-limit handling", () => {
  it("uses a bounded Retry-After header when Xero supplies one", () => {
    expect(getXeroRateLimitRetryDelayMs({ "retry-after": "3" }, 0)).toBe(3000);
    expect(getXeroRateLimitRetryDelayMs({ "Retry-After": "60" }, 0)).toBe(10_000);
  });

  it("uses exponential backoff when Xero does not supply Retry-After", () => {
    expect(getXeroRateLimitRetryDelayMs(undefined, 0)).toBe(1000);
    expect(getXeroRateLimitRetryDelayMs(undefined, 2)).toBe(4000);
  });

  it("returns a clear retryable message once the rate-limit retry budget is exhausted", async () => {
    await expect(
      withXeroRateLimitRetry(
        async () => Promise.reject({ response: { status: 429, headers: {} } }),
        "bill creation",
        0
      )
    ).rejects.toThrow("Xero is temporarily rate-limiting bill creation");
  });
});
