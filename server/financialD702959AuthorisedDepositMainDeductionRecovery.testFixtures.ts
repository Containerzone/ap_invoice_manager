import { financialSha256 } from "./financialProposalIntegrity";
import { D702959_AUTHORISED_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, jsonEvidence } from "./financialD702959AuthorisedDepositMainDeductionRecoveryScope";
import type { FinancialDraftPayload } from "./financialProductionWriter";

export { scope };
export function source() {
  const shared = { dealId: scope.dealId, dealNumber: scope.dealNumber, quoteId: "20x531901", quoteNumber: "Q531901",
    customerVtigerId: "4x531901", customerName: "Rees Davies", customerKind: "contact", sourceHoldReason: null,
    sourceRefreshedAt: "2026-10-30T01:00:00.000Z" };
  return {
    mainFacts: { ...shared, serviceLines: [{ description: "Hire", quantity: 1, unitAmount: 224.75 }, { description: "Transport", quantity: 1, unitAmount: 3596.57 }], mappingEvidence: {}, depositStatus: "" },
    depositFacts: { ...shared, depositAmountRequiredInclusive: 500, mappingEvidence: { depositAmountRequired: "cf_potentials_extras" }, depositStatus: "" },
  };
}
export function drafts() {
  const shared = { Type: "ACCREC", CurrencyCode: "AUD", Contact: { ContactID: "0f2caf5e-a884-470c-bbae-dc31eae12d0a", Name: "Rees Davies" },
    DateString: "2026-10-30T00:00:00", CurrencyRate: 1, Reference: "Q531901", BrandingThemeID: "16ff022c-95e9-47e9-852b-e5b958e7da", Url: "https://example.invalid/invoice",
    AmountPaid: 0, AmountCredited: 0, Payments: [], CreditNotes: [], Prepayments: [], Overpayments: [] };
  return {
    main: { ...shared, Status: "DRAFT", InvoiceID: scope.mainXeroInvoiceId, InvoiceNumber: scope.mainInvoiceNumber, LineAmountTypes: "Exclusive",
      AmountDue: 4203.46, SubTotal: 3821.32, TotalTax: 382.14, Total: 4203.46, LineItems: [
        { LineItemID: "f9e63717-29c9-4c51-9450-cd5e2e87471c", AccountCode: "210", AccountID: "account-hire", Description: "20 Foot Standard Height Container Hire per 30 days", ItemCode: "20' Hire", Quantity: 1, UnitAmount: 224.75, LineAmount: 224.75, TaxAmount: 22.48, TaxType: "OUTPUT", Tracking: [], DiscountRate: 0 },
        { LineItemID: "2cb49bae-f39a-4a29-a0dd-6668ac11bf1a", AccountCode: "200", AccountID: "account-service", Description: "Empty & Loaded Container from BELGIAN GARDENS, 4810, QLD to BRISBANE CITY, 4000, QLD", ItemCode: "SER60", Quantity: 1, UnitAmount: 3596.57, LineAmount: 3596.57, TaxAmount: 359.66, TaxType: "OUTPUT", Tracking: [{ Name: "Region", Option: "Queensland", TrackingCategoryID: "tracking-id" }], DiscountRate: 0 },
      ] },
    deposit: { ...shared, Status: "AUTHORISED", DueDateString: "2026-10-31T00:00:00", InvoiceID: scope.depositXeroInvoiceId, InvoiceNumber: scope.depositInvoiceNumber, LineAmountTypes: "Inclusive",
      AmountDue: 500, SubTotal: 454.55, TotalTax: 45.45, Total: 500, LineItems: [
        { LineItemID: "a03dff78-ac25-48ae-9550-f18abf3db756", AccountCode: "200", Description: "Deposit for Q531901 from INV-702959", ItemCode: "Deposit Required", Quantity: 1, UnitAmount: 500, LineAmount: 500, TaxAmount: 45.45, TaxType: "OUTPUT", Tracking: [] },
      ] },
  };
}
function creationPayload(): FinancialDraftPayload {
  return { method: "POST", endpoint: "/Invoices", documentFamily: "customer_invoice", documentNumber: scope.depositInvoiceNumber, expectedXeroDocumentId: null,
    idempotencyKey: "c".repeat(64), body: { Invoices: [{ InvoiceNumber: scope.depositInvoiceNumber, Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", Date: "2026-10-30", DueDate: "2026-10-31", Reference: "Q531901", LineAmountTypes: "Inclusive", Contact: { ContactID: "0f2caf5e-a884-470c-bbae-dc31eae12d0a" }, LineItems: [{ ItemCode: "Deposit Required", Description: "Deposit for Q531901 from INV-702959", Quantity: 1, UnitAmount: 500, AccountCode: "200", TaxType: "OUTPUT" }] }] } };
}
export function anchors() {
  const stamp = new Date("2026-10-29T21:43:12.000Z");
  const payload = creationPayload();
  return jsonEvidence({
    originalMain: { id: scope.originalMainEventId, dealId: scope.dealId, dealNumber: scope.dealNumber, proposedInvoiceNumber: scope.mainInvoiceNumber,
      status: "reconciliation_required", processingToken: null, xeroInvoiceId: null, executionId: null, sourceSnapshotHash: "a".repeat(64), xeroPreflightHash: "b".repeat(64),
      authorisedPayload: { hash: "c".repeat(64), bodyHash: "d".repeat(64), number: scope.mainInvoiceNumber },
      proposal: { sourceRecordId: scope.dealId, proposedDocumentNumber: scope.mainInvoiceNumber, documentType: "main_customer_invoice", documentFamily: "customer_invoice", proposedAction: "create_draft", gstTreatment: "GST_EXCLUSIVE", currency: "AUD", partySourceId: "0f2caf5e-a884-470c-bbae-dc31eae12d0a" } },
    failedMainWriter: { id: scope.failedMainWriterExecutionId, workflowType: "main_customer_invoice", documentFamily: "customer_invoice", proposedAction: "create_draft", proposedDocumentNumber: scope.mainInvoiceNumber,
      targetXeroDocumentId: null, endpoint: "/Invoices", method: "POST", idempotencyKey: "e".repeat(64), payloadFingerprint: `${"e".repeat(24)}:POST:/Invoices`, status: "reconciliation_required", xeroDocumentId: null, xeroDocumentStatus: null, xeroResponseSummary: null, errorMessage: scope.originalMainWriterError, submittedAt: stamp, completedAt: stamp },
    deposit: { id: scope.depositEventId, dealId: scope.dealId, dealNumber: scope.dealNumber, proposedInvoiceNumber: scope.depositInvoiceNumber, claimedDealId: scope.dealId, claimedInvoiceNumber: scope.depositInvoiceNumber,
      status: "drafts_created", processingToken: null, xeroInvoiceId: scope.depositXeroInvoiceId, executionId: scope.depositWriterExecutionId, authorisedPayload: { hash: financialSha256(payload), number: scope.depositInvoiceNumber, payload } },
    depositWriter: { id: scope.depositWriterExecutionId, workflowType: "deposit_invoice", documentFamily: "customer_invoice", proposedAction: "create_draft", proposedDocumentNumber: scope.depositInvoiceNumber,
      targetXeroDocumentId: null, endpoint: "/Invoices", method: "POST", idempotencyKey: payload.idempotencyKey, payloadFingerprint: `${payload.idempotencyKey.slice(0, 24)}:POST:/Invoices`, status: "succeeded", xeroDocumentId: scope.depositXeroInvoiceId, xeroDocumentStatus: "DRAFT", approvalReference: "deposit-release", submittedAt: stamp, completedAt: stamp, xeroResponseSummary: { documentNumber: scope.depositInvoiceNumber, endpoint: "/Invoices", idempotencyKey: payload.idempotencyKey } },
  });
}
