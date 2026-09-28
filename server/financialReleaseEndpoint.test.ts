import { afterEach, describe, expect, it, vi } from "vitest";
import { serveDisabledFinancialRelease } from "./financialReleaseEndpoint";

function response() {
  const value = { status: vi.fn(), json: vi.fn() };
  value.status.mockReturnValue(value);
  return value;
}

describe("disabled financial release endpoint", () => {
  const originalSecret = process.env.FINANCIAL_SHADOW_WEBHOOK_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.FINANCIAL_SHADOW_WEBHOOK_SECRET;
    else process.env.FINANCIAL_SHADOW_WEBHOOK_SECRET = originalSecret;
  });

  it("rejects unauthenticated requests before any release processing", () => {
    process.env.FINANCIAL_SHADOW_WEBHOOK_SECRET = "test-secret";
    const res = response();
    serveDisabledFinancialRelease({ params: { family: "extra_hire" }, header: () => "wrong" } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized financial release request" });
  });

  it("always returns the server-enforced no-write response for an authenticated request", () => {
    process.env.FINANCIAL_SHADOW_WEBHOOK_SECRET = "test-secret";
    const res = response();
    serveDisabledFinancialRelease({ params: { family: "extra_hire" }, header: () => "test-secret" } as any, res as any);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      family: "extra_hire", mode: "release_preparation_only", xeroWritePermitted: false, schedulesChanged: false,
    }));
  });
});
