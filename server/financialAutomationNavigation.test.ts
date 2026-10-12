import { describe, expect, it } from "vitest";
import {
  FINANCIAL_AUTOMATION_TABS,
  financialAutomationPath,
  financialAutomationTabFromLegacyPath,
  financialAutomationTabFromSearch,
  isFinancialAutomationTab,
} from "../client/src/lib/financialAutomationNavigation";

describe("Financial Automations parent navigation", () => {
  it("keeps every former sidebar workflow as one ordered internal tab", () => {
    expect(FINANCIAL_AUTOMATION_TABS.map((tab) => tab.value)).toEqual([
      "storage",
      "hire-pos",
      "asset-pos",
      "customer-sale-pos",
      "main-invoices",
      "deposit-invoices",
      "final-weight",
      "extra-hire",
      "warranty-aviso",
    ]);
    expect(new Set(FINANCIAL_AUTOMATION_TABS.map((tab) => tab.legacyPath)).size).toBe(
      FINANCIAL_AUTOMATION_TABS.length
    );
  });

  it("selects a subtab from the parent URL and safely defaults to storage", () => {
    expect(financialAutomationTabFromSearch("?tab=extra-hire")).toBe("extra-hire");
    expect(financialAutomationTabFromSearch("?tab=unknown")).toBe("storage");
    expect(financialAutomationTabFromSearch("")).toBe("storage");
    expect(financialAutomationPath("final-weight")).toBe(
      "/financial-automation?tab=final-weight"
    );
    expect(isFinancialAutomationTab("main-invoices")).toBe(true);
    expect(isFinancialAutomationTab("financial-operations")).toBe(false);
  });

  it("maps every legacy workflow URL to its matching parent subtab", () => {
    for (const tab of FINANCIAL_AUTOMATION_TABS) {
      expect(financialAutomationTabFromLegacyPath(tab.legacyPath)).toBe(tab.value);
    }
    expect(financialAutomationTabFromLegacyPath("/invoices")).toBeNull();
  });
});
