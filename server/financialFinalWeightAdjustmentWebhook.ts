import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { FINAL_WEIGHT_PATHS, type FinalWeightDirection } from "./financialFinalWeightAdjustmentRules";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { processAutomaticFinalWeightAdjustment } from "./financialFinalWeightAdjustmentService";
export function parseFinalWeightEnvelope(body: unknown): { recordId: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Final-weight requires an exact named Deal webservice ID.");
  const raw = body as Record<string, unknown>;
  const ids = [raw.deal_id, raw.record_id, raw.id].filter(value => value !== undefined);
  if (!ids.length || ids.some(value => typeof value !== "string" || !/^\d+x\d{1,12}$/i.test(value.trim())) || new Set(ids.map(value => (value as string).trim())).size !== 1) throw new Error("One unambiguous exact Deal webservice ID is required.");
  // All other body fields (including direction, amount, date and customer) are ignored.
  return { recordId: (ids[0] as string).trim() };
}
function secretMatches(expected: Buffer, supplied: unknown) {
  if (typeof supplied !== "string") return false;
  const candidate = Buffer.from(supplied.trim());
  return Boolean(expected.length && expected.length === candidate.length && timingSafeEqual(expected, candidate));
}
/**
 * VTiger's existing Operations actions place the private value in JSON `secret`.
 * Accept that legacy envelope as a constant-time alternative to the normal HTTP
 * header. Its other JSON fields, including `dryRun`, are never trusted.
 */
export function hasFinalWeightSecret(req: Pick<Request, "header" | "body">) {
  const expected = Buffer.from(process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim() ?? "");
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  return secretMatches(expected, req.header("x-financial-webhook-secret")) || secretMatches(expected, body?.secret);
}
export function registerFinalWeightAdjustmentWebhooks(app: Express) {
  for (const direction of ["overweight", "underweight"] as FinalWeightDirection[]) {
    app.post(FINAL_WEIGHT_PATHS[direction], async (req: Request, res: Response) => {
      if (!hasFinalWeightSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-final-weight-webhook" });
      let envelope: { recordId: string };
      try { envelope = parseFinalWeightEnvelope(req.body); } catch (error) { return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "invalid-final-weight-webhook" }); }
      const disabled = () => res.status(503).json({ ok: false, status: "held", recordId: envelope.recordId, direction, error: "final-weight-release-disabled", xeroWritesAttempted: 0 });
      // Flag unset: zero DB reads/writes, VTiger calls, Xero calls, alerts or schedules.
      if (process.env.FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED !== "true") return disabled();
      // Missing policy: only local policy SELECT, no evidence/claim writes or upstream reads.
      try { assertFinalWeightRelease(await getFinalWeightReleasePolicy(), direction); } catch { return disabled(); }
      try {
        const result = await processAutomaticFinalWeightAdjustment(envelope.recordId, direction);
        return res.status(result.ok ? 200 : 202).json(result);
      } catch {
        return res.status(202).json({ ok: false, status: "held", recordId: envelope.recordId, direction, warning: "Inspect the immutable final-weight ledger: source/policy/execution held. Never blind retry, create an invoice or mutate CRM." });
      }
    });
  }
}
