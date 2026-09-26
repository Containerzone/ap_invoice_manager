import { describe, expect, it } from "vitest";
import { evaluateFinancialWorkflow } from "./financialWorkflowEngine";
import {
  compareShadowExpectedResult,
  deriveRulesBasedExpectedFacts,
  mapVtigerFinancialSource,
  sourceRecordNumberFromVtiger,
} from "./financialShadowValidation";
import { DEFAULT_FINANCIAL_AUTOMATION_RULES } from "./financialAutomationRules";

describe("financial shadow validation evidence", () => {
  it("maps only administrator-declared VTiger aliases while retaining raw source values", () => {
    const raw = { potentials_no: "D702900", accountname: "Customer Pty Ltd", cf_container_control: "1860" };
    const mapped = mapVtigerFinancialSource(raw, {
      shared: { customerOrganisationName: ["accountname", "organisation_name"] },
      main_customer_invoice: { dealNumber: "potentials_no", containerControlNumber: "cf_container_control" },
    }, "main_customer_invoice");
    expect(mapped.sourceData).toMatchObject({ customerOrganisationName: "Customer Pty Ltd", dealNumber: "D702900", containerControlNumber: "1860" });
    expect(mapped.sourceData.potentials_no).toBe("D702900");
    expect(sourceRecordNumberFromVtiger(raw)).toBe("D702900");
  });

  it("records field-level differences rather than claiming a match", () => {
    const evaluation = evaluateFinancialWorkflow({
      workflowType: "deposit_invoice",
      triggerType: "manual",
      sourceRecordId: "deal-1",
      sourceRecordNumber: "D702900",
      sourceData: { customerOrganisationName: "Customer", depositStatus: "Pending", depositAmountRequired: 110 },
    });
    const comparison = compareShadowExpectedResult({
      proposedDocumentNumbers: ["INV-702900-D"],
      totals: [111],
      itemCodes: ["Deposit Required"],
    }, evaluation, []);
    expect(comparison.hasExpectedFacts).toBe(true);
    expect(comparison.comparisons.find((entry) => entry.field === "proposedDocumentNumbers[0]")?.outcome).toBe("match");
    expect(comparison.comparisons.find((entry) => entry.field === "totals[0]")?.outcome).toBe("different");
    expect(comparison.actual.intents[0]?.lineItems[0]).toMatchObject({ itemCode: "Deposit Required", quantity: 1 });
  });

  it("derives granular expected facts from active rules but leaves confirmation to the reviewer", () => {
    const evaluation = evaluateFinancialWorkflow({
      workflowType: "deposit_invoice",
      triggerType: "manual",
      sourceRecordId: "4x702903",
      sourceRecordNumber: "D702903",
      sourceData: { customerOrganisationName: "Customer", depositStatus: "Pending", depositAmountRequired: 110, invoiceStatus: "DRAFT" },
    });
    const generated = deriveRulesBasedExpectedFacts(evaluation, DEFAULT_FINANCIAL_AUTOMATION_RULES, { invoiceStatus: "DRAFT" });
    expect(generated.expectedResult).toMatchObject({
      proposedDocumentNumbers: ["INV-702903-D"],
      totals: [110],
      itemCodes: ["Deposit Required"],
    });
    expect(generated.expectedResult.assertions).toMatchObject({
      "intents.0.lineItems.0.quantity": 1,
      "intents.0.lineItems.0.gstTreatment": "GST_INCLUSIVE",
    });
    expect(generated.ruleFacts.some((fact) => fact.field === "Draft status guard")).toBe(true);
  });
});
