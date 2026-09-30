export type FinancialOperationsTab =
  | "overview"
  | "po"
  | "invoices"
  | "runs"
  | "exceptions"
  | "schedules"
  | "candidate-finder"
  | "shadow-tests"
  | "proposal-approvals"
  | "history-preview"
  | "configuration"
  | "webhook-interface"
  | "cutover-centre"
  | "release-readiness";

export type FinancialOperationsParentArea =
  | "dashboard"
  | "documents"
  | "review"
  | "controls";

export type FinancialOperationsChildTab = {
  value: FinancialOperationsTab;
  label: string;
  adminOnly?: boolean;
};

export type FinancialOperationsNavigationGroup = {
  value: FinancialOperationsParentArea;
  label: string;
  description: string;
  tabs: readonly FinancialOperationsChildTab[];
};

/**
 * All financial feature pages live beneath one sidebar parent: Financial
 * Operations. These groups are an in-workspace hierarchy only; they do not
 * create routes, new browser tabs, schedules or live financial actions.
 */
export const FINANCIAL_OPERATIONS_NAVIGATION: readonly FinancialOperationsNavigationGroup[] = [
  {
    value: "dashboard",
    label: "1. Dashboard",
    description: "Financial automation status and safeguards",
    tabs: [
      { value: "overview", label: "Overview" },
    ],
  },
  {
    value: "documents",
    label: "2. Document Operations",
    description: "Proposed financial documents and their source runs",
    tabs: [
      { value: "po", label: "PO Operations" },
      { value: "invoices", label: "Customer Invoices" },
      { value: "runs", label: "Trigger Runs" },
    ],
  },
  {
    value: "review",
    label: "3. Review & Evidence",
    description: "Exceptions, named candidates and evidence-only validation",
    tabs: [
      { value: "exceptions", label: "Exceptions" },
      { value: "candidate-finder", label: "Candidate Roster", adminOnly: true },
      { value: "shadow-tests", label: "Shadow Test Register", adminOnly: true },
      { value: "proposal-approvals", label: "Proposal Approvals", adminOnly: true },
      { value: "history-preview", label: "Historical Preview", adminOnly: true },
    ],
  },
  {
    value: "controls",
    label: "4. Controls",
    description: "Disabled schedule intent and non-secret automation settings",
    tabs: [
      { value: "schedules", label: "Schedules" },
      { value: "configuration", label: "Automation Settings", adminOnly: true },
      { value: "webhook-interface", label: "Trigger Dashboard", adminOnly: true },
      { value: "cutover-centre", label: "Cutover Control Centre", adminOnly: true },
      { value: "release-readiness", label: "All-Family Release", adminOnly: true },
    ],
  },
] as const;

export function getFinancialOperationsGroup(value: FinancialOperationsParentArea): FinancialOperationsNavigationGroup {
  const group = FINANCIAL_OPERATIONS_NAVIGATION.find((item) => item.value === value);
  if (!group) throw new Error(`Unknown Financial Operations parent area: ${value}`);
  return group;
}

export function isFinancialOperationsTabAvailable(tab: FinancialOperationsChildTab, isAdmin: boolean): boolean {
  return !tab.adminOnly || isAdmin;
}

export function firstAvailableFinancialOperationsTab(
  group: FinancialOperationsNavigationGroup,
  isAdmin: boolean,
): FinancialOperationsTab {
  const tab = group.tabs.find((item) => isFinancialOperationsTabAvailable(item, isAdmin));
  if (!tab) throw new Error(`No available Financial Operations tab in ${group.value}`);
  return tab.value;
}
