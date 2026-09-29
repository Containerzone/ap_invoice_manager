import type { FinancialWorkflowType } from "./financialWorkflowEngine";

export const FINANCIAL_AP_WEBHOOK_SECRET_ENV = "FINANCIAL_AP_WEBHOOK_SECRET" as const;
export const FINANCIAL_WEBHOOK_CONTROL_CONFIG_KEY = "financial-automation.webhook-controls" as const;

export type FinancialWebhookRouteKey =
  | "container-control-acquisition"
  | "recurring-for-hire"
  | "storage-origin-activation"
  | "storage-destination-activation"
  | "recurring-storage"
  | "storage-finalisation"
  | "main-customer-invoice"
  | "deposit-invoice"
  | "overweight-adjustment"
  | "underweight-due-date"
  | "extra-hire"
  | "warranty-reconciliation";

export type FinancialWebhookRoute = {
  key: FinancialWebhookRouteKey;
  path: string;
  displayName: string;
  workflowType: FinancialWorkflowType;
  sourceEntityTypes: readonly string[];
  fixedFields?: Record<string, unknown>;
  schedule: "event" | "future_schedule";
  description: string;
};

/**
 * All routes are AP-owned, authenticated financial interfaces. They retain
 * proposal-only operation by default and must not be pasted into VTiger until
 * the matching family has a separately approved external handoff.
 */
export const FINANCIAL_AP_WEBHOOK_ROUTES: readonly FinancialWebhookRoute[] = [
  {
    key: "container-control-acquisition",
    path: "/api/financial-workflows/events/container-control-acquisition",
    displayName: "Container Control acquisition",
    workflowType: "container_control_acquisition",
    sourceEntityTypes: ["container_control"],
    schedule: "event",
    description: "Asset, customer-sale and initial For Hire proposal branches from a Container Control event.",
  },
  {
    key: "recurring-for-hire",
    path: "/api/financial-workflows/events/recurring-for-hire",
    displayName: "Recurring For Hire",
    workflowType: "recurring_for_hire",
    sourceEntityTypes: ["container_control"],
    schedule: "future_schedule",
    description: "Reserved for the later approved monthly AP schedule; no schedule is registered in this phase.",
  },
  {
    key: "storage-origin-activation",
    path: "/api/financial-workflows/events/storage-origin-activation",
    displayName: "Origin storage activation",
    workflowType: "storage_activation",
    sourceEntityTypes: ["deal", "container_control"],
    fixedFields: { storageStage: "ORIGIN" },
    schedule: "event",
    description: "Origin storage customer-invoice/JD/GD proposal branch.",
  },
  {
    key: "storage-destination-activation",
    path: "/api/financial-workflows/events/storage-destination-activation",
    displayName: "Destination storage activation",
    workflowType: "storage_activation",
    sourceEntityTypes: ["deal", "container_control"],
    fixedFields: { storageStage: "DESTINATION" },
    schedule: "event",
    description: "Destination storage customer-invoice/JD/GD proposal branch.",
  },
  {
    key: "recurring-storage",
    path: "/api/financial-workflows/events/recurring-storage",
    displayName: "Recurring storage",
    workflowType: "recurring_storage",
    sourceEntityTypes: ["deal", "container_control"],
    schedule: "future_schedule",
    description: "Reserved for the later approved monthly AP schedule; recurring JD proposals remain excluded.",
  },
  {
    key: "storage-finalisation",
    path: "/api/financial-workflows/events/storage-finalisation",
    displayName: "Storage finalisation",
    workflowType: "storage_finalisation",
    sourceEntityTypes: ["storage_billing_event", "deal", "container_control"],
    schedule: "event",
    description: "Draft-only storage finalisation or controlled-recovery proposal branch.",
  },
  {
    key: "main-customer-invoice",
    path: "/api/financial-workflows/events/main-customer-invoice",
    displayName: "Main customer invoice",
    workflowType: "main_customer_invoice",
    sourceEntityTypes: ["deal"],
    schedule: "event",
    description: "Quote-service invoice proposal from a named Deal event.",
  },
  {
    key: "deposit-invoice",
    path: "/api/financial-workflows/events/deposit-invoice",
    displayName: "Deposit invoice",
    workflowType: "deposit_invoice",
    sourceEntityTypes: ["deal"],
    schedule: "event",
    description: "Pending deposit invoice proposal from a named Deal event.",
  },
  {
    key: "overweight-adjustment",
    path: "/api/financial-workflows/events/overweight-adjustment",
    displayName: "Final weight — overweight",
    workflowType: "final_weight_adjustment",
    sourceEntityTypes: ["deal"],
    fixedFields: { weightDirection: "OVERWEIGHT" },
    schedule: "event",
    description: "Draft-only main invoice overweight adjustment proposal.",
  },
  {
    key: "underweight-due-date",
    path: "/api/financial-workflows/events/underweight-due-date",
    displayName: "Final weight — underweight",
    workflowType: "final_weight_adjustment",
    sourceEntityTypes: ["deal"],
    fixedFields: { weightDirection: "UNDERWEIGHT" },
    schedule: "event",
    description: "Draft-only due-date adjustment proposal; never creates a negative line.",
  },
  {
    key: "extra-hire",
    path: "/api/financial-workflows/events/extra-hire",
    displayName: "Extra Hire",
    workflowType: "extra_hire",
    sourceEntityTypes: ["deal"],
    schedule: "event",
    description: "Eligible 30-day extra-hire invoice proposal; source dates are never rolled forward here.",
  },
  {
    key: "warranty-reconciliation",
    path: "/api/financial-workflows/events/warranty-reconciliation",
    displayName: "Warranty reconciliation",
    workflowType: "warranty_reconciliation",
    sourceEntityTypes: ["deal"],
    schedule: "event",
    description: "Added Services warranty customer-invoice/Aviso-PO proposal branch.",
  },
] as const;

