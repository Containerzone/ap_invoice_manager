import { describe, expect, it } from "vitest";

const runLive = process.env.RUN_FINANCIAL_WEBHOOK_SECRET_LIVE_TEST === "true";
const canonicalSecret = process.env.FINANCIAL_VTIGER_WEBHOOK_SECRET?.trim();

const live = runLive && canonicalSecret ? describe : describe.skip;

live("canonical financial webhook secret deployment", () => {
  it("authenticates the VTiger body secret before safely rejecting an invalid Deal", async () => {
    const response = await fetch(
      "https://apinvmanager-dm3caxom.manus.space/api/webhooks/vtiger/main-customer-invoice",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "not-a-vtiger-deal", secret: canonicalSecret }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    const body = (await response.json()) as { error?: string };

    // Authentication runs first. A 400 parser rejection confirms this private
    // secret was accepted while the deliberately invalid identifier prevents
    // any source lookup, ledger reservation or Xero attempt.
    expect(response.status).toBe(400);
    expect(body.error).toMatch(/exact VTiger Deal/i);
  });
});
