import { describeVtigerFinancialModule } from "./vtigerFinancialReadService";

export const FINANCIAL_POST_SUCCESS_MAPPING_CONFIG_KEY = "financial-automation.vtiger-post-success-readiness" as const;

export type DisabledPostSuccessMapping = {
  enabled: false;
  assignedUserId: string | null;
  notes: { enabled: false; module: "ModComments"; recordLinkField: "related_to"; commentField: "commentcontent" };
  tasks: { enabled: false; module: "Calendar"; recordLinkField: "parent_id"; subjectField: "subject"; dueDateField: "due_date" };
  hireEndUpdate: { enabled: false; module: "Potentials"; fieldName: "cf_potentials_hireenddate" };
};

export const DEFAULT_DISABLED_POST_SUCCESS_MAPPING: DisabledPostSuccessMapping = {
  enabled: false,
  assignedUserId: null,
  notes: { enabled: false, module: "ModComments", recordLinkField: "related_to", commentField: "commentcontent" },
  tasks: { enabled: false, module: "Calendar", recordLinkField: "parent_id", subjectField: "subject", dueDateField: "due_date" },
  hireEndUpdate: { enabled: false, module: "Potentials", fieldName: "cf_potentials_hireenddate" },
};

function pickText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Filters unknown configuration so every future write flag remains false. */
export function resolveDisabledPostSuccessMapping(value: unknown): DisabledPostSuccessMapping {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const assignedUserId = pickText(candidate.assignedUserId);
  return { ...DEFAULT_DISABLED_POST_SUCCESS_MAPPING, assignedUserId };
}

export type DisabledPostSuccessMappingReadiness = {
  configuration: DisabledPostSuccessMapping;
  outcome: "passed" | "held" | "blocked";
  readOnly: true;
  modules: Array<{ module: string; requiredFields: string[]; missingFields: string[] }>;
  assignedUser: { configured: boolean; formatValid: boolean; message: string };
  message: string;
};

/**
 * Validates field names via GET describe calls only. It never retrieves or
 * modifies a CRM note/task/Hire End Date, and cannot flip post-success flags.
 */
export async function validateDisabledPostSuccessMapping(value: unknown): Promise<DisabledPostSuccessMappingReadiness> {
  const configuration = resolveDisabledPostSuccessMapping(value);
  const requirements = [
    { module: configuration.notes.module, requiredFields: [configuration.notes.recordLinkField, configuration.notes.commentField] },
    { module: configuration.tasks.module, requiredFields: [configuration.tasks.recordLinkField, configuration.tasks.subjectField, configuration.tasks.dueDateField] },
    { module: configuration.hireEndUpdate.module, requiredFields: [configuration.hireEndUpdate.fieldName] },
  ];
  try {
    const modules = await Promise.all(requirements.map(async (requirement) => {
      const metadata = await describeVtigerFinancialModule(requirement.module);
      const available = new Set(metadata.fields.map((field) => field.toLowerCase()));
      return { module: requirement.module, requiredFields: requirement.requiredFields, missingFields: requirement.requiredFields.filter((field) => !available.has(field.toLowerCase())) };
    }));
    const formatValid = configuration.assignedUserId === null || /^\d+x\d+$/i.test(configuration.assignedUserId);
    const fieldsValid = modules.every((module) => module.missingFields.length === 0);
    const assignedConfigured = Boolean(configuration.assignedUserId);
    const outcome = fieldsValid && formatValid && assignedConfigured ? "passed" : "held";
    return {
      configuration, outcome, readOnly: true, modules,
      assignedUser: { configured: assignedConfigured, formatValid, message: !assignedConfigured ? "A VTiger AP assigned-user webservice ID is still required." : formatValid ? "Assigned-user ID format is valid; it remains disabled." : "Assigned-user ID must use VTiger moduleId x recordId format." },
      message: outcome === "passed" ? "Disabled mapping field names and assigned-user format are ready. Notes, tasks and Hire End Date updates remain disabled." : "Disabled mapping is held until required metadata fields and an AP assigned-user ID are verified. No CRM write was attempted.",
    };
  } catch (error) {
    return {
      configuration, outcome: "blocked", readOnly: true, modules: requirements.map((requirement) => ({ module: requirement.module, requiredFields: requirement.requiredFields, missingFields: requirement.requiredFields })),
      assignedUser: { configured: Boolean(configuration.assignedUserId), formatValid: configuration.assignedUserId === null || /^\d+x\d+$/i.test(configuration.assignedUserId), message: "Metadata was not verified." },
      message: error instanceof Error ? error.message : "VTiger GET-only metadata validation was not completed.",
    };
  }
}
