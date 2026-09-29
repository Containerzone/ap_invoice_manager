import { timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import {
  FINANCIAL_AP_WEBHOOK_ROUTES,
  FINANCIAL_AP_WEBHOOK_SECRET_ENV,
  getFinancialWebhookRoute,
  parseFinancialWebhookEnvelope,
} from "./financialWebhookContracts";
import {
  evaluateFinancialWebhookProposal,
  financialWebhookPayloadFingerprint,
} from "./financialProposalWebhookService";
import {
  createFinancialWebhookEvent,
  getFinancialWebhookEventByEventId,
  updateFinancialWebhookEventOutcome,
} from "./financialWebhookEventDb";
import { executeApprovedFinancialDraft } from "./financialLiveExecutionService";
import { FinancialWriteDisabledError } from "./financialProductionWriter";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

function secureEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function configuredWebhookSecret(): string | null {
  return process.env[FINANCIAL_AP_WEBHOOK_SECRET_ENV]?.trim() || null;
}

function suppliedWebhookSecret(req: Request): string {
  return req.header("x-financial-webhook-secret")?.trim() ?? "";
}

function safeEventResponse(input: {
  eventId: string;
  routeKey: string;
  status: string;
  workflowRunId?: number | null;
  issueCount?: number;
  proposedDocuments?: Array<Record<string, unknown>>;
  duplicate?: boolean;
  mode?: "proposal_only" | "held" | "draft_execution";
  financialWritePermitted?: boolean;
  xeroWriteMethodsCalled?: string[];
  execution?: Record<string, unknown>;
}) {
  return {
    accepted: true,
    mode: input.mode ?? "proposal_only",
    financialWritePermitted: input.financialWritePermitted ?? false,
    xeroWriteMethodsCalled: input.xeroWriteMethodsCalled ?? [],
    schedulesRegistered: false as const,
    sourceSystemsChanged: false as const,
    ...input,
  };
}

/** Configuration presence only; no secret or writable target details are returned. */
export function getFinancialProposalWebhookStatus() {
  return {
    configured: Boolean(configuredWebhookSecret()),
    headerName: "X-Financial-Webhook-Secret",
    mode: "guarded_execution" as const,
    financialWritePermitted: false as const,
    schedulesRegistered: false as const,
    endpointPath: FINANCIAL_AP_WEBHOOK_ROUTES[0]?.path ?? null,
    routes: FINANCIAL_AP_WEBHOOK_ROUTES.map((route) => ({
      key: route.key,
      path: route.path,
      displayName: route.displayName,
      workflowType: route.workflowType,
      schedule: route.schedule,
    })),
  };
}

/**
 * Registers fixed AP-only routes. Dry-run requests map each event into an
 * audited proposal. Execution requests may reach the guarded server-only Draft
 * coordinator only after the same proposal is revalidated and every release
 * gate is satisfied; a failed gate returns Held before an external write.
 */
export function registerFinancialProposalWebhook(app: Express): void {
  for (const route of FINANCIAL_AP_WEBHOOK_ROUTES) {
    app.post(route.path, async (req: Request, res: Response) => {
      const expectedSecret = configuredWebhookSecret();
      if (!expectedSecret) {
        res.status(503).json({ error: "AP financial webhook is not configured." });
        return;
      }
      if (!secureEquals(suppliedWebhookSecret(req), expectedSecret)) {
        res.status(401).json({ error: "Unauthorized AP financial webhook event." });
        return;
      }

      const parsed = parseFinancialWebhookEnvelope(req.body);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      const envelope = parsed;
      const existing = await getFinancialWebhookEventByEventId(envelope.eventId);
      if (existing) {
        res.status(200).json(safeEventResponse({
          eventId: envelope.eventId,
          routeKey: route.key,
          status: "duplicate",
          workflowRunId: existing.workflowRunId,
          duplicate: true,
        }));
        return;
      }

      try {
        const result = await evaluateFinancialWebhookProposal({ routeKey: route.key, payload: envelope });
        const event = await createFinancialWebhookEvent({
          eventId: envelope.eventId,
          routeKey: route.key,
          workflowType: route.workflowType,
          sourceSystem: "vtiger",
          sourceEntityType: envelope.sourceEntityType,
          sourceRecordId: envelope.sourceRecordId,
          sourceRecordNumber: envelope.sourceRecordNumber ?? null,
          sourceChangedAt: envelope.sourceChangedAt ? new Date(envelope.sourceChangedAt) : null,
          payloadFingerprint: financialWebhookPayloadFingerprint(route, envelope),
          status: result.status,
          workflowRunId: result.workflowRunId,
          safeSummary: result.safeSummary,
        });
        if (event.duplicate) {
          res.status(200).json(safeEventResponse({
            eventId: envelope.eventId,
            routeKey: route.key,
            status: "duplicate",
            workflowRunId: event.event.workflowRunId,
            duplicate: true,
          }));
          return;
        }
        if (result.status === "held") {
          reportWorkflowFailureSafely({
            workflowType: "financial-webhook-proposal",
            recordKey: `financial-webhook:${route.key}:${envelope.sourceRecordId}`,
            title: `Financial webhook proposal held — ${route.displayName}`,
            errorMessage: "The authenticated event was received but required financial data or validation was incomplete.",
            details: {
              routeKey: route.key,
              sourceEntityType: envelope.sourceEntityType,
              sourceRecordNumber: envelope.sourceRecordNumber ?? null,
              issueCount: result.issueCount,
              proposalOnly: true,
            },
            severity: "error",
          });
        }
        if (result.status !== "proposed" || envelope.dryRun) {
          res.status(result.status === "proposed" ? 201 : 202).json(safeEventResponse({
            eventId: envelope.eventId,
            routeKey: route.key,
            status: result.status,
            workflowRunId: result.workflowRunId,
            issueCount: result.issueCount,
            proposedDocuments: result.proposedDocuments,
          }));
          return;
        }

        if (!envelope.executionApprovalId) {
          const message = "Financial Draft execution is held because this non-dry event did not name an exact document-specific approval.";
          await updateFinancialWebhookEventOutcome({
            eventId: envelope.eventId,
            status: "held",
            safeSummary: { ...result.safeSummary, executionState: "held_missing_execution_approval" },
            errorMessage: message,
          });
          reportWorkflowFailureSafely({
            workflowType: "financial-draft-execution",
            recordKey: `financial-webhook-execution:${route.key}:${envelope.sourceRecordId}`,
            title: `Financial Draft execution held — ${route.displayName}`,
            errorMessage: message,
            details: { routeKey: route.key, sourceRecordNumber: envelope.sourceRecordNumber ?? null, heldBeforeXero: true },
            severity: "error",
          });
          res.status(202).json(safeEventResponse({
            eventId: envelope.eventId,
            routeKey: route.key,
            status: "held",
            workflowRunId: result.workflowRunId,
            issueCount: result.issueCount,
            proposedDocuments: result.proposedDocuments,
            mode: "held",
          }));
          return;
        }

        // Non-dry events still do not trust the event body. The coordinator
        // independently refreshes the exact VTiger source and Xero preflight,
        // checks all deployment/release gates and consumes the single-use
        // approval immediately before the Draft-only transport.
        try {
          const execution = await executeApprovedFinancialDraft({
            approvalId: envelope.executionApprovalId!,
            expectedWorkflowType: route.workflowType,
            expectedSourceRecordId: envelope.sourceRecordId,
          });
          const held = execution.outcome.outcome === "reconciliation_required";
          const reconciliationError = execution.outcome.outcome === "reconciliation_required"
            ? execution.outcome.error
            : null;
          await updateFinancialWebhookEventOutcome({
            eventId: envelope.eventId,
            status: held ? "held" : "proposed",
            safeSummary: {
              ...result.safeSummary,
              executionState: execution.outcome.outcome,
              executionId: execution.outcome.executionId,
              postSuccessState: execution.postSuccess.outcome,
            },
            errorMessage: reconciliationError,
          });
          res.status(held ? 202 : 200).json(safeEventResponse({
            eventId: envelope.eventId,
            routeKey: route.key,
            status: held ? "reconciliation_required" : execution.outcome.outcome,
            workflowRunId: result.workflowRunId,
            issueCount: result.issueCount,
            proposedDocuments: result.proposedDocuments,
            mode: held ? "held" : "draft_execution",
            financialWritePermitted: !held,
            xeroWriteMethodsCalled: held ? [] : ["Draft-only guarded transport"],
            execution: {
              executionId: execution.outcome.executionId,
              outcome: execution.outcome.outcome,
              postSuccess: execution.postSuccess.outcome,
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const held = error instanceof FinancialWriteDisabledError;
          await updateFinancialWebhookEventOutcome({
            eventId: envelope.eventId,
            status: held ? "held" : "failed",
            safeSummary: {
              ...result.safeSummary,
              executionState: held ? "held_before_xero" : "failed_before_completion",
            },
            errorMessage: message,
          }).catch(() => undefined);
          reportWorkflowFailureSafely({
            workflowType: "financial-draft-execution",
            recordKey: `financial-webhook-execution:${route.key}:${envelope.sourceRecordId}`,
            title: held ? `Financial Draft execution held — ${route.displayName}` : `Financial Draft execution failed — ${route.displayName}`,
            errorMessage: message,
            details: {
              routeKey: route.key,
              sourceRecordNumber: envelope.sourceRecordNumber ?? null,
              approvalId: envelope.executionApprovalId,
              heldBeforeXero: held,
            },
            severity: "error",
          });
          res.status(held ? 202 : 500).json(safeEventResponse({
            eventId: envelope.eventId,
            routeKey: route.key,
            status: held ? "held" : "failed",
            workflowRunId: result.workflowRunId,
            issueCount: result.issueCount,
            proposedDocuments: result.proposedDocuments,
            mode: held ? "held" : "draft_execution",
          }));
        }
      } catch (error: any) {
        const message = error?.message ?? "Financial proposal evaluation failed.";
        const rejected = /does not accept sourceEntityType|mode must be|apiVersion must be|is required\.$/.test(message);
        try {
          await createFinancialWebhookEvent({
            eventId: envelope.eventId,
            routeKey: route.key,
            workflowType: route.workflowType,
            sourceSystem: "vtiger",
            sourceEntityType: envelope.sourceEntityType,
            sourceRecordId: envelope.sourceRecordId,
            sourceRecordNumber: envelope.sourceRecordNumber ?? null,
            sourceChangedAt: envelope.sourceChangedAt ? new Date(envelope.sourceChangedAt) : null,
            payloadFingerprint: financialWebhookPayloadFingerprint(route, envelope),
            status: rejected ? "rejected" : "failed",
            errorMessage: message,
          });
        } catch (persistError: any) {
          console.error("[FinancialProposalWebhook] Could not persist failure evidence:", persistError?.message ?? persistError);
        }
        reportWorkflowFailureSafely({
          workflowType: "financial-webhook-proposal",
          recordKey: `financial-webhook:${route.key}:${envelope.sourceRecordId}`,
          title: `Financial webhook proposal failed — ${route.displayName}`,
          errorMessage: message,
          details: {
            routeKey: route.key,
            sourceEntityType: envelope.sourceEntityType,
            sourceRecordNumber: envelope.sourceRecordNumber ?? null,
            proposalOnly: true,
          },
          severity: "error",
        });
        res.status(rejected ? 400 : 500).json({ error: rejected ? message : "Financial proposal evaluation failed." });
      }
    });
  }
}

export function isKnownFinancialProposalRoute(path: string): boolean {
  return Boolean(FINANCIAL_AP_WEBHOOK_ROUTES.find((route) => route.path === path));
}

export { getFinancialWebhookRoute };
