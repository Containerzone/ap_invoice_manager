import { afterEach, describe, expect, it } from "vitest";
import {
  assertFinancialDraftWriteAuthorised,
  bindFinancialDraftPayloadIdempotencyKey,
  executeFinancialDraftWrite,
  financialDraftWriteAllowsTransientRetry,
  FinancialWriteDisabledError,
  isFinancialLiveWriteEnvironmentEnabled,
  isPermittedMainCustomerInvoiceLineAccount,
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
  const originalForHireEnabled = process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED;
  const originalCustomerSaleEnabled = process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    else process.env.FINANCIAL_LIVE_WRITES_ENABLED = originalEnabled;
    if (originalForHireEnabled === undefined) delete process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED;
    else process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED = originalForHireEnabled;
    if (originalCustomerSaleEnabled === undefined) delete process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED;
    else process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED = originalCustomerSaleEnabled;
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

  it("omits the Xero Reference field when a Draft proposal deliberately has no reference", () => {
    const payload = prepareFinancialDraftPayload(proposal({ reference: null }), "workflow-key");
    expect(payload.body.PurchaseOrders?.[0]).not.toHaveProperty("Reference");
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

  it("changes Main Invoice idempotency when the completed Xero wire body changes", () => {
    const first = prepareFinancialDraftPayload(proposal({
      documentFamily: "customer_invoice", documentType: "main_customer_invoice", proposedDocumentNumber: "INV-702900",
      reference: "Q702900", lineItems: [{ itemCode: "SER9", description: "Loaded Container from A to B", quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" }],
    }), "workflow-key");
    (first.body.Invoices as any[])[0].CurrencyCode = "AUD";
    const bound = bindFinancialDraftPayloadIdempotencyKey(first);
    const changed = structuredClone(bound);
    (changed.body.Invoices as any[])[0].Contact.ContactID = "another-contact";
    const rebound = bindFinancialDraftPayloadIdempotencyKey(changed);

    expect(bound.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(rebound.idempotencyKey).not.toBe(bound.idempotencyKey);
  });

  it("permits only verified Main Invoice item and sales-account combinations", () => {
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "", AccountCode: "200" })).toBe(true);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "SER9", AccountCode: "200" })).toBe(true);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "SER60", AccountCode: "200" })).toBe(true);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "20' Hire", AccountCode: "210" })).toBe(true);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "40' Hire", AccountCode: "210" })).toBe(true);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "20' Sale", AccountCode: "230" })).toBe(true);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "SER60", AccountCode: "210" })).toBe(false);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "20' Hire", AccountCode: "200" })).toBe(false);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "20' Sale", AccountCode: "not-an-account" })).toBe(false);
    expect(isPermittedMainCustomerInvoiceLineAccount({ ItemCode: "Unexpected", AccountCode: "200" })).toBe(false);
  });

  it("never permits a blind transient retry for automatic or reconciliation Main Invoice writes", () => {
    expect(financialDraftWriteAllowsTransientRetry(completeAuthorisation({
      workflowType: "main_customer_invoice", mainCustomerInvoiceAutomaticEventId: 41, mainCustomerInvoiceReleaseKey: "MAIN-UNIT", mainCustomerInvoiceApprovedBy: 7, mainCustomerInvoiceToken: "token",
    }))).toBe(false);
    expect(financialDraftWriteAllowsTransientRetry(completeAuthorisation({
      workflowType: "main_customer_invoice", mainInvoiceReconciliationEventId: 42, mainInvoiceReconciliationReceiptId: 9, mainInvoiceReconciliationApprovedBy: 7, mainInvoiceReconciliationSourceHash: "s".repeat(64), mainInvoiceReconciliationPreflightHash: "p".repeat(64),
    }))).toBe(false);
    expect(financialDraftWriteAllowsTransientRetry(completeAuthorisation({ workflowType: "initial_for_hire" }))).toBe(true);
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

  it("permits only the explicitly armed, named storage pilot; broad financial writing stays locked", () => {
    delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    process.env.FINANCIAL_INITIAL_STORAGE_ENABLED = "true";
    try {
      const storage = completeAuthorisation({ workflowType: "storage_activation", storagePilotEventId: 17, storagePilotApprovedBy: 3 });
      expect(() => assertFinancialDraftWriteAuthorised(storage)).not.toThrow();
      expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation())).toThrow(FinancialWriteDisabledError);
      expect(() => assertFinancialDraftWriteAuthorised({ ...storage, workflowType: "recurring_storage" })).toThrow(/not valid/);
      expect(() => assertFinancialDraftWriteAuthorised({ ...storage, storagePilotEventId: -1 })).toThrow(/not valid/);
      expect(() => assertFinancialDraftWriteAuthorised({ ...storage, currentDocumentPreflightPassed: false })).toThrow(/preflight/);
      expect(() => assertFinancialDraftWriteAuthorised({ ...storage, approvalReference: null })).toThrow(/approval/);
      delete process.env.FINANCIAL_INITIAL_STORAGE_ENABLED;
      expect(() => assertFinancialDraftWriteAuthorised(storage)).toThrow(/not enabled/);
    } finally {
      delete process.env.FINANCIAL_INITIAL_STORAGE_ENABLED;
    }
  });

  it("permits only the isolated For Hire standing-release context while leaving the global writer disabled", () => {
    delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    process.env.FINANCIAL_FOR_HIRE_AUTOMATIC_ENABLED = "true";
    const forHire = completeAuthorisation({
      workflowType: "initial_for_hire",
      forHireAutomaticEventId: 31,
      forHireReleaseKey: "FOR-HIRE-UNIT-TEST",
      forHireApprovedBy: 7,
    });
    expect(() => assertFinancialDraftWriteAuthorised(forHire)).not.toThrow();
    expect(() => assertFinancialDraftWriteAuthorised({ ...forHire, workflowType: "storage_activation" })).toThrow(/For Hire automatic release/i);
    expect(() => assertFinancialDraftWriteAuthorised({ ...forHire, forHireAutomaticEventId: 0 })).toThrow(/For Hire automatic release/i);
    expect(() => assertFinancialDraftWriteAuthorised({ ...forHire, forHireReleaseKey: undefined })).toThrow(/For Hire automatic release/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation())).toThrow(FinancialWriteDisabledError);
  });

  it("permits only the isolated Customer Sale standing-release context while leaving other families locked", () => {
    delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    process.env.FINANCIAL_CUSTOMER_SALE_PURCHASE_AUTOMATIC_ENABLED = "true";
    const customerSale = completeAuthorisation({
      workflowType: "customer_sale_purchase",
      customerSalePurchaseAutomaticEventId: 52,
      customerSalePurchaseReleaseKey: "CUSTOMER-SALE-UNIT-TEST",
      customerSalePurchaseApprovedBy: 7,
    });
    expect(() => assertFinancialDraftWriteAuthorised(customerSale)).not.toThrow();
    expect(() => assertFinancialDraftWriteAuthorised({ ...customerSale, workflowType: "asset_purchase" })).toThrow(/Customer Sale purchase automatic release/i);
    expect(() => assertFinancialDraftWriteAuthorised({ ...customerSale, customerSalePurchaseAutomaticEventId: 0 })).toThrow(/Customer Sale purchase automatic release/i);
    expect(() => assertFinancialDraftWriteAuthorised({ ...customerSale, customerSalePurchaseReleaseKey: undefined })).toThrow(/Customer Sale purchase automatic release/i);
    expect(() => assertFinancialDraftWriteAuthorised(completeAuthorisation())).toThrow(FinancialWriteDisabledError);
  });

  it("keeps Main Invoice local-validation reconciliation default-off and rejects cross-family or normal-event contexts", () => {
    delete process.env.FINANCIAL_LIVE_WRITES_ENABLED;
    const reconciliation = completeAuthorisation({
      workflowType: "main_invoice_reconciliation",
      approvalReference: "MAIN-RECONCILIATION-UNIT-TEST",
      mainInvoiceReconciliationEventId: 750002,
      mainInvoiceReconciliationToken: "exclusive-token",
      mainInvoiceReconciliationReleaseKey: "MAIN-RECONCILIATION-UNIT-TEST",
      mainInvoiceReconciliationApprovedBy: 7,
    });
    delete process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED;
    expect(() => assertFinancialDraftWriteAuthorised(reconciliation)).toThrow(/Main Customer Invoice reconciliation/i);
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED = "true";
    expect(() => assertFinancialDraftWriteAuthorised(reconciliation)).not.toThrow();
    expect(() => assertFinancialDraftWriteAuthorised({ ...reconciliation, workflowType: "main_customer_invoice" })).toThrow(/reconciliation/i);
    expect(() => assertFinancialDraftWriteAuthorised({ ...reconciliation, mainCustomerInvoiceAutomaticEventId: 750001 })).toThrow(/reconciliation/i);
    delete process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_RECONCILIATION_ENABLED;
  });

  it("rejects storage-pilot updates and non-Draft create payloads before Xero authentication", async () => {
    process.env.FINANCIAL_INITIAL_STORAGE_ENABLED = "true";
    try {
      const storage = completeAuthorisation({ workflowType: "storage_activation", storagePilotEventId: 17, storagePilotApprovedBy: 3 });
      const payload = prepareFinancialDraftPayload(proposal(), "workflow-key");
      await expect(executeFinancialDraftWrite({ ...payload, method: "PUT" }, storage)).rejects.toThrow(/Draft POST/);
      await expect(executeFinancialDraftWrite({ ...payload, body: { PurchaseOrders: [{ Status: "AUTHORISED" }] } }, storage)).rejects.toThrow(/DRAFT status/);
    } finally {
      delete process.env.FINANCIAL_INITIAL_STORAGE_ENABLED;
    }
  });

  it("rejects a Deposit rounding correction unless it carries the exact approved tax override", async () => {
    process.env.FINANCIAL_LIVE_WRITES_ENABLED = "true";
    const correction = {
      endpoint: "/Invoices/main-id" as const,
      method: "POST" as const,
      documentFamily: "customer_invoice" as const,
      documentNumber: "INV-702933",
      expectedXeroDocumentId: "main-id",
      idempotencyKey: "c".repeat(64),
      body: { Invoices: [{ InvoiceID: "main-id", InvoiceNumber: "INV-702933", Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: "Exclusive", Contact: { ContactID: "customer" }, Date: "2026-10-12", LineItems: [{ Description: "Deposit deduction — INV-702933-D", Quantity: 1, UnitAmount: -454.55, LineAmount: -454.55, TaxAmount: -45.46, AccountCode: "200", TaxType: "OUTPUT" }] }] },
    };
    const authorisation = completeAuthorisation({ workflowType: "deposit_draft_correction", approvalReference: "DEPOSIT-CORRECTION", depositDraftCorrectionKind: "main_deduction_rounding", depositDraftCorrectionReleaseKey: "DEPOSIT-CORRECTION", depositDraftCorrectionApprovedBy: 1 });
    await expect(executeFinancialDraftWrite(correction, authorisation)).rejects.toThrow(/rounding correction/i);
  });

  it("never prepares held or pending-GST proposals", () => {
    expect(() => prepareFinancialDraftPayload(proposal({ validationStatus: "held" }), "workflow-key")).toThrow(/held/i);
    expect(() => prepareFinancialDraftPayload(proposal({ gstTreatment: "PENDING_CONFIGURATION", documentFamily: "customer_invoice" }), "workflow-key")).toThrow(/GST treatment/i);
  });
});
