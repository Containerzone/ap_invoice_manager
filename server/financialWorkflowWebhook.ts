import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { FINANCIAL_WORKFLOW_TYPES, type FinancialWorkflowType } from "./financialWorkflowEngine";
import { evaluateAndPersistFinancialWorkflow } from "./financialWorkflowService";

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function configuredShadowWebhookSecret(): string | null {
  const secret = process.env.FINANCIAL_SHADOW_WEBHOOK_SECRET?.trim();
  return secret || null;
}

/** Configuration presence only; neither the secret nor any credential is exposed. */
export function getFinancialShadowWebhookStatus() {
  return {
    configured: Boolean(configuredShadowWebhookSecret()),
    endpointPath: "/api/financial-workflows/shadow-events",
    acceptedModes: ["shadow", "dry_run"] as const,
    xeroWritePermitted: false as const,
  };
}

function isWorkflowType(value: unknown): value is FinancialWorkflowType {
  return typeof value === "string" && (FINANCIAL_WORKFLOW_TYPES as readonly string[]).includes(value);
}

function declaredMode(body: Record<string, unknown>): boolean {
  return body.mode === "shadow" || body.mode === "dry_run";
}

/**
 * Independent AP endpoint for authenticated test events only. It never reads or
 * modifies Operations/CRM configuration, schedules, or Xero documents.
 */
export function registerFinancialWorkflowShadowWebhook(app: Express): void {
  app.post("/api/financial-workflows/shadow-events", async (req: Request, res: Response) => {
    const expectedSecret = configuredShadowWebhookSecret();
    const suppliedSecret = typeof req.header("x-financial-shadow-secret") === "string"
      ? req.header("x-financial-shadow-secret")!
      : "";
    if (!expectedSecret || !secureEquals(suppliedSecret, expectedSecret)) {
      res.status(401).json({ error: "Unauthorized shadow event" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!declaredMode(body) || !isWorkflowType(body.workflowType)) {
      res.status(400).json({ error: "workflowType and mode=shadow are required" });
      return;
    }
    if (!body.sourceData || typeof body.sourceData !== "object" || Array.isArray(body.sourceData)) {
      res.status(400).json({ error: "sourceData object is required" });
      return;
    }

    try {
      const result = await evaluateAndPersistFinancialWorkflow({
        workflowType: body.workflowType,
        triggerType: "webhook",
        sourceRecordId: typeof body.sourceRecordId === "string" ? body.sourceRecordId : undefined,
        sourceRecordNumber: typeof body.sourceRecordNumber === "string" ? body.sourceRecordNumber : undefined,
        sourceRecordType: typeof body.sourceRecordType === "string" ? body.sourceRecordType : undefined,
        idempotencySalt: typeof body.eventId === "string" ? body.eventId : undefined,
        sourceData: body.sourceData as Record<string, unknown>,
        existingDocumentNumbers: Array.isArray(body.existingDocumentNumbers)
          ? body.existingDocumentNumbers.filter((entry): entry is string => typeof entry === "string")
          : undefined,
      });
      res.status(result.persistence.duplicate ? 200 : 201).json({
        mode: "shadow",
        xeroWritePermitted: false,
        runId: result.persistence.runId,
        duplicate: result.persistence.duplicate,
        outcome: result.evaluation.outcome,
        proposedDocumentNumbers: result.evaluation.intents.map((intent) => intent.proposedDocumentNumber),
        issueCount: result.evaluation.issues.length,
      });
    } catch (error: any) {
      console.error("[FinancialShadowWebhook] evaluation failed:", error?.message ?? error);
      res.status(500).json({ error: "Financial shadow evaluation failed" });
    }
  });
}
