import { describe, expect, it } from "vitest";

const liveIt = process.env.RUN_LIVE_EXTRA_HIRE_WEBHOOK_TEST === "true" ? it : it.skip;
const secret =
  process.env.FINANCIAL_VTIGER_WEBHOOK_SECRET ||
  process.env.FINANCIAL_AP_WEBHOOK_SECRET;

describe("live Extra Hire protected receiver smoke test", () => {
  liveIt(
    "accepts the canonical id/secret envelope and safely holds a nonexistent exact Deal without an Xero write",
    async () => {
      if (!secret)
        throw new Error("No financial webhook secret is configured for the opt-in smoke test.");
      if (process.env.FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED !== "true")
        throw new Error("Extra Hire runtime gate is not enabled for the opt-in smoke test.");
      const response = await fetch(
        "http://127.0.0.1:3000/api/webhooks/vtiger/extra-hire-invoice",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "D999999999", secret, dryRun: true }),
        }
      );
      const body = await response.json();
      expect(response.status).toBe(202);
      expect(body).toMatchObject({ ok: false, status: "held" });
      expect(body.xeroWritesAttempted ?? 0).toBe(0);
    },
    45_000
  );
});
