import { describe, expect, it } from "vitest";
import { prepareVerifiedFinancialDraftPayload } from "./financialVerifiedDraftPayload";

const document = {
  documentFamily: "customer_invoice" as const,
  documentType: "main_invoice",
  proposedAction: "create_draft" as const,
  proposedDocumentNumber: "INV-7002",
  reference: null,
  partyName: "Customer Pty Ltd",
  partySourceId: null,
  accountCode: "200",
  gstTreatment: "GST_EXCLUSIVE" as const,
  currency: "AUD" as const,
  issueDate: null,
  dueDate: null,
  subtotal: 100,
  taxAmount: 10,
  total: 110,
  lineItems: [{ itemCode: "SER1", description: "Service", quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "200", taxRate: 10, gstTreatment: "GST_EXCLUSIVE" as const }],
  validationStatus: "valid" as const,
  sourceWorkflow: "main_customer_invoice" as const,
  sourceRecordId: "4x7002",
};

const preflight = {
  documentNumber: "INV-7002",
  documentFamily: "customer_invoice" as const,
  duplicateState: "not_found" as const,
  xeroDocumentId: null,
  status: null,
  partyName: null,
  itemChecks: [{ itemCode: "SER1", found: true, purchaseUnitPrice: null, salesUnitPrice: 100, nativeDescription: "Service" }],
  contactCheck: { partyName: "Customer Pty Ltd", found: true, count: 1, contactId: "contact-verified" },
  error: null,
};

describe("verified financial Draft payload", () => {
  it("uses only the freshly preflighted Xero ContactID, never a name payload", () => {
    const payload = prepareVerifiedFinancialDraftPayload({ document, workflowIdempotencyKey: "run-7002", preflight });
    expect((payload.body.Invoices as Array<any>)[0].Contact).toEqual({ ContactID: "contact-verified" });
  });

  it("rejects a name-only or stale preflight before a payload can be prepared", () => {
    expect(() => prepareVerifiedFinancialDraftPayload({
      document,
      workflowIdempotencyKey: "run-7002",
      preflight: { ...preflight, contactCheck: { ...preflight.contactCheck, contactId: null } },
    })).toThrow(/ContactID/);
    expect(() => prepareVerifiedFinancialDraftPayload({
      document,
      workflowIdempotencyKey: "run-7002",
      preflight: { ...preflight, documentNumber: "INV-OTHER" },
    })).toThrow(/document number/);
  });
});
