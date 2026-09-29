import { FINANCIAL_RELEASE_FAMILIES } from "./financialReleaseManifest";

export type DisabledFinancialWriterSchedule = {
  workflowType: string;
  familyKey: string;
  endpointPath: string;
  cadence: string | null;
  state: "details_required" | "event_driven_only";
  reason: string;
};

/**
 * Documentation/configuration only. This array neither creates a Heartbeat job
 * nor registers an in-process timer. Explicit schedule details and a separate
 * document-specific approval are still required before a future activation.
 */
export const DISABLED_FINANCIAL_WRITER_SCHEDULES: readonly DisabledFinancialWriterSchedule[] = FINANCIAL_RELEASE_FAMILIES.map((family) => ({
  workflowType: family.workflowType,
  familyKey: family.familyKey,
  endpointPath: `/api/scheduled/financial-writer/${family.familyKey}`,
  cadence: family.apScheduleDefinition ?? null,
  state: family.apScheduleDefinition ? "details_required" : "event_driven_only",
  reason: family.apScheduleDefinition
    ? "No Heartbeat job exists. The business owner must provide the approved cadence and document-specific activation approval."
    : "This family is event-driven. No scheduled writer should be created.",
}));

export function getDisabledFinancialWriterSchedule(
  workflowType: string,
  familyKey?: string,
): DisabledFinancialWriterSchedule | undefined {
  return DISABLED_FINANCIAL_WRITER_SCHEDULES.find((entry) =>
    entry.workflowType === workflowType && (!familyKey || entry.familyKey === familyKey),
  );
}
