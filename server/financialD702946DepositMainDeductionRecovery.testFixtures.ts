import { financialSha256 } from "./financialProposalIntegrity";
import { MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE, mainCustomerInvoiceReconciliationOriginalHash,
  mainCustomerInvoiceReconciliationWriterEvidenceHash } from "./financialMainCustomerInvoiceReconciliationDb";
import { D702946_DEPOSIT_MAIN_DEDUCTION_RECOVERY_SCOPE as scope, D702946_RECOVERY_RELEASE_KEY, D702946_RECOVERY_SCOPE_KEY,
  prepareD702946DepositMainDeductionRecoveryPayload, jsonEvidence } from "./financialD702946DepositMainDeductionRecoveryScope";
import type { FinancialDraftPayload, FinancialWriteAuthorisation } from "./financialProductionWriter";

export function drafts() {
  const shared = { Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", Contact: { ContactID: "contact-946", Name: "Customer" },
    DateString: "2026-10-18T00:00:00", DueDateString: "2026-10-20T00:00:00", CurrencyRate: 1, Reference: "keep-reference",
    BrandingThemeID: "theme", Url: "https://example.invalid/invoice", AmountPaid: 0, AmountCredited: 0, Payments: [], CreditNotes: [], Prepayments: [], Overpayments: [] };
  return { main: { ...shared, InvoiceID: scope.mainXeroInvoiceId, InvoiceNumber: scope.mainInvoiceNumber, LineAmountTypes: "Exclusive",
    SubTotal: 9029.15, TotalTax: 902.92, Total: 9932.07, LineItems: [{ LineItemID: "retained-line-id", Description: "Keep every field", ItemCode: "SER9",
      Quantity: 1, UnitAmount: 9029.15, LineAmount: 9029.15, TaxAmount: 902.92, TaxType: "OUTPUT", AccountCode: "200", DiscountRate: 0,
      Tracking: [{ Name: "Region", Option: "Sydney", TrackingCategoryID: "tracking" }] }] },
    deposit: { ...shared, InvoiceID: scope.depositXeroInvoiceId, InvoiceNumber: scope.depositInvoiceNumber, LineAmountTypes: "Inclusive",
      SubTotal: 454.55, TotalTax: 45.45, Total: 500, LineItems: [{ LineItemID: "deposit-line", ItemCode: "Deposit Required", Description: "Deposit for Q702946 from INV-702946",
        Quantity: 1, UnitAmount: 500, LineAmount: 500, TaxAmount: 45.45, TaxType: "OUTPUT", AccountCode: "200" }] } };
}
export function source() {
  const shared = { dealId: scope.dealId, dealNumber: scope.dealNumber, quoteId: "20x946", quoteNumber: "Q702946",
    customerVtigerId: "4x946", customerName: "Customer", customerKind: "contact", sourceHoldReason: null, sourceRefreshedAt: "2026-10-18T00:00:00.000Z" };
  return { mainFacts: { ...shared, serviceLines: [{ description: "Keep source", quantity: 1, unitAmount: 9029.15 }], mappingEvidence: {}, depositStatus: "" },
    depositFacts: { ...shared, depositAmountRequiredInclusive: 500, mappingEvidence: { depositAmountRequired: "cf_potentials_extras" }, depositStatus: "" } };
}
export function policy() { return { enabled: true, releaseKey: D702946_RECOVERY_RELEASE_KEY, approvedBy: 7,
  approvedAt: "2026-10-18T00:00:00.000Z", scope }; }
