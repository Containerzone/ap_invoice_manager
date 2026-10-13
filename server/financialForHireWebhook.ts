import type { Express, Request, Response } from "express";
import { processAutomaticInitialForHire } from "./financialForHireLiveService";
import { FOR_HIRE_FUTURE_WEBHOOK_PATH } from "./financialForHireService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

export const FOR_HIRE_WEBHOOK_SECRET_HEADER = "x-financial-webhook-secret" as const;
export const FOR_HIRE_WEBHOOK_EVENT = "container-control.for-hire-request" as const;

export type ForHireWebhookEnvelope = {
  recordId: string;
  event: string | null;
};

/**
 * Compatibility parser: records from the isolated FOR HIRE Request branch may
 * use the existing `id` or `record_id` field. Financial values in the body are
 * never read; AP refreshes Container Control and Vendor directly from VTiger.
 */
export function parseForHireWebhookEnvelope(body: unknown): ForHireWebhookEnvelope {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const recordId = typeof source.record_id === "string" ? source.record_id.trim()
    : typeof source.id === "string" ? source.id.trim() : "";
  if (!/^\d+x\d+$/i.test(recordId) && !/^C\d+$/i.test(recordId)) {
    throw new Error("For Hire webhook requires an exact VTiger Container Control id, record_id or C-number.");
  }
  const event = typeof source.event === "string" && source.event.trim() ? source.event.trim() : null;
  return { recordId, event };
}

/**
 * VTiger's workflow editor commonly maps the JSON `id` key to the human
 * Container Control Number (for example C1912), while `record_id` may carry
 * the webservice ID. Resolve that business reference with one exact,
 * read-only AP-side query before any source refresh or financial action.
 */
export async function resolveForHireRecordId(reference: string): Promise<string> {
  if (/^\d+x\d+$/i.test(reference)) return reference;
  const lookup = await findExactFinancialCandidate({
    sourceCategory: "container_control",
    businessNumber: reference,
  });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1) {
    throw new Error(lookup.message || "For Hire Container Control business reference is missing or ambiguous.");
  }
  return lookup.candidates[0].recordId;
}

export function hasForHireWebhookSecret(req: Pick<Request, "header" | "body">): boolean {
  return hasFinancialWebhookSecret(req);
}

/**
 * Registered receiver for the later independent FOR HIRE-only branch. The
 * environment policy is checked before any VTiger read, ledger reservation or
 * Xero call. This route never accepts Asset/Customer Sale financial facts.
 */
export function registerForHireWebhook(app: Express): void {
  app.post(FOR_HIRE_FUTURE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasForHireWebhookSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-for-hire-webhook" });
    let envelope: ForHireWebhookEnvelope;
    try {
      envelope = parseForHireWebhookEnvelope(req.body);
    } catch (error) {
      reportWorkflowFailureSafely({
        workflowType: "initial_for_hire",
        recordKey: "for-hire:webhook-envelope",
        title: "For Hire webhook rejected",
        errorMessage: error instanceof Error ? error.message : "Invalid For Hire webhook envelope.",
        details: { route: FOR_HIRE_FUTURE_WEBHOOK_PATH },
        severity: "error",
      });
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "invalid-for-hire-webhook" });
    }
    if (process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED !== "true") {
      return res.status(503).json({ ok: false, status: "held", error: "for-hire-release-disabled", xeroWritesAttempted: 0 });
    }
    try {
      const resolvedRecordId = await resolveForHireRecordId(envelope.recordId);
      const result = await processAutomaticInitialForHire(resolvedRecordId);
      if (!result.ok) reportWorkflowFailureSafely({
        workflowType: "initial_for_hire",
        recordKey: `for-hire:${resolvedRecordId}`,
        title: "For Hire initial PO held",
        errorMessage: ("warning" in result ? result.warning : null) ?? result.status,
        details: { containerControlId: resolvedRecordId, webhookReference: envelope.recordId, status: result.status },
        severity: "error",
      });
      return res.status(result.ok ? 200 : 202).json(result);
    } catch (error) {
      reportWorkflowFailureSafely({
        workflowType: "initial_for_hire",
        recordKey: `for-hire:${envelope.recordId}`,
        title: "For Hire initial PO held",
        errorMessage: error instanceof Error ? error.message : "For Hire source, release or Xero preflight could not be completed.",
        details: { containerControlReference: envelope.recordId },
        severity: "error",
      });
      return res.status(202).json({ ok: false, status: "held", warning: "For Hire PO held; inspect the AP lifecycle ledger.", xeroWritesAttempted: 0 });
    }
  });
}

/** Retained for contract tests; an authenticated request remains safely held while the gate is off. */
export async function disabledForHireWebhookHandler(req: Request, res: Response) {
  if (!hasForHireWebhookSecret(req)) return res.status(401).json({ error: "unauthenticated-for-hire-webhook" });
  try {
    parseForHireWebhookEnvelope(req.body);
    return res.status(503).json({ error: "for-hire-route-not-activated", path: FOR_HIRE_FUTURE_WEBHOOK_PATH, xeroWritesAttempted: 0 });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "invalid-for-hire-webhook" });
  }
}
