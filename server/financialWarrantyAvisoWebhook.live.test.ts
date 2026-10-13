import { describe, expect, it } from "vitest";

const liveIt = process.env.RUN_LIVE_WARRANTY_AVISO_WEBHOOK_TEST === "true" ? it : it.skip;
const secret = process.env.FINANCIAL_VTIGER_WEBHOOK_SECRET || process.env.FINANCIAL_AP_WEBHOOK_SECRET;
const baseUrl = process.env.WARRANTY_WEBHOOK_SMOKE_BASE_URL || "http://127.0.0.1:3000";

describe("live Warranty & Aviso protected receiver smoke test", () => {
  liveIt(
    "accepts the canonical id/secret envelope after the gate/policy and rejects a nonexistent Deal before any Xero or ledger work",
    async () => {
      if (!secret) throw new Error("No financial webhook secret is configured for the opt-in smoke test.");
      if (process.env.FINANCIAL_WARRANTY_AUTOMATIC_ENABLED !== "true") throw new Error("Warranty runtime gate is not enabled for the opt-in smoke test.");
      const response = await fetch(`${baseUrl}/api/webhooks/vtiger/warranty-aviso`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "D999999999", secret }),
      });
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ ok: false, error: "One unambiguous exact Deal webservice ID is required." });
      expect(body.xeroWritesAttempted ?? 0).toBe(0);
    },
    45_000,
  );
});