export function context(): FinancialWriteAuthorisation {
  return { workflowType: scope.workflowType, approvalReference: D702946_RECOVERY_RELEASE_KEY, globalShadowMode: false, familyLiveEnabled: true,
    releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true,
    d702946DepositMainDeductionRecoveryEventId: 1, d702946DepositMainDeductionRecoveryToken: "token", d702946DepositMainDeductionRecoveryReleaseKey: D702946_RECOVERY_RELEASE_KEY,
    d702946DepositMainDeductionRecoveryApprovedBy: 7, executionId: 1200001 };
}
export function anchors() {
  const stamp = new Date("2026-10-18T00:00:00.000Z");
  const originalMain: any = { id: scope.originalMainEventId, dealId: scope.dealId, dealNumber: scope.dealNumber, proposedInvoiceNumber: scope.mainInvoiceNumber,
    quoteId: "20x946", quoteNumber: "Q702946", customerVtigerId: "4x946", customerName: "Customer", sourceRefreshedAt: stamp,
    sourceSnapshotHash: "a".repeat(64), rulesSnapshotHash: "b".repeat(64), xeroPreflightHash: "c".repeat(64), proposal: {}, xeroPreflight: {},
    xeroInvoiceId: null, executionId: null, processingToken: null, status: "reconciliation_required", releaseKey: "original-main-release",
    authorisedPayload: { hash: "a".repeat(64), number: scope.mainInvoiceNumber, bodyHash: "b".repeat(64) }, holdReason: "immutable original" };
  const failedMainWriter: any = { id: scope.failedMainWriterExecutionId, workflowType: "main_customer_invoice", documentFamily: "customer_invoice", proposedAction: "create_draft",
    proposedDocumentNumber: scope.mainInvoiceNumber, targetXeroDocumentId: null, endpoint: "/Invoices", method: "POST", status: "failed", xeroDocumentId: null,
    xeroDocumentStatus: null, xeroResponseSummary: null, errorMessage: MAIN_CUSTOMER_INVOICE_RECONCILIATION_SCOPE.validationError,
    idempotencyKey: "d".repeat(64), submittedAt: stamp, completedAt: stamp };
  function creation(number: string, main: boolean): FinancialDraftPayload {
    return { method: "POST", endpoint: "/Invoices", documentFamily: "customer_invoice", documentNumber: number, expectedXeroDocumentId: null,
      idempotencyKey: (main ? "e" : "f").repeat(64), body: { Invoices: [{ Contact: { ContactID: "contact-946" }, InvoiceNumber: number, Type: "ACCREC", Status: "DRAFT", CurrencyCode: "AUD", LineAmountTypes: main ? "Exclusive" : "Inclusive" }] } };
  }
  const mainPayload = creation(scope.mainInvoiceNumber, true), depositPayload = creation(scope.depositInvoiceNumber, false);
  function writer(id: number, payload: FinancialDraftPayload, xeroId: string, workflow: string) {
    return { id, status: "succeeded", workflowType: workflow, documentFamily: "customer_invoice", proposedAction: "create_draft", proposedDocumentNumber: payload.documentNumber,
      targetXeroDocumentId: null, endpoint: "/Invoices", method: "POST", idempotencyKey: payload.idempotencyKey, payloadFingerprint: `${payload.idempotencyKey.slice(0, 24)}:POST:/Invoices`,
      approvalReference: "creation-release", submittedAt: stamp, completedAt: stamp, preparedBy: 7, xeroDocumentId: xeroId, xeroDocumentStatus: "DRAFT",
      xeroResponseSummary: { documentNumber: payload.documentNumber, endpoint: "/Invoices", idempotencyKey: payload.idempotencyKey } };
  }
  const mainRecovery = { id: 1, originalEventId: scope.originalMainEventId, failedWriterExecutionId: scope.failedMainWriterExecutionId, dealId: scope.dealId,
    dealNumber: scope.dealNumber, invoiceNumber: scope.mainInvoiceNumber, status: "drafts_created", processingToken: null, executionId: scope.mainRecoveryWriterExecutionId,
    submittedAt: stamp, originalEventHash: mainCustomerInvoiceReconciliationOriginalHash(originalMain), failedWriterEvidenceHash: mainCustomerInvoiceReconciliationWriterEvidenceHash(failedMainWriter),
    releaseKey: "creation-release", authorisedPayload: { hash: financialSha256(mainPayload), payload: mainPayload },
    readbackEvidence: { xeroDocumentId: scope.mainXeroInvoiceId, documentNumber: scope.mainInvoiceNumber, status: "DRAFT" } };
  const deposit = { id: scope.depositEventId, dealId: scope.dealId, dealNumber: scope.dealNumber, proposedInvoiceNumber: scope.depositInvoiceNumber,
    claimedDealId: scope.dealId, claimedInvoiceNumber: scope.depositInvoiceNumber, status: "drafts_created", processingToken: null, xeroInvoiceId: scope.depositXeroInvoiceId,
    executionId: 1090001, releaseKey: "creation-release", authorisedPayload: { hash: financialSha256(depositPayload), payload: depositPayload } };
  return jsonEvidence({ originalMain, failedMainWriter, mainRecovery, mainRecoveryWriter: writer(scope.mainRecoveryWriterExecutionId, mainPayload, scope.mainXeroInvoiceId, "main_invoice_reconciliation"),
    deposit, depositWriter: writer(deposit.executionId, depositPayload, scope.depositXeroInvoiceId, "deposit_invoice") });
}
export function previewFixture() {
  const { main, deposit } = drafts(), anchorEvidence = anchors(), sourceSnapshot = { ...source(), tenantIdHash: financialSha256("tenant") };
  const evidence = { scopeKey: D702946_RECOVERY_SCOPE_KEY, dealId: scope.dealId, dealNumber: scope.dealNumber, originalMainEventId: scope.originalMainEventId,
    failedMainWriterExecutionId: scope.failedMainWriterExecutionId, mainRecoveryEventId: 1, mainRecoveryWriterExecutionId: scope.mainRecoveryWriterExecutionId,
    depositEventId: scope.depositEventId, depositWriterExecutionId: 1090001, mainInvoiceNumber: scope.mainInvoiceNumber, mainXeroInvoiceId: scope.mainXeroInvoiceId,
    depositInvoiceNumber: scope.depositInvoiceNumber, depositXeroInvoiceId: scope.depositXeroInvoiceId, anchorEvidenceHash: financialSha256(anchorEvidence), anchorEvidence,
    sourceSnapshotHash: financialSha256(sourceSnapshot), sourceSnapshot, xeroEvidenceHash: financialSha256({ main, deposit }), mainXeroSnapshot: main, depositXeroSnapshot: deposit };
  return { status: "ready" as const, noWrites: true as const, evidence, payload: prepareD702946DepositMainDeductionRecoveryPayload(main, deposit, financialSha256(evidence)) };
}
export function receipt() {
  const p = previewFixture(), approval = policy();
  return { id: 1, ...p.evidence, recoveryKey: financialSha256({ evidence: p.evidence, payload: p.payload, policy: approval }), authorisedPayload: p.payload,
    payloadHash: financialSha256(p.payload), releaseKey: approval.releaseKey, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt,
    policyHash: financialSha256(approval), processingToken: "token", status: "reserved", executionId: null, submittedAt: null };
}
export function updatedDraft(payload: FinancialDraftPayload = previewFixture().payload) {
  const { main } = drafts();
  return { ...main, ...(payload.body.Invoices as any[])[0], DateString: main.DateString, DueDateString: main.DueDateString,
    SubTotal: 8574.60, TotalTax: 857.47, Total: 9432.07, LineItems: [...main.LineItems, { ...scope.deduction, LineItemID: "new-deduction-id" }] };
}
