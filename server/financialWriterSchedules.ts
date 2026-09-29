export type DisabledFinancialWriterSchedule = {
  workflowType: "recurring_for_hire" | "recurring_storage";
  familyKey: "recurring_for_hire" | "recurring_storage";
  endpointPath: string;
  cadence: string;
  state: "disabled";
  reason: string;
};

/**
 * Managed-schedule definitions only. This array neither creates a Heartbeat
 * job nor registers an in-process timer. The two exact AP endpoints are kept
 * disabled until a document-specific cutover grants one family at a time.
 */
export const DISABLED_FINANCIAL_WRITER_SCHEDULES: readonly DisabledFinancialWriterSchedule[] = [
  {
    workflowType: "recurring_for_hire",
    familyKey: "recurring_for_hire",
    endpointPath: "/api/scheduled/financial-writer/recurring_for_hire",
    cadence: "0 0 0 1 * *",
    state: "disabled",
    reason: "No Heartbeat job exists. The bounded selector is implemented but disabled; Sydney-date source selection, one-family cutover and an exact single-use approval are required before activation.",
  },
  {
    workflowType: "recurring_storage",
    familyKey: "recurring_storage",
    endpointPath: "/api/scheduled/financial-writer/recurring_storage",
    cadence: "0 5 13 * * *",
    state: "disabled",
    reason: "No Heartbeat job exists. The bounded selector is implemented but disabled; the handler may process only the first Sydney calendar day after one-family cutover and exact approval.",
  },
] as const;

export function getDisabledFinancialWriterSchedule(
  workflowType: string,
  familyKey?: string,
): DisabledFinancialWriterSchedule | undefined {
  return DISABLED_FINANCIAL_WRITER_SCHEDULES.find((entry) =>
    entry.workflowType === workflowType && (!familyKey || entry.familyKey === familyKey),
  );
}
