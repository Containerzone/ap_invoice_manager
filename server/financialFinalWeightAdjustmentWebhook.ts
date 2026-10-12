import type { Express, Request, Response } from "express";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import { FINAL_WEIGHT_PATHS, type FinalWeightDirection } from "./financialFinalWeightAdjustmentRules";
import { assertFinalWeightRelease, getFinalWeightReleasePolicy } from "./financialFinalWeightAdjustmentRelease";
import { processAutomaticFinalWeightAdjustment } from "./financialFinalWeightAdjustmentService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

export type FinalWeightWebhookEnvelope = { recordId: string | null; dealNumber: string | null };

/**
 * Accepts the established VTiger `id`/`secret` envelope with either an exact
 * Deal webservice ID or an exact legacy D-number. Financial body fields are
 * intentionally ignored and a D-number is resolved only after this family's
 * independent release checks pass.
 */
export function parseFinalWeightEnvelope(body: unknown): FinalWeightWebhookEnvelope {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Final Weight requires an exact named Deal webservice ID or D-number.");
  const raw = body as Record<string, unknown>;
  const ids = [raw.deal_id, raw.record_id, raw.id].filter(value => value !== undefined);
  if (!ids.length || ids.some(value => typeof value !== "string") || new Set(ids.map(value => (value as string).trim())).size !== 1) throw new Error("Final Weight requires one unambiguous exact Deal webservice ID or D-number.");
  // All other body fields (including direction, amount, date and customer) are ignored.
  const reference = (ids[0] as string).trim();
  if (/^\d+x\d{1,12}$/i.test(reference)) return { recordId: reference, dealNumber: null };
  if (/^D\d{1,12}$/i.test(reference)) return { recordId: null, dealNumber: reference.toUpperCase() };
  throw new Error("Final Weight requires one exact Deal webservice ID or D-number.");
}

/** Resolves only one bounded exact legacy D-number; ambiguity always holds. */
export async function resolveFinalWeightWebhookRecord(envelope: FinalWeightWebhookEnvelope): Promise<string> {
  if (envelope.recordId) return envelope.recordId;
  if (!envelope.dealNumber) throw new Error("Final Weight contains no exact Deal reference.");
  const lookup = await findExactFinancialCandidate({ sourceCategory: "deal", businessNumber: envelope.dealNumber });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1) throw new Error(`Final Weight D-number lookup is ${lookup.outcome}: ${lookup.message}`);
  return lookup.candidates[0]!.recordId;
}
export function hasFinalWeightSecret(req: Pick<Request, "header" | "body">): boolean {
  return hasFinancialWebhookSecret(req);
}
function isSafeProbe(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).dryRun === true);
}
export function registerFinalWeightAdjustmentWebhooks(app: Express) {
  for (const direction of ["overweight", "underweight"] as FinalWeightDirection[]) {
    app.post(FINAL_WEIGHT_PATHS[direction], async (req: Request, res: Response) => {
      if (!hasFinalWeightSecret(req)) return res.status(401).json({ ok: false, error: "unauthenticated-final-weight-webhook" });
      const safeProbe = isSafeProbe(req.body);
      let envelope: FinalWeightWebhookEnvelope;
      try { envelope = parseFinalWeightEnvelope(req.body); } catch (error) {
        if (process.env.FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED === "true" && !safeProbe) reportWorkflowFailureSafely({
          workflowType: "final_weight_adjustment", recordKey: `final-weight:${direction}:unresolved`, title: `Final Weight ${direction} held`,
          errorMessage: "Final Weight webhook did not provide one exact Deal reference.", details: { direction, status: "invalid_reference" }, severity: "error",
        });
        return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "invalid-final-weight-webhook" });
      }
      const disabled = () => res.status(503).json({ ok: false, status: "held", recordId: envelope.recordId, direction, error: "final-weight-release-disabled", xeroWritesAttempted: 0 });
      // Flag unset: zero DB reads/writes, VTiger calls, Xero calls, alerts or schedules.
      if (process.env.FINANCIAL_FINAL_WEIGHT_AUTOMATIC_ENABLED !== "true") return disabled();
      // Missing policy: only local policy SELECT, no evidence/claim writes or upstream reads.
      try { assertFinalWeightRelease(await getFinalWeightReleasePolicy(), direction); } catch { return disabled(); }
      try {
        const recordId = await resolveFinalWeightWebhookRecord(envelope);
        const result = await processAutomaticFinalWeightAdjustment(recordId, direction);
        if (!result.ok && !safeProbe) reportWorkflowFailureSafely({
          workflowType: "final_weight_adjustment", recordKey: `final-weight:${direction}:${recordId}`, title: `Final Weight ${direction} held`,
          errorMessage: result.warning ?? "Final Weight route returned a held result.", details: { direction, dealId: recordId, status: result.status }, severity: "error",
        });
        return res.status(result.ok ? 200 : 202).json(result);
      } catch {
        if (!safeProbe) reportWorkflowFailureSafely({
          workflowType: "final_weight_adjustment", recordKey: `final-weight:${direction}:${envelope.recordId ?? envelope.dealNumber ?? "unresolved"}`, title: `Final Weight ${direction} held`,
          errorMessage: "Final Weight source, policy or Xero preflight could not be completed.", details: { direction, dealReference: envelope.recordId ?? envelope.dealNumber ?? null, status: "held" }, severity: "error",
        });
        return res.status(202).json({ ok: false, status: "held", recordId: envelope.recordId, direction, warning: "Inspect the immutable final-weight ledger: source/policy/execution held. Never blind retry, create an invoice or mutate CRM." });
      }
    });
  }
}
