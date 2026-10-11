import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  assertExtraHireRelease,
  getExtraHireReleasePolicy,
} from "./financialExtraHireInvoiceRelease";
import {
  processAutomaticExtraHireInvoice,
  EXTRA_HIRE_WEBHOOK_PATH,
} from "./financialExtraHireInvoiceService";
export function parseExtraHireWebhookEnvelope(body: unknown): {
  recordId: string;
} {
  const raw =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const values = [raw.deal_id, raw.record_id, raw.id].filter(
    v => v !== undefined
  );
  if (
    !values.length ||
    values.some(
      v => typeof v !== "string" || !/^\d+x\d{1,12}$/.test(v.trim())
    ) ||
    new Set(values.map(v => (v as string).trim())).size !== 1
  )
    throw new Error(
      "Extra Hire requires one exact named Deal webservice ID; conflicting IDs are rejected."
    );
  return { recordId: (values[0] as string).trim() };
}
export function registerExtraHireInvoiceWebhook(app: Express) {
  app.post(EXTRA_HIRE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    const a = Buffer.from(
      process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim() ?? ""
    );
    const b = Buffer.from(
      req.header("x-financial-webhook-secret")?.trim() ?? ""
    );
    if (!a.length || a.length !== b.length || !timingSafeEqual(a, b))
      return res
        .status(401)
        .json({ ok: false, error: "unauthenticated-extra-hire-webhook" });
    const disabled = () =>
      res
        .status(503)
        .json({
          ok: false,
          status: "held",
          error: "extra-hire-release-disabled",
          xeroWritesAttempted: 0,
        });
    // Policy lookup is the only permitted read until the independent release is valid.
    if (process.env.FINANCIAL_EXTRA_HIRE_AUTOMATIC_ENABLED !== "true")
      return disabled();
    try {
      assertExtraHireRelease(await getExtraHireReleasePolicy());
    } catch {
      return disabled();
    }
    let envelope: { recordId: string };
    try {
      envelope = parseExtraHireWebhookEnvelope(req.body);
    } catch (e) {
      return res
        .status(400)
        .json({
          ok: false,
          error: e instanceof Error ? e.message : "invalid-extra-hire-webhook",
        });
    }
    try {
      const result = await processAutomaticExtraHireInvoice(envelope.recordId);
      return res.status(result.ok ? 200 : 202).json(result);
    } catch {
      return res
        .status(202)
        .json({
          ok: false,
          status: "held",
          recordId: envelope.recordId,
          warning:
            "Inspect the immutable AP Extra Hire ledger before retry; source/policy/transport may require reconciliation.",
        });
    }
  });
}
