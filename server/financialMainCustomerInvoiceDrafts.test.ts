import { afterEach, describe, expect, it } from "vitest";
import { buildMainCustomerInvoice, mainCustomerInvoiceNumber } from "./financialMainCustomerInvoiceDrafts";
import { assertMainCustomerInvoiceRelease, resolveMainCustomerInvoiceRelease } from "./financialMainCustomerInvoiceRelease";

const facts = (overrides: Record<string, unknown> = {}) => ({
  dealId: "5x702877", dealNumber: "D702877", quoteId: "20x44", quoteNumber: "Q-702877",
  customerVtigerId: "4x99", customerName: "ContainerZone Customer", customerKind: "organisation" as const,
  sourceRefreshedAt: "2026-10-11T00:00:00.000Z",
  serviceLines: [
    { serviceVtigerId: "14x10", description: "Rail delivery", quantity: 2, unitAmount: 250 },
    { serviceVtigerId: "14x11", description: "Container handling", quantity: 1, unitAmount: 100 },
  ],
  ...overrides,
});

afterEach(() => delete process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED);

describe("Main Customer Invoice rules", () => {
  it("preserves current Quote service quantities and list prices in one GST-exclusive INV Draft proposal", () => {
    const result = buildMainCustomerInvoice(facts(), new Date("2026-10-11T04:00:00.000Z"));
    expect(mainCustomerInvoiceNumber("D702877")).toBe("INV-702877");
    expect(result).toMatchObject({ eligible: true, proposedInvoiceNumber: "INV-702877" });
    expect(result.document).toMatchObject({ documentFamily: "customer_invoice", documentType: "main_customer_invoice", proposedDocumentNumber: "INV-702877", reference: "Q-702877", partyName: "ContainerZone Customer", accountCode: "200", subtotal: 600, taxAmount: 60, total: 660 });
    expect(result.document?.lineItems).toEqual([
      expect.objectContaining({ description: "Rail delivery", quantity: 2, unitAmount: 250, accountCode: "200", gstTreatment: "GST_EXCLUSIVE" }),
      expect.objectContaining({ description: "Container handling", quantity: 1, unitAmount: 100, accountCode: "200", gstTreatment: "GST_EXCLUSIVE" }),
    ]);
  });

  it("holds rather than inferring customer, Quote or malformed service evidence", () => {
    expect(buildMainCustomerInvoice(facts({ quoteId: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Quote") });
    expect(buildMainCustomerInvoice(facts({ customerName: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("customer") });
    expect(buildMainCustomerInvoice(facts({ serviceLines: [{ serviceVtigerId: "", description: "", quantity: 0, unitAmount: 0 }] }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("billable Service") });
  });
});

describe("Main Customer Invoice release policy", () => {
  it("is default-off and requires its independent deployment flag plus both handovers", () => {
    const disabled = resolveMainCustomerInvoiceRelease({});
    expect(disabled).toMatchObject({ enabled: false, migrationScope: "new_events_only" });
    expect(() => assertMainCustomerInvoiceRelease(disabled)).toThrow(/disabled/);
    process.env.FINANCIAL_MAIN_CUSTOMER_INVOICE_AUTOMATIC_ENABLED = "true";
    const active = resolveMainCustomerInvoiceRelease({ releaseKey: "MAIN-INV-test", enabled: true, approvedBy: 7, approvedAt: "2026-10-11T00:00:00.000Z", effectiveFrom: "2026-10-11T00:00:00.000Z", mainInvoiceOnlyVtigerBranch: true, operationsMainInvoiceHandoff: true });
    expect(() => assertMainCustomerInvoiceRelease(active)).not.toThrow();
    expect(() => assertMainCustomerInvoiceRelease({ ...active, operationsMainInvoiceHandoff: false })).toThrow(/handover/);
  });
});