export function getFinancialWebhookRoute(key: string | undefined): FinancialWebhookRoute | undefined {
  return FINANCIAL_AP_WEBHOOK_ROUTES.find((route) => route.key === key);
}

export type FinancialWebhookEnvelope = {
  apiVersion: "2026-09-29";
  /** Normalized request intent: proposal/dry-run means no write; execution is gate-protected. */
  mode: "proposal" | "dry_run" | "execution";
  /** Explicit compatibility flag. Omitted/false requests gate-protected execution. */
  dryRun: boolean;
  /** Required for an execution request; binds the event to one exact approval. */
  executionApprovalId?: number;
  eventId: string;
  eventType: string;
  sourceSystem: "VTiger";
  sourceEntityType: string;
  sourceRecordId: string;
  sourceRecordNumber?: string;
  sourceChangedAt?: string;
  data: Record<string, unknown>;
};

export type FinancialWebhookControls = {
  apiVersion: 1;
  globalPaused: boolean;
  familyPaused: Partial<Record<FinancialWebhookRouteKey, boolean>>;
};

export const DEFAULT_FINANCIAL_WEBHOOK_CONTROLS: FinancialWebhookControls = {
  apiVersion: 1,
  globalPaused: false,
  familyPaused: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, limit: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= limit ? value.trim() : null;
}

export function parseFinancialWebhookEnvelope(value: unknown): FinancialWebhookEnvelope | { error: string } {
  if (!isRecord(value)) return { error: "JSON body is required." };
  const apiVersion = value.apiVersion;
  const mode = value.mode;
  const requestedDryRun = value.dryRun;
  const executionApprovalId = value.executionApprovalId;
  const eventId = safeText(value.eventId, 160);
  const eventType = safeText(value.eventType, 100);
  const sourceSystem = value.sourceSystem;
  const sourceEntityType = safeText(value.sourceEntityType, 80);
  const sourceRecordId = safeText(value.sourceRecordId, 128);
  const sourceRecordNumber = value.sourceRecordNumber === undefined ? undefined : safeText(value.sourceRecordNumber, 128);
  const sourceChangedAt = value.sourceChangedAt === undefined ? undefined : safeText(value.sourceChangedAt, 64);
  const data = value.data;
  if (apiVersion !== "2026-09-29") return { error: "apiVersion must be 2026-09-29." };
  if (mode !== undefined && mode !== "proposal" && mode !== "dry_run") return { error: "mode may only be proposal or dry_run; live mode is not supported." };
  if (requestedDryRun !== undefined && typeof requestedDryRun !== "boolean") return { error: "dryRun must be a boolean when provided." };
  const dryRun = mode === "proposal" || mode === "dry_run" || requestedDryRun === true;
  if ((mode === "proposal" || mode === "dry_run") && requestedDryRun === false) {
    return { error: "mode=proposal/dry_run cannot be combined with dryRun=false." };
  }
  if (!dryRun && executionApprovalId !== undefined && (!Number.isInteger(executionApprovalId) || Number(executionApprovalId) <= 0)) {
    return { error: "executionApprovalId must be a positive integer when supplied for a non-dry execution request." };
  }
  if (dryRun && executionApprovalId !== undefined) {
    return { error: "executionApprovalId is only accepted when dryRun is false or omitted." };
  }
  if (!eventId || !eventType || sourceSystem !== "VTiger" || !sourceEntityType || !sourceRecordId || !isRecord(data)) {
    return { error: "eventId, eventType, sourceSystem=VTiger, sourceEntityType, sourceRecordId and data are required." };
  }
  if (sourceChangedAt && Number.isNaN(new Date(sourceChangedAt).getTime())) return { error: "sourceChangedAt must be a valid ISO timestamp when provided." };
  return {
    apiVersion,
    mode: dryRun ? (mode === "dry_run" ? "dry_run" : "proposal") : "execution",
    dryRun,
    executionApprovalId: dryRun || executionApprovalId === undefined ? undefined : Number(executionApprovalId),
    eventId,
    eventType,
    sourceSystem,
    sourceEntityType,
    sourceRecordId,
    sourceRecordNumber: sourceRecordNumber ?? undefined,
    sourceChangedAt: sourceChangedAt ?? undefined,
    data,
  };
}

export function resolveFinancialWebhookControls(value: unknown): FinancialWebhookControls {
  if (!isRecord(value)) return { ...DEFAULT_FINANCIAL_WEBHOOK_CONTROLS };
  const familyPaused = isRecord(value.familyPaused)
    ? Object.fromEntries(
      Object.entries(value.familyPaused)
        .filter(([key, paused]) => Boolean(getFinancialWebhookRoute(key)) && typeof paused === "boolean")
        .map(([key, paused]) => [key, paused]),
    ) as FinancialWebhookControls["familyPaused"]
    : {};
  return {
    apiVersion: 1,
    globalPaused: value.globalPaused === true,
    familyPaused,
  };
}

export function isFinancialWebhookPaused(
  routeKey: FinancialWebhookRouteKey,
  controls: FinancialWebhookControls,
): boolean {
  return controls.globalPaused || controls.familyPaused[routeKey] === true;
}
