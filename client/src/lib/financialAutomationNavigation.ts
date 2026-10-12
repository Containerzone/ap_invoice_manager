export const FINANCIAL_AUTOMATION_TABS = [
  {
    value: "storage",
    label: "VTiger → Xero Storage",
    description: "Initial storage, monthly billing and finalisation",
    legacyPath: "/storage-automation",
  },
  {
    value: "hire-pos",
    label: "Container Hire POs",
    description: "Initial For Hire supplier POs and extension readiness",
    legacyPath: "/container-hire-pos",
  },
  {
    value: "asset-pos",
    label: "Container Asset POs",
    description: "Asset Container Control supplier POs",
    legacyPath: "/container-asset-pos",
  },
  {
    value: "customer-sale-pos",
    label: "Customer Sale POs",
    description: "Customer Sale Container Control supplier POs",
    legacyPath: "/container-customer-sale-pos",
  },
  {
    value: "main-invoices",
    label: "Main Customer Invoices",
    description: "Main customer invoice tracking and release state",
    legacyPath: "/main-customer-invoices",
  },
  {
    value: "deposit-invoices",
    label: "Deposit Invoices",
    description: "Deposit invoice tracking and release state",
    legacyPath: "/deposit-invoices",
  },
  {
    value: "final-weight",
    label: "Final Weight Adjustments",
    description: "Overweight and underweight Draft amendment tracking",
    legacyPath: "/final-weight-adjustments",
  },
  {
    value: "extra-hire",
    label: "Extra Hire Invoices",
    description: "Additional hire-period customer invoice tracking",
    legacyPath: "/extra-hire-invoices",
  },
  {
    value: "warranty-aviso",
    label: "Warranty & Aviso",
    description: "Warranty reconciliation and Aviso workflow readiness",
    legacyPath: "/warranty-aviso",
  },
] as const;

export type FinancialAutomationTab = (typeof FINANCIAL_AUTOMATION_TABS)[number]["value"];

const tabValues = new Set<string>(FINANCIAL_AUTOMATION_TABS.map((tab) => tab.value));

export function isFinancialAutomationTab(value: string | null): value is FinancialAutomationTab {
  return Boolean(value && tabValues.has(value));
}

export function financialAutomationTabFromSearch(search: string): FinancialAutomationTab {
  const value = new URLSearchParams(search).get("tab");
  return isFinancialAutomationTab(value) ? value : "storage";
}

export function financialAutomationPath(tab: FinancialAutomationTab): string {
  return `/financial-automation?tab=${tab}`;
}

export function financialAutomationTabFromLegacyPath(path: string): FinancialAutomationTab | null {
  return FINANCIAL_AUTOMATION_TABS.find((tab) => tab.legacyPath === path)?.value ?? null;
}
