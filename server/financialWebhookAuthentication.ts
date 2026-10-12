import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

/**
 * Canonical secret used by all AP-owned VTiger financial receivers. The old
 * shared AP secret remains an explicit compatibility value during rotation.
 */
export const FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV =
  "FINANCIAL_VTIGER_WEBHOOK_SECRET" as const;
export const FINANCIAL_AP_WEBHOOK_SECRET_ENV =
  "FINANCIAL_AP_WEBHOOK_SECRET" as const;
export const FINANCIAL_WEBHOOK_SECRET_HEADER =
  "x-financial-webhook-secret" as const;

type WebhookRequest = Pick<Request, "header" | "body">;

function bodySecret(req: WebhookRequest): unknown {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return undefined;
  }
  return (req.body as Record<string, unknown>).secret;
}

function secretMatches(expected: Buffer, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const candidate = Buffer.from(supplied.trim());
  return Boolean(
    expected.length &&
      expected.length === candidate.length &&
      timingSafeEqual(expected, candidate)
  );
}

/**
 * Returns canonical/current values first, then the previous shared AP value.
 * Values are never logged or returned. Additional route-specific secret names
 * allow a legacy workflow to rotate independently without breaking others.
 */
export function configuredFinancialWebhookSecrets(
  routeSpecificEnvNames: readonly string[] = []
): Buffer[] {
  const names = [
    ...routeSpecificEnvNames,
    FINANCIAL_VTIGER_WEBHOOK_SECRET_ENV,
    FINANCIAL_AP_WEBHOOK_SECRET_ENV,
  ];
  const values = names
    .map(name => process.env[name]?.trim() ?? "")
    .filter(Boolean);
  return values
    .filter((value, index) => values.indexOf(value) === index)
    .map(value => Buffer.from(value));
}

/**
 * Accepts either the canonical JSON `secret` field used by existing VTiger
 * actions or the header used by newer callers. Every comparison is
 * constant-time and no input other than the secret is trusted here.
 */
export function hasFinancialWebhookSecret(
  req: WebhookRequest,
  routeSpecificEnvNames: readonly string[] = []
): boolean {
  const expectedSecrets = configuredFinancialWebhookSecrets(routeSpecificEnvNames);
  // Preserve the disabled-route contract: a valid header is enough to make a
  // release-gate decision without touching/parsing the request body.
  if (expectedSecrets.some(expected =>
    secretMatches(expected, req.header(FINANCIAL_WEBHOOK_SECRET_HEADER))
  )) {
    return true;
  }
  return expectedSecrets.some(expected => secretMatches(expected, bodySecret(req)));
}
