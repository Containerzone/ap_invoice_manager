import { afterEach, describe, expect, it } from "vitest";
import { assertFinancialDraftWriteAuthorised } from "./financialProductionWriter";

afterEach(() => delete process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED);

describe("Main Customer Invoice isolated writer gate", () => {
  const context = () => ({ workflowType: "main_customer_invoice", approvalReference: "MAIN-INV-test", globalShadowMode: false, familyLiveEnabled: true, releaseManifestApproved: true, cutoverPackApproved: true, currentDocumentPreflightPassed: true, legacyWriterHandoffComplete: true, mainCustomerInvoiceAutomaticEventId: 41, mainCustomerInvoiceReleaseKey: "MAIN-INV-test", mainCustomerInvoiceApprovedBy: 7 });
  it("does not inherit global financial writer or any purchase-order family gate", () => {
    expect(() => assertFinancialDraftWriteAuthorised(context(), { requireExecutionId: false })).toThrow(/Main Customer Invoice automatic release gate/);
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED = "true";
    expect(() => assertFinancialDraftWriteAuthorised(context(), { requireExecutionId: false })).not.toThrow();
    expect(() => assertFinancialDraftWriteAuthorised({ ...context(), workflowType: "asset_purchase" }, { requireExecutionId: false })).toThrow(/Main Customer Invoice automatic release gate/);
  });
});
