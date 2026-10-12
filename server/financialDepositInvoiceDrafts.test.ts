import { describe, expect, it } from "vitest";
import {
  buildDepositInvoice,
  depositInvoiceNumber,
  type DepositInvoiceFacts,
} from "./financialDepositInvoiceDrafts";
import { prepareFinancialDraftPayload } from "./financialProductionWriter";
const facts = (
  patch: Partial<DepositInvoiceFacts> = {}
): DepositInvoiceFacts => ({
  dealId: "5x77",
  dealNumber: "D702877",
  depositStatus: "PENDING",
  depositAmountRequiredInclusive: 110,
  customerVtigerId: "4x2",
  customerName: "Customer Pty Ltd",
  customerKind: "organisation",
  emptyContainerSupplyDate: "2026-10-12",
  fullContainerCollectionDate: "",
  sourceRefreshedAt: "2026-10-11T01:00:00Z",
  customerRefreshedAt: null,
  mappingEvidence: {},
  sourceHoldReason: null,
  ...patch,
});
describe("Deposit isolated Draft calculations", () => {
  it("keeps the source total GST-inclusive in an exact AUD Draft ACCREC, not a purchase order or exclusive inflated invoice", () => {
    const result = buildDepositInvoice(
      facts(),
      new Date("2026-10-11T02:00:00Z")
    );
    expect(result).toMatchObject({
      eligible: true,
      proposedInvoiceNumber: "INV-702877-D",
      dueDateSource: "empty_container_supply_date",
    });
    expect(result.document).toMatchObject({
      subtotal: 100,
      taxAmount: 10,
      total: 110,
      gstTreatment: "GST_INCLUSIVE",
      sourceWorkflow: "deposit_invoice",
    });
    result.document!.partySourceId = "xero-customer";
    result.document!.accountCode = "201";
    result.document!.lineItems[0]!.accountCode = "201";
    const payload = prepareFinancialDraftPayload(result.document!, "test");
    (payload.body.Invoices as any[])[0].CurrencyCode = "AUD";
    expect(payload).toMatchObject({
      method: "POST",
      endpoint: "/Invoices",
      documentNumber: "INV-702877-D",
      expectedXeroDocumentId: null,
    });
    expect((payload.body.Invoices as any[])[0]).toMatchObject({
      Type: "ACCREC",
      Status: "DRAFT",
      LineAmountTypes: "Inclusive",
      CurrencyCode: "AUD",
      DueDate: "2026-10-12",
      LineItems: [
        {
          ItemCode: "Deposit Required",
          Quantity: 1,
          UnitAmount: 110,
          TaxType: "OUTPUT",
        },
      ],
    });
    expect(result.postconditionHold).toMatch(/never amends a main invoice/);
  });
  it.each(["", " pending ", "PENDING"])(
    "permits historical blank/PENDING status %j",
    status =>
      expect(
        buildDepositInvoice(facts({ depositStatus: status })).eligible
      ).toBe(true)
  );
  it.each(["PAID", "CANCELLED", "REQUIRED"])("holds other status %j", status =>
    expect(
      buildDepositInvoice(facts({ depositStatus: status })).holdReason
    ).toMatch(/Status/)
  );
  it.each([null, 0, -110, Number.NaN, Number.POSITIVE_INFINITY, 0.001])(
    "holds invalid or unbillable amount %s",
    amount =>
      expect(
        buildDepositInvoice(facts({ depositAmountRequiredInclusive: amount }))
          .eligible
      ).toBe(false)
  );
  it("rounds GST to cents without adding 10% to an inclusive amount", () =>
    expect(
      buildDepositInvoice(facts({ depositAmountRequiredInclusive: 123.45 }))
        .document
    ).toMatchObject({ total: 123.45, subtotal: 112.23, taxAmount: 11.22 }));
  it("never builds a number from a webservice ID or arbitrary non-Deal text", () => {
    for (const value of ["5x77", "foo702877", "", "INV-702877-D"])
      expect(depositInvoiceNumber(value)).toBeNull();
    expect(depositInvoiceNumber("D000123")).toBe("INV-000123-D");
  });
  it("uses collection when supply is absent, preserves equal-date evidence, and holds only conflicting or malformed dates", () => {
    expect(
      buildDepositInvoice(
        facts({
          emptyContainerSupplyDate: "",
          fullContainerCollectionDate: "2026-10-13",
        })
      ).dueDateSource
    ).toBe("full_container_collection_date");
    expect(
      buildDepositInvoice(facts({ fullContainerCollectionDate: "2026-10-12" }))
        .eligible
    ).toBe(true);
    expect(
      buildDepositInvoice(facts({ fullContainerCollectionDate: "2026-10-13" }))
        .holdReason
    ).toMatch(/precedence/);
    expect(
      buildDepositInvoice(facts({ emptyContainerSupplyDate: "2026-02-30" }))
        .holdReason
    ).toMatch(/invalid/);
    const noDate = buildDepositInvoice(
      facts({
        emptyContainerSupplyDate: "",
        fullContainerCollectionDate: "",
      })
    );
    expect(noDate).toMatchObject({
      eligible: true,
      dueDateSource: "not_set",
    });
    expect(noDate.document?.dueDate).toBeNull();
  });
  it("holds unconfirmed schema or absent customer rather than inventing mappings", () => {
    expect(
      buildDepositInvoice(facts({ sourceHoldReason: "Unconfirmed mapping" }))
        .holdReason
    ).toBe("Unconfirmed mapping");
    expect(buildDepositInvoice(facts({ customerVtigerId: "" })).eligible).toBe(
      false
    );
  });
});
