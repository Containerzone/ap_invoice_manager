import { describe, expect, it } from "vitest";

const liveIt = process.env.RUN_LIVE_FINAL_WEIGHT_WEBHOOK_TEST === "true" ? it : it.skip;
const secret = process.env.FINANCIAL_VTIGER_WEBHOOK_SECRET || process.env.FINANCIAL_AP_WEBHOOK_SECRET;

async function probe(path: string) {
  if (!secret) throw new Error("No financial webhook secret is configured for the opt-in smoke test.");
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "5x999999999", secret }),
  });
  const body = await response.json();
  return { response, body };
}

describe("live Final Weight protected receiver smoke test", () => {
  liveIt("accepts the canonical id/secret envelope on both routes and holds a nonexistent exact Deal without an Xero write", async () => {
    for (const path of ["/api/webhooks/vtiger/final-weight-overweight", "/api/webhooks/vtiger/final-weight-underweight"]) {
      const { response, body } = await probe(path);
      expect(response.status).toBe(202);
      expect(body).toMatchObject({ ok: false, status: "held", recordId: "5x999999999" });
      expect(body.xeroWritesAttempted ?? 0).toBe(0);
    }
  }, 45_000);
});
