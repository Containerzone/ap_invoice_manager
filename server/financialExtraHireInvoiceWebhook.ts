import type { Express, Request, Response } from "express";
import { hasFinancialWebhookSecret } from "./financialWebhookAuthentication";
import {
  assertExtraHireRelease,
  getExtraHireReleasePolicy,
} from "./financialExtraHireInvoiceRelease";
import {
  processAutomaticExtraHireInvoice,
  EXTRA_HIRE_WEBHOOK_PATH,
} from "./financialExtraHireInvoiceService";
import { findExactFinancialCandidate } from "./vtigerFinancialCandidateService";

export type ExtraHireWebhookEnvelope = {
  recordId: string | null;
  dealNumber: string | null;
};

export function parseExtraHireWebhookEnvelope(body: unknown): {
  recordId: string | null;
  dealNumber: string | null;
} {
  const raw =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const values = [raw.deal_id, raw.record_id, raw.id].filter(
    v => v !== undefined
  );
  if (!values.length || values.some(v => typeof v !== "string"))
    throw new Error(
      "Extra Hire requires one exact named Deal webservice ID or D-number."
    );
  const id = (values[0] as string).trim();
  if (new Set(values.map(v => (v as string).trim())).size !== 1)
    throw new Error(
      "Extra Hire requires one unambiguous named Deal reference; conflicting IDs are rejected."
    );
  if (/^\d+x\d{1,12}$/i.test(id)) return { recordId: id, dealNumber: null };
  if (/^D\d{1,12}$/i.test(id))
    return { recordId: null, dealNumber: id.toUpperCase() };
  throw new Error(
    "Extra Hire requires one exact Deal webservice ID or D-number; arbitrary values are rejected."
  );
}

/**
 * The legacy Operations action sends Potentials.potential_no (D<number>) rather
 * than a webservice ID. Resolve only that exact number through the bounded AP
 * finder; zero or multiple matches always hold and can never select a Deal.
 */
export async function resolveExtraHireWebhookRecord(
  envelope: ExtraHireWebhookEnvelope
): Promise<string> {
  if (envelope.recordId) return envelope.recordId;
  if (!envelope.dealNumber)
    throw new Error("Extra Hire contains no exact Deal reference.");
  const lookup = await findExactFinancialCandidate({
    sourceCategory: "deal",
    businessNumber: envelope.dealNumber,
  });
  if (lookup.outcome !== "found" || lookup.candidates.length !== 1)
    throw new Error(
      `Extra Hire D-number lookup is ${lookup.outcome}: ${lookup.message}`
    );
  return lookup.candidates[0]!.recordId;
}

export function hasExtraHireSecret(req: Pick<Request, "header" | "body">): boolean {
  return hasFinancialWebhookSecret(req);
}

export function registerExtraHireInvoiceWebhook(app: Express) {
  app.post(EXTRA_HIRE_WEBHOOK_PATH, async (req: Request, res: Response) => {
    if (!hasExtraHireSecret(req))
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
    let envelope: ExtraHireWebhookEnvelope;
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
    let recordId: string;
    try {
      recordId = await resolveExtraHireWebhookRecord(envelope);
    } catch (error) {
      return res.status(202).json({
        ok: false,
        status: "held",
        warning:
          error instanceof Error
            ? error.message
            : "Extra Hire exact Deal lookup is held.",
        xeroWritesAttempted: 0,
      });
    }
    try {
      const result = await processAutomaticExtraHireInvoice(recordId);
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
