import { afterEach, describe, expect, it } from "vitest";
import { applyMainCustomerInvoiceXeroTransportDescription, buildMainCustomerInvoice, mainCustomerInvoiceNumber, mainCustomerInvoiceTransportItemCode } from "./financialMainCustomerInvoiceDrafts";
import { assertMainCustomerInvoiceRelease, resolveMainCustomerInvoiceRelease } from "./financialMainCustomerInvoiceRelease";

const facts = (overrides: Record<string, unknown> = {}) => ({
  dealId: "5x702877", dealNumber: "D702877", quoteId: "20x44", quoteNumber: "Q-702877",
  customerVtigerId: "4x99", customerName: "ContainerZone Customer", customerKind: "organisation" as const,
  containerSituation: "SHIPPER OWN", originSuburb: "Originville", destinationSuburb: "Destinationton",
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
      expect.objectContaining({ itemCode: "", description: "Rail delivery", quantity: 2, unitAmount: 250, accountCode: "200", gstTreatment: "GST_EXCLUSIVE" }),
      expect.objectContaining({ itemCode: "", description: "Container handling", quantity: 1, unitAmount: 100, accountCode: "200", gstTreatment: "GST_EXCLUSIVE" }),
    ]);
  });

  it("maps only the authorised current Deal container situations and renders the native Xero route template", () => {
    expect(mainCustomerInvoiceTransportItemCode("SHIPPER OWN")).toBe("SER9");
    expect(mainCustomerInvoiceTransportItemCode("PURCHASED")).toBe("SER60");
    expect(mainCustomerInvoiceTransportItemCode("HIRED")).toBe("SER60");
    expect(mainCustomerInvoiceTransportItemCode("IMPORT")).toBeNull();
    const proposal = buildMainCustomerInvoice(facts({
      containerSituation: "PURCHASED",
      serviceLines: [
        { serviceVtigerId: "14x10", description: "20 Foot Standard Height Container - Cargoworthy Grade", quantity: 1, unitAmount: 2250 },
        { serviceVtigerId: "14x11", description: "Transport - Empty & Loaded Container", quantity: 1, unitAmount: 6877.16 },
      ],
    })).document!;
    expect(applyMainCustomerInvoiceXeroTransportDescription({ document: proposal, nativeDescription: "Empty & Loaded Container from <> to <>", originSuburb: "Port", destinationSuburb: "Depot" })?.lineItems)
      .toEqual([
        expect.objectContaining({ itemCode: "20' Sale", description: "20 Foot Standard Height Container - Cargoworthy Grade", quantity: 1, unitAmount: 2250 }),
        expect.objectContaining({ itemCode: "SER60", description: "Empty & Loaded Container from Port to Depot", quantity: 1, unitAmount: 6877.16 }),
      ]);
    expect(applyMainCustomerInvoiceXeroTransportDescription({ document: proposal, nativeDescription: "Wrong template", originSuburb: "Port", destinationSuburb: "Depot" })).toBeNull();
  });

  it("retains every non-transport Quote line, including a container-hire service, without inferring a Sale or transport item", () => {
    const proposal = buildMainCustomerInvoice(facts({
      dealNumber: "D702941",
      quoteNumber: "Q531794",
      containerSituation: "HIRED",
      originSuburb: "BRENDALE, 4500, QLD",
      destinationSuburb: "MORPHETT VALE, 5162, SA",
      serviceLines: [
        { serviceVtigerId: "25x7217", description: "20 Foot Standard Height Container Hire per 30 days", quantity: 1, unitAmount: 209.25 },
        { serviceVtigerId: "25x258945", description: "Transport - Empty & Loaded Container", quantity: 1, unitAmount: 4251.83 },
      ],
    })).document!;

    const rendered = applyMainCustomerInvoiceXeroTransportDescription({
      document: proposal,
      nativeDescription: "Empty & Loaded Container from <> to <>",
      originSuburb: "BRENDALE, 4500, QLD",
      destinationSuburb: "MORPHETT VALE, 5162, SA",
    });

    expect(rendered?.lineItems).toEqual([
      expect.objectContaining({ itemCode: "", description: "20 Foot Standard Height Container Hire per 30 days", quantity: 1, unitAmount: 209.25, accountCode: "200" }),
      expect.objectContaining({ itemCode: "SER60", description: "Empty & Loaded Container from BRENDALE, 4500, QLD to MORPHETT VALE, 5162, SA", quantity: 1, unitAmount: 4251.83, accountCode: "200" }),
    ]);
  });

  it("holds rather than inferring customer, Quote or malformed service evidence", () => {
    expect(buildMainCustomerInvoice(facts({ quoteId: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Quote") });
    expect(buildMainCustomerInvoice(facts({ customerName: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("customer") });
    const transportLine = [{ serviceVtigerId: "14x10", description: "Transport - Loaded Container", quantity: 1, unitAmount: 250 }];
    expect(buildMainCustomerInvoice(facts({ containerSituation: "IMPORT", serviceLines: transportLine }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Container Situation") });
    expect(buildMainCustomerInvoice(facts({ originSuburb: "", serviceLines: transportLine }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Origin Suburb") });
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
