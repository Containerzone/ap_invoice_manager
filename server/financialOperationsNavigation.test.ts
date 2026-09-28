import { describe, expect, it } from "vitest";
import {
  FINANCIAL_OPERATIONS_NAVIGATION,
  firstAvailableFinancialOperationsTab,
  getFinancialOperationsGroup,
  isFinancialOperationsTabAvailable,
} from "../client/src/lib/financialOperationsNavigation";

describe("Financial Operations parent navigation", () => {
  it("keeps every financial child tab under one ordered parent workspace", () => {
    expect(FINANCIAL_OPERATIONS_NAVIGATION.map((group) => group.value)).toEqual([
      "dashboard",
      "documents",
      "review",
      "controls",
    ]);

    const tabs = FINANCIAL_OPERATIONS_NAVIGATION.flatMap((group) => group.tabs.map((tab) => tab.value));
    expect(tabs).toEqual([
      "overview",
      "po",
      "invoices",
      "runs",
      "exceptions",
      "candidate-finder",
      "shadow-tests",
      "history-preview",
      "schedules",
      "configuration",
      "cutover-centre",
      "release-readiness",
    ]);
    expect(new Set(tabs).size).toBe(tabs.length);
  });

  it("keeps administrator-only evidence and settings tabs unavailable to staff", () => {
    const review = getFinancialOperationsGroup("review");
    const controls = getFinancialOperationsGroup("controls");

    expect(firstAvailableFinancialOperationsTab(review, false)).toBe("exceptions");
    expect(firstAvailableFinancialOperationsTab(controls, false)).toBe("schedules");
    expect(isFinancialOperationsTabAvailable(review.tabs[1]!, false)).toBe(false);
    expect(isFinancialOperationsTabAvailable(review.tabs[1]!, true)).toBe(true);
    expect(isFinancialOperationsTabAvailable(controls.tabs[2]!, false)).toBe(false);
    expect(isFinancialOperationsTabAvailable(controls.tabs[2]!, true)).toBe(true);
    expect(isFinancialOperationsTabAvailable(controls.tabs[3]!, false)).toBe(false);
    expect(isFinancialOperationsTabAvailable(controls.tabs[3]!, true)).toBe(true);
  });
});
