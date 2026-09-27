import { describe, expect, it } from "vitest";
import {
  executeFinancialDraftWrite,
  FinancialWriteDisabledError,
  FINANCIAL_LIVE_WRITES_ENABLED,
  prepareFinancialDraftPayload,
} from "./financialProductionWriter";
import type { ProposedFinancialDocument } from "./financialWorkflowEngine";

function proposal(overrides: Partial<ProposedFinancialDocument> = {}): ProposedFinancialDocument {
  return {
    documentFamily: "purchase_order",
    documentType: "initial_for_hire",
    proposedAction: "create_draft",
    proposedDocumentNumber: "H1860",
    reference: "1860",
    partyName: "Hire Supplier",
    partySourceId: "contact-1",
    accountCode: "312",
    gstTreatment: "GST_EXCLUSIVE",
    currency: "AUD",
    subtotal: 120,
    taxAmount: 12,
    total: 132,
    issueDate: new Date("2026-10-01T00:00:00.000Z"),
    dueDate: null,
    lineItems: [{ itemCode: "HC 20", description: "20' Container Hire", quantity: 1, unitAmount: 120, lineAmount: 120, accountCode: "312", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
    sourceWorkflow: "container_control_acquisition",
    sourceRecordId: "control-1860",
    validationStatus: "valid",
    ...overrides,
  };
}

describe("disabled financial production writer", () => {
  it("prepares a deterministic Draft-only GST-exclusive purchase-order shape without transmitting it", () => {
    const first = prepareFinancialDraftPayload(proposal(), "workflow-key");
    const second = prepareFinancialDraftPayload(proposal(), "workflow-key");
    expect(first).toMatchObject({ endpoint: "/PurchaseOrders", documentNumber: "H1860" });
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.body).toMatchObject({
      PurchaseOrders: [{ PurchaseOrderNumber: "H1860", Status: "DRAFT", LineAmountTypes: "Exclusive", LineItems: [{ ItemCode: "HC 20", AccountCode: "312", TaxType: "INPUT", UnitAmount: 120 }] }],
    });
  });

  it("prepares an ACCREC Draft invoice while retaining the evaluator's GST treatment", () => {
    const payload = prepareFinancialDraftPayload(proposal({
      documentFamily: "customer_invoice",
      documentType: "deposit_invoice",
      proposedDocumentNumber: "INV-702900-D",
      gstTreatment: "GST_INCLUSIVE",
      accountCode: null,
      lineItems: [{ itemCode: "Deposit Required", description: "Deposit Required", quantity: 1, unitAmount: 110, lineAmount: 110, accountCode: "", taxRate: 10, gstTreatment: "GST_INCLUSIVE" }],
    }), "workflow-key");
    expect(payload).toMatchObject({ endpoint: "/Invoices", documentNumber: "INV-702900-D" });
    expect(payload.body).toMatchObject({
      Invoices: [{ Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Inclusive", LineItems: [{ TaxType: "OUTPUT", UnitAmount: 110 }] }],
    });
  });

  it("never prepares held proposals and permanently rejects writer execution", async () => {
    expect(() => prepareFinancialDraftPayload(proposal({ validationStatus: "held" }), "workflow-key")).toThrow(/held/i);
    expect(FINANCIAL_LIVE_WRITES_ENABLED).toBe(false);
    await expect(executeFinancialDraftWrite(prepareFinancialDraftPayload(proposal(), "workflow-key"), { workflowType: "container_control_acquisition" }))
      .rejects.toBeInstanceOf(FinancialWriteDisabledError);
  });
});
