import { describe, expect, it } from "vitest";

describe.runIf(process.env.RUN_LIVE_DEPOSIT_MAIN_DEDUCTION_GATE_TEST === "true")(
  "Deposit main-Draft deduction deployment gate",
  () => {
    it("has the approved runtime gate enabled", () => {
      expect(process.env.FINANCIAL_DEPOSIT_MAIN_DEDUCTION_AUTOMATIC_ENABLED).toBe("true");
    });

    it("authenticates a lightweight Deposit receiver probe without reaching Xero", async () => {
      const secret = process.env.FINANCIAL_VTIGER_WEBHOOK_SECRET || process.env.FINANCIAL_AP_WEBHOOK_SECRET;
      if (!secret) throw new Error("No financial webhook secret is configured for the opt-in smoke test.");
      const response = await fetch("http://127.0.0.1:3000/api/webhooks/vtiger/deposit-invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "D999999999", secret, dryRun: true }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        status?: string;
        error?: string;
        warning?: string;
        xeroWritesAttempted?: number;
      };
      expect(response.status).toBe(202);
      expect(body).toMatchObject({ ok: false, status: "held" });
      expect(`${body.error ?? ""} ${body.warning ?? ""}`).not.toMatch(/unauthenticated|release-disabled/i);
      expect(body.xeroWritesAttempted ?? 0).toBe(0);
    }, 20_000);

    it("confirms the published Deposit receiver is active without processing a real Deal", async () => {
      if (process.env.RUN_LIVE_DEPOSIT_MAIN_DEDUCTION_PUBLIC_TEST !== "true") return;
      const secret = process.env.FINANCIAL_VTIGER_WEBHOOK_SECRET || process.env.FINANCIAL_AP_WEBHOOK_SECRET;
      if (!secret) throw new Error("No financial webhook secret is configured for the opt-in smoke test.");
      const response = await fetch("https://apinvmanager-dm3caxom.manus.space/api/webhooks/vtiger/deposit-invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "D999999999", secret, dryRun: true }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        status?: string;
        error?: string;
        warning?: string;
        xeroWritesAttempted?: number;
      };
      expect(response.status).toBe(202);
      expect(body).toMatchObject({ ok: false, status: "held" });
      expect(`${body.error ?? ""} ${body.warning ?? ""}`).not.toMatch(/unauthenticated|release-disabled/i);
      expect(body.xeroWritesAttempted ?? 0).toBe(0);
    }, 30_000);
  },
);
