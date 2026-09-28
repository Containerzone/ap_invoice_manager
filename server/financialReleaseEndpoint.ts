import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";

function configuredReleaseSecret(): string | null {
  const value = process.env.FINANCIAL_SHADOW_WEBHOOK_SECRET?.trim();
  return value || null;
}

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Reserves the AP-owned release endpoint identifier used by all-family release
 * manifests. It is deliberately unavailable for all live write actions: it does
 * not instantiate a Xero client, a VTiger writer or a scheduler.
 */
export function registerDisabledFinancialReleaseEndpoint(app: Express): void {
  app.post("/api/financial-workflows/release/:family", serveDisabledFinancialRelease);
}

export function serveDisabledFinancialRelease(req: Request, res: Response): void {
  const expectedSecret = configuredReleaseSecret();
  const suppliedSecret = typeof req.header("x-financial-shadow-secret") === "string"
    ? req.header("x-financial-shadow-secret")!
    : "";
  if (!expectedSecret || !secureEquals(suppliedSecret, expectedSecret)) {
    res.status(401).json({ error: "Unauthorized financial release request" });
    return;
  }
  res.status(503).json({
    error: "Financial release writer is disabled",
    family: req.params.family,
    mode: "release_preparation_only",
    xeroWritePermitted: false,
    schedulesChanged: false,
    message: "This identifier is reserved for a future document-specific, separately approved activation. No financial operation was performed.",
  });
}
