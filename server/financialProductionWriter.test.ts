import { afterEach, describe, expect, it } from "vitest";
import {
  assertFinancialDraftWriteAuthorised,
  executeFinancialDraftWrite,
  FinancialWriteDisabledError,
  isFinancialLiveWriteEnvironmentEnabled,
  prepareFinancialDraftPayload,
  prepareFinancialDraftUpdatePayload,
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

function completeAuthorisation(overrides: Partial<Parameters<typeof assertFinancialDraftWriteAuthorised>[0]> = {}) {
  return {
    executionId: 501,
    workflowType: "container_control_acquisition",
    approvalReference: "APPROVAL-EXAMPLE-ONLY",
    globalShadowMode: false,
    familyLiveEnabled: true,
    releaseManifestApproved: true,
    cutoverPackApproved: true,
    currentDocumentPreflightPassed: true,
    legacyWriterHandoffComplete: true,
    ...overrides,
  };
}

describe("guarded financial production writer", () => {
  const originalEnabled = process.env.FINANCIAL_LIVE_WRITES_ENABLED;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    else process.env.FINANCIAL_LIVE_WRITES_ENABLED = originalEnabled;
  });

  it("prepares a deterministic Draft-only GST-exclusive purchase-order shape without transmitting it", () => {
    const first = prepareFinancialDraftPayload(proposal(), "workflow-key");
    const second = prepareFinancialDraftPayload(proposal(), "workflow-key");
    expect(first).toMatchObject({ endpoint: "/PurchaseOrders", method: "POST", documentNumber: "H1860" });
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
    expect(payload).toMatchObject({ endpoint: "/Invoices", method: "POST", documentNumber: "INV-702900-D" });
    expect(payload.body).toMatchObject({
      Invoices: [{ Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Inclusive", LineItems: [{ TaxType: "OUTPUT", UnitAmount: 110 }] }],
    });
  });

  it("creates a stable exact-Draft update request only after matching the verified identifier and number", () => {
    const payload = prepareFinancialDraftUpdatePayload(
      proposal({ proposedAction: "update_draft" }),
      "workflow-key",
      { xeroDocumentId: "po-xero-1", documentNumber: "H1860", status: "DRAFT" },
    );
    expect(payload).toMatchObject({
      endpoint: "/PurchaseOrders/po-xero-1", method: "PUT", expectedXeroDocumentId: "po-xero-1",
    });
    expect(() => prepareFinancialDraftUpdatePayload(
      proposal({ proposedAction: "update_draft" }),
      "workflow-key",
      { xeroDocumentId: "po-xero-1", documentNumber: "OTHER", status: "DRAFT" },
    )).toThrow(/does not match/i);
    expect(() => prepareFinancialDraftUpdatePayload(
      proposal({ proposedAction: "update_draft" }),
      "workflow-key",
      { xeroDocumentId: "po-xero-1", documentNumber: "H1860", status: "AUTHORISED" } as any,
    )).toThrow(/existing Draft target/i);
  });

  it("keeps the environment writer disabled by default and rejects a call before it can obtain Xero credentials", async () => {
    delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    const payload = prepareFinancialDraftPayload(proposal(), "workflow-key");
    expect(isFinancialLiveWriteEnvironmentEnabled()).toBe(false);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation())).toThrow(FinancialWriteDisabledError);
    await expect(executeFinancialDraftWrite(payload, completeAuthorisation())).rejects.toBeInstanceOf(FinancialWriteDisabledError);
  });

  it("rejects every incomplete document-specific activation gate even when the environment lock is set", () => {
    process.env.FINANCIAL_LIVE_WRITES_ENABLED = "true";
    expect(isFinancialLiveWriteEnvironmentEnabled()).toBe(true);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ globalShadowMode: true }))).toThrow(/shadow mode/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ familyLiveEnabled: false }))).toThrow(/not enabled/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ releaseManifestApproved: false }))).toThrow(/manifest/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ cutoverPackApproved: false }))).toThrow(/cutover pack/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ currentDocumentPreflightPassed: false }))).toThrow(/preflight/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ legacyWriterHandoffComplete: false }))).toThrow(/legacy writer/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ approvalReference: null }))).toThrow(/approval reference/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation({ executionId: null }))).toThrow(/execution ledger ID/i);
  });

  it("rejects a malformed transport idempotency key before Xero credentials are obtained", async () => {
    process.env.FINANCIAL_LIVE_WRITES_ENABLED = "true";
    const payload = { ...prepareFinancialDraftPayload(proposal(), "workflow-key"), idempotencyKey: "not-a-deterministic-key" };
    await expect(executeFinancialDraftWrite(payload, completeAuthorisation())).rejects.toThrow(/idempotency key/i);
  });

  it("never prepares held or pending-GST proposals", () => {
    expect(() => prepareFinancialDraftPayload(proposal({ validationStatus: "held" }), "workflow-key")).toThrow(/held/i);
    expect(() => prepareFinancialDraftPayload(proposal({ gstTreatment: "PENDING_CONFIGURATION", documentFamily: "customer_invoice" }), "workflow-key")).toThrow(/GST treatment/i);
  });
});
