import type { ProposedFinancialDocument } from "./financialWorkflowEngine";

export type PlannedFinancialPostSuccessAction = {
  actionType: "vtiger_note" | "vtiger_task" | "vtiger_hire_end_update";
  safePayloadSummary: Record<string, unknown>;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function plusCalendarDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Chooses only the explicitly approved AP-owned VTiger follow-up work. The
 * Xero writer supplies the verified Draft ID/number later; this function never
 * invokes a transport or infers a CRM action for other workflow families.
 */
export function planFinancialPostSuccessActions(input: {
  workflowType: string;
  document: ProposedFinancialDocument;
  sourceData: Record<string, unknown>;
}): PlannedFinancialPostSuccessAction[] {
  const documentNumber = input.document.proposedDocumentNumber ?? null;
  const common = {
    documentNumber,
    workflowType: input.workflowType,
  };

  switch (input.workflowType) {
    case "storage_activation":
    case "recurring_storage":
      return [{
        actionType: "vtiger_note",
        safePayloadSummary: {
          ...common,
          purpose: input.workflowType === "storage_activation" ? "storage_activation_note" : "recurring_storage_note",
          storageLocation: text(input.sourceData.storageStage) ?? text(input.sourceData.location),
        },
      }];
    case "storage_finalisation": {
      const actions: PlannedFinancialPostSuccessAction[] = [{
        actionType: "vtiger_note",
        safePayloadSummary: { ...common, purpose: "storage_finalisation_note" },
      }];
      const dateOut = asDate(input.sourceData.dateOut);
      const stage = text(input.sourceData.stage) ?? text(input.sourceData.storageStage) ?? "";
      if (dateOut && /^[456]/.test(stage.trim())) {
        actions.push({
          actionType: "vtiger_task",
          safePayloadSummary: {
            ...common,
            purpose: "finalise_storage_invoice_task",
            taskSubject: "Finalise Storage Invoice",
            dueDate: isoDate(dateOut),
          },
        });
      }
      return actions;
    }
    case "extra_hire": {
      const currentHireEnd = asDate(input.sourceData.hireEndDate);
      if (!currentHireEnd) return [];
      return [{
        actionType: "vtiger_hire_end_update",
        safePayloadSummary: {
          ...common,
          purpose: "extra_hire_end_date_update",
          nextHireEndDate: isoDate(plusCalendarDays(currentHireEnd, 30)),
        },
      }];
    }
    default:
      return [];
  }
}
