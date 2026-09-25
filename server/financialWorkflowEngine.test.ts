import { describe, expect, it } from "vitest";
import {
  createFinancialIdempotencyKey,
  evaluateFinancialWorkflow,
  nextAvailableSuffix,
  nextRecurringHirePoNumber,
  type FinancialWorkflowInput,
} from "./financialWorkflowEngine";

function evaluate(input: Partial<FinancialWorkflowInput> & Pick<FinancialWorkflowInput, "workflowType" | "sourceData">) {
  return evaluateFinancialWorkflow({
    triggerType: "manual",
    sourceRecordId: "deal-702900",
    sourceRecordNumber: "D702900",
    ...input,
  });
}

describe("financial trigger migration shadow evaluator", () => {
  it("creates acquisition POs with preserved A/S/H references, accounts and 20-foot default hire cost", () => {
    const result = evaluate({
      workflowType: "container_control_acquisition",
      sourceData: {
        containerControlNumber: "1860", status: "REQUEST", acquisition: "FOR HIRE", containerType: "20ft", collectionDate: "2026-10-01",
        assetAmountExGst: 1000, customerSaleAmountExGst: 250, supplierName: "Container Supplier", hireSupplierName: "Hire Supplier",
      },
    });
    expect(result.mode).toBe("shadow");
    expect(result.intents.map((intent) => intent.proposedDocumentNumber)).toEqual(["A1860", "S1860", "H1860"]);
    expect(result.intents.map((intent) => intent.accountCode)).toEqual(["322", "322", "312"]);
    expect(result.intents[2]?.lineItems[0]).toMatchObject({ itemCode: "HC 20", unitAmount: 120, gstTreatment: "GST_EXCLUSIVE" });
    expect(result.safeRequestSummary).toMatchObject({ xeroWritePermitted: false, liveModePermitted: false });
  });

  it("evaluates recurring hire only for eligible FOR HIRE ON HIRE or IDLE records and preserves a gap-safe reference", () => {
    const result = evaluate({
      workflowType: "recurring_for_hire",
      sourceRecordId: "control-1860",
      sourceData: {
        containerControlNumber: "HC1860", acquisition: "FOR HIRE", status: "ON HIRE", containerType: "40 foot", containerNumber: "CAXU1234567",
        purchaseDailyRateExGst: 8, periodStart: "2026-11-01", periodEnd: "2026-11-30", supplierName: "Hire Supplier",
      },
      existingDocumentNumbers: ["HC1860-2"],
    });
    expect(result.outcome).toBe("passed");
    expect(result.intents[0]).toMatchObject({ proposedDocumentNumber: "HC1860-3", accountCode: "312" });
    expect(result.intents[0]?.lineItems[0]).toMatchObject({ itemCode: "HC 40 E", quantity: 30, unitAmount: 8 });

    const held = evaluate({ workflowType: "recurring_for_hire", sourceData: { containerControlNumber: "1860", acquisition: "FOR HIRE", status: "READY" } });
    expect(held.outcome).toBe("failed");
    expect(held.issues.some((issue) => issue.code === "INELIGIBLE_CONTAINER_STATUS")).toBe(true);
  });

  it("proposes the required storage activation and recurring storage document sets with fixed accounts", () => {
    const sourceData = {
      dealNumber: "D702900", containerType: "20 foot", containerNumber: "TGHU123", dateIn: "2026-10-01", storageStage: "ORIGIN",
      customerOrganisationName: "Customer Pty Ltd", transportSupplierName: "JD Transport", storageSupplierName: "GD Storage",
    };
    const activation = evaluate({ workflowType: "storage_activation", sourceData });
    expect(activation.intents.map((intent) => [intent.documentType, intent.proposedDocumentNumber, intent.accountCode])).toEqual([
      ["storage_activation", "INV-702900-S", null], ["jd_transport", "JD702900", "310"], ["gd_storage", "GD702900", "311"],
    ]);
    expect(activation.intents[1]?.lineItems[0]?.unitAmount).toBe(275);
    expect(activation.intents[2]?.lineItems[0]?.unitAmount).toBe(50);
    const recurring = evaluate({ workflowType: "recurring_storage", sourceData });
    expect(recurring.intents.map((intent) => intent.documentType)).toEqual(["recurring_storage", "gd_storage"]);
  });

  it("holds storage finalisation when a linked document is non-Draft or recovery needs controlled review", () => {
    const result = evaluate({
      workflowType: "storage_finalisation",
      sourceData: { storageBillingEventId: "storage-1", finalPeriodWeeks: 1, customerInvoiceStatus: "AUTHORISED", recoverMissingDocuments: true },
    });
    expect(result.intents[0]).toMatchObject({ proposedAction: "hold", validationStatus: "held" });
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["NON_DRAFT_DOCUMENT_CONFLICT", "CONTROLLED_RECOVERY_REQUIRES_REVIEW"]));
  });

  it("builds a Draft main customer invoice from Quote Service lines", () => {
    const result = evaluate({
      workflowType: "main_customer_invoice",
      sourceData: {
        customerOrganisationName: "Customer Pty Ltd", quoteNumber: "Q-7", quoteServiceLines: [
          { itemCode: "SER1", description: "Service", quantity: 2, amountExGst: 200, accountCode: "200" },
        ],
      },
    });
    expect(result.intents[0]).toMatchObject({ proposedDocumentNumber: "INV-702900", proposedAction: "create_draft", partyName: "Customer Pty Ltd", subtotal: 200, taxAmount: 20, total: 220 });
  });

  it("uses GST-inclusive deposit totals and blocks inappropriate deposit states", () => {
    const result = evaluate({ workflowType: "deposit_invoice", sourceData: { customerOrganisationName: "Customer", depositStatus: "Pending", depositAmountRequired: 110 } });
    expect(result.intents[0]).toMatchObject({ proposedDocumentNumber: "INV-702900-D", gstTreatment: "GST_INCLUSIVE", subtotal: 100, taxAmount: 10, total: 110 });
    const held = evaluate({ workflowType: "deposit_invoice", sourceData: { depositStatus: "Paid", depositAmountRequired: 110 } });
    expect(held.outcome).toBe("failed");
  });

  it("updates only Draft main invoices for final-weight outcomes and never creates a negative underweight line", () => {
    const overweight = evaluate({ workflowType: "final_weight_adjustment", sourceData: { weightDirection: "OVERWEIGHT", mainInvoiceStatus: "DRAFT", excessWeightAmountExGst: 75 } });
    expect(overweight.intents[0]).toMatchObject({ proposedAction: "update_draft", proposedDocumentNumber: "INV-702900" });
    expect(overweight.intents[0]?.lineItems[0]?.itemCode).toBe("SER70");
    const underweight = evaluate({ workflowType: "final_weight_adjustment", sourceData: { weightDirection: "UNDERWEIGHT", mainInvoiceStatus: "DRAFT", dueDate: "2026-11-10" } });
    expect(underweight.intents[0]?.lineItems).toEqual([]);
    const held = evaluate({ workflowType: "final_weight_adjustment", sourceData: { weightDirection: "OVERWEIGHT", mainInvoiceStatus: "AUTHORISED", excessWeightAmountExGst: 75 } });
    expect(held.intents[0]?.proposedAction).toBe("hold");
  });

  it("calculates extra hire as 4.286 weeks, uses account 210 and reserves the -D suffix", () => {
    const result = evaluate({
      workflowType: "extra_hire",
      sourceData: { hireDurationDays: 30, hireEndDate: "2026-11-01", containerType: "20ft", containerNumber: "TGHU1", customerOrganisationName: "Customer" },
      existingDocumentNumbers: ["INV-702900-1", "INV-702900-D"],
    });
    expect(result.intents[0]).toMatchObject({ proposedDocumentNumber: "INV-702900-2", accountCode: "210" });
    expect(result.intents[0]?.lineItems[0]).toMatchObject({ itemCode: "20' Hire", quantity: 4.286, unitAmount: 45 });
  });

  it("uses Added Services warranty data and creates the matching Aviso PO without touching a non-Draft main invoice", () => {
    const result = evaluate({
      workflowType: "warranty_reconciliation",
      sourceData: {
        addedService: "Warranty $50k", mainInvoiceStatus: "AUTHORISED", customerOrganisationName: "Customer", warrantyMapping: {
          itemCode: "WAR50", premiumExGst: 125, nativeDescription: "Warranty $50k",
        },
      },
      existingDocumentNumbers: ["INV-702900-D"],
    });
    expect(result.intents[0]).toMatchObject({ documentType: "warranty_invoice", proposedAction: "create_draft", proposedDocumentNumber: "INV-702900-1" });
    expect(result.intents[1]).toMatchObject({ documentType: "aviso_warranty", proposedDocumentNumber: "I702900", partyName: "Aviso Broking Pty Ltd", accountCode: "313" });
    expect(result.issues.some((issue) => issue.code === "WARRANTY_NON_DRAFT_MAIN")).toBe(true);
  });

  it("creates stable idempotency keys and distinct explicit re-evaluation keys", () => {
    const first = createFinancialIdempotencyKey({ workflowType: "main_customer_invoice", sourceRecordId: "deal-1", sourceRecordNumber: "D1", sourceData: { a: 1, b: 2 } });
    const reordered = createFinancialIdempotencyKey({ workflowType: "main_customer_invoice", sourceRecordId: "deal-1", sourceRecordNumber: "D1", sourceData: { b: 2, a: 1 } });
    const reevaluation = createFinancialIdempotencyKey({ workflowType: "main_customer_invoice", sourceRecordId: "deal-1", sourceRecordNumber: "D1", sourceData: { a: 1, b: 2 }, idempotencySalt: "review-2" });
    expect(first).toBe(reordered);
    expect(reevaluation).not.toBe(first);
    expect(nextAvailableSuffix("INV-10", ["INV-10-1", "INV-10-D"])).toBe("INV-10-2");
    expect(nextRecurringHirePoNumber("HC1860", ["HC1860-2", "HC1860-3"])).toBe("HC1860-4");
  });
});
