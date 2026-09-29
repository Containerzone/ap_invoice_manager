import { describe, expect, it } from "vitest";
import { planFinancialPostSuccessActions } from "./financialPostSuccessPlan";

const document = {
  documentFamily: "customer_invoice" as const,
  documentType: "example",
  proposedAction: "create_draft" as const,
  proposedDocumentNumber: "INV-7001",
  partyName: "Example Customer",
  partySourceId: "contact-1",
  accountCode: "200",
  gstTreatment: "GST_EXCLUSIVE",
  currency: "AUD",
  subtotal: 100,
  taxAmount: 10,
  total: 110,
  issueDate: null,
  dueDate: null,
  lineItems: [],
  validationStatus: "valid" as const,
};

describe("document-specific financial post-success planning", () => {
  it("creates only the approved storage activation note", () => {
    expect(planFinancialPostSuccessActions({
      workflowType: "storage_activation",
      document,
      sourceData: { storageStage: "ORIGIN" },
    })).toEqual([expect.objectContaining({
      actionType: "vtiger_note",
      safePayloadSummary: expect.objectContaining({ purpose: "storage_activation_note", storageLocation: "ORIGIN" }),
    })]);
  });

  it("creates a finalisation task only for a qualifying date-out stage", () => {
    const qualified = planFinancialPostSuccessActions({
      workflowType: "storage_finalisation",
      document,
      sourceData: { dateOut: "2026-10-01", storageStage: "4 - Finalise" },
    });
    expect(qualified.map((action) => action.actionType)).toEqual(["vtiger_note", "vtiger_task"]);
    expect(qualified[1]?.safePayloadSummary).toMatchObject({ taskSubject: "Finalise Storage Invoice", dueDate: "2026-10-01" });

    expect(planFinancialPostSuccessActions({
      workflowType: "storage_finalisation",
      document,
      sourceData: { dateOut: "2026-10-01", storageStage: "3 - Active" },
    }).map((action) => action.actionType)).toEqual(["vtiger_note"]);
  });

  it("sets the Extra Hire end date to a 30-day calendar extension", () => {
    expect(planFinancialPostSuccessActions({
      workflowType: "extra_hire",
      document,
      sourceData: { hireEndDate: "2026-01-31" },
    })).toEqual([expect.objectContaining({
      actionType: "vtiger_hire_end_update",
      safePayloadSummary: expect.objectContaining({ nextHireEndDate: "2026-03-02" }),
    })]);
  });

  it("does not invent VTiger changes for other financial families", () => {
    expect(planFinancialPostSuccessActions({ workflowType: "main_customer_invoice", document, sourceData: {} })).toEqual([]);
  });
});
