import { describe, expect, it } from "vitest";
import {
  DEFAULT_FINANCIAL_AUTOMATION_RULES,
  resolveFinancialAutomationRules,
} from "./financialAutomationRules";
import { evaluateFinancialWorkflow } from "./financialWorkflowEngine";

describe("financial automation rules", () => {
  it("retains documented defaults while accepting only known non-secret overrides", () => {
    const rules = resolveFinancialAutomationRules({
      accounts: { extraHire: "211", ignored: "never" },
      rates: { extraHire20WeeklyExGst: 47 },
      defaults: { extraHireWeeks: 4.5 },
      unknown: { token: "must-not-be-carried" },
    });
    expect(rules.accounts.extraHire).toBe("211");
    expect(rules.rates.extraHire20WeeklyExGst).toBe(47);
    expect(rules.defaults.extraHireWeeks).toBe(4.5);
    expect((rules as any).unknown).toBeUndefined();
    expect(DEFAULT_FINANCIAL_AUTOMATION_RULES.accounts.extraHire).toBe("210");
  });

  it("freezes configured values into evaluator results without permitting a write", () => {
    const rules = resolveFinancialAutomationRules({
      accounts: { extraHire: "211" },
      rates: { extraHire20WeeklyExGst: 47 },
      defaults: { extraHireWeeks: 4.5 },
    });
    const result = evaluateFinancialWorkflow({
      workflowType: "extra_hire",
      triggerType: "manual",
      sourceRecordId: "deal-1",
      sourceRecordNumber: "D700001",
      rules,
      sourceData: {
        hireDurationDays: 30,
        hireEndDate: "2026-11-01",
        containerType: "20ft",
        customerOrganisationName: "Customer",
      },
    });
    expect(result.mode).toBe("shadow");
    expect(result.safeRequestSummary.xeroWritePermitted).toBe(false);
    expect(result.intents[0]).toMatchObject({ accountCode: "211" });
    expect(result.intents[0]?.lineItems[0]).toMatchObject({ quantity: 4.5, unitAmount: 47, accountCode: "211" });
  });
});
