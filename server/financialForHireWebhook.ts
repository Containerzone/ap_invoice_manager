import type { Request, Response } from "express";
import { FOR_HIRE_FUTURE_WEBHOOK_PATH } from "./financialForHireService";

export const FOR_HIRE_WEBHOOK_SECRET_HEADER = "x-financial-webhook-secret" as const;

export type ForHireWebhookEnvelope = {
  recordId: string;
  event: string | null;
};

/**
 * Parses only the established VTiger compatibility identifiers. Financial facts
 * are intentionally not accepted from the body; a future activated handler must
 * re-read the exact Container Control and assigned Vendor from VTiger.
 */
export function parseForHireWebhookEnvelope(body: unknown): ForHireWebhookEnvelope {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const recordId = typeof source.record_id === "string" ? source.record_id.trim()
    : typeof source.id === "string" ? source.id.trim() : "";
  if (!/^\d+x\d+$/i.test(recordId)) throw new Error("For Hire webhook requires an exact VTiger Container Control id or record_id.");
  const event = typeof source.event === "string" && source.event.trim() ? source.event.trim() : null;
  return { recordId, event };
}

export function hasForHireWebhookSecret(req: Pick<Request, "header">): boolean {
  const expected = process.env.FINANCIAL_AP_WEBHOOK_SECRET?.trim();
  const supplied = req.header(FOR_HIRE_WEBHOOK_SECRET_HEADER)?.trim();
  return Boolean(expected && supplied && supplied === expected);
}

/**
 * The function exists for contract tests only. It is deliberately never mounted
 * in server/_core/index.ts during this phase, so the future AP For Hire URL is
 * unroutable until the separate For Hire-only VTiger branch and cutover are
 * approved.
 */
export async function disabledForHireWebhookHandler(req: Request, res: Response) {
  if (!hasForHireWebhookSecret(req)) return res.status(401).json({ error: "unauthenticated-for-hire-webhook" });
  try {
    parseForHireWebhookEnvelope(req.body);
    return res.status(503).json({ error: "for-hire-route-not-activated", path: FOR_HIRE_FUTURE_WEBHOOK_PATH, xeroWritesAttempted: 0 });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "invalid-for-hire-webhook" });
  }
}
