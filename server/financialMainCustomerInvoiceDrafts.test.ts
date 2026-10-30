import { afterEach, describe, expect, it } from "vitest";
import { applyMainCustomerInvoiceXeroTransportDescription, buildMainCustomerInvoice, mainCustomerInvoiceContainerHireItemCode, mainCustomerInvoiceNumber, mainCustomerInvoiceTransportItemCode } from "./financialMainCustomerInvoiceDrafts";
import { assertMainCustomerInvoiceRelease, resolveMainCustomerInvoiceRelease } from "./financialMainCustomerInvoiceRelease";

const facts = (overrides: Record<string, unknown> = {}) => ({
  dealId: "5x702877", dealNumber: "D702877", quoteId: "20x44", quoteNumber: "Q-702877",
  customerVtigerId: "4x99", customerName: "ContainerZone Customer", customerKind: "organisation" as const,
  containerSituation: "SHIPPER OWN", originSuburb: "Originville", destinationSuburb: "Destinationton",
  fullContainerPickupDate: "2026-10-11", depositStatus: "PENDING",
  mappingEvidence: { fullContainerPickupDate: "cf_potentials_fullcontainercollectiondate", depositStatus: "cf_potentials_depositstatus" },
  sourceHoldReason: null,
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
    expect(result.document?.issueDate?.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(result.document?.dueDate?.toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });

  it("matches Xero's per-line GST rounding for D702959-like hire and transport lines", () => {
    const result = buildMainCustomerInvoice(facts({
      dealNumber: "D702959",
      quoteNumber: "Q531901",
      containerSituation: "HIRED",
      serviceLines: [
        { serviceVtigerId: "14x9591", description: "20 Foot Standard Height Container Hire per 30 days", quantity: 1, unitAmount: 224.75 },
        { serviceVtigerId: "14x9592", description: "Transport - Empty & Loaded Container", quantity: 1, unitAmount: 3596.57 },
      ],
    }));

    expect(result.document).toMatchObject({
      proposedDocumentNumber: "INV-702959",
      subtotal: 3821.32,
      taxAmount: 382.14,
      total: 4203.46,
      lineItems: [
        { itemCode: "20' Hire", description: "20 Foot Standard Height Container Hire per 30 days", quantity: 1, unitAmount: 224.75, lineAmount: 224.75, taxRate: 10 },
        { itemCode: "SER60", description: "Pending current Xero SER60 route description", quantity: 1, unitAmount: 3596.57, lineAmount: 3596.57, taxRate: 10 },
      ],
    });
    expect(result.document?.taxAmount).not.toBe(382.13);
    expect(result.document?.total).not.toBe(4203.45);
  });

  it("calculates a line from the cents-rounded Xero UnitAmount before GST", () => {
    const result = buildMainCustomerInvoice(facts({
      serviceLines: [{ serviceVtigerId: "14x100", description: "Container handling", quantity: 3, unitAmount: 33.333 }],
    }));

    expect(result.document).toMatchObject({
      subtotal: 99.99,
      taxAmount: 10,
      total: 109.99,
      lineItems: [expect.objectContaining({ unitAmount: 33.33, lineAmount: 99.99 })],
    });
  });

  it("uses the current pickup calendar date and normalized ON ACCOUNT status for the approved fourteen-day term", () => {
    const result = buildMainCustomerInvoice(facts({
      fullContainerPickupDate: "2026-10-04",
      depositStatus: "  on   account ",
    }));

    expect(result).toMatchObject({ eligible: true });
    expect(result.document?.issueDate?.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(result.document?.dueDate?.toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });

  it("uses the default two-day term when the current Deposit Status is blank", () => {
    const result = buildMainCustomerInvoice(facts({
      fullContainerPickupDate: "2026-10-04",
      depositStatus: "",
    }));

    expect(result).toMatchObject({ eligible: true });
    expect(result.document?.issueDate?.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(result.document?.dueDate?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("uses the Operations Sydney creation-date fallback and omits DueDate when pickup date is blank", () => {
    const result = buildMainCustomerInvoice(facts({ fullContainerPickupDate: "" }), new Date("2026-10-18T13:00:00.000Z"));

    expect(result).toMatchObject({ eligible: true });
    expect(result.document?.issueDate?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(result.document?.dueDate).toBeNull();
  });

  it("accepts the requested Australian DD/MM/YY and DD/MM/YYYY pickup-date formats", () => {
    const shortYear = buildMainCustomerInvoice(facts({ fullContainerPickupDate: "04/11/26" }));
    const longYear = buildMainCustomerInvoice(facts({ fullContainerPickupDate: "04/11/2026" }));

    expect(shortYear.document?.issueDate?.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(shortYear.document?.dueDate?.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(longYear.document?.issueDate?.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(longYear.document?.dueDate?.toISOString()).toBe("2026-11-06T00:00:00.000Z");
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

  it("uses the verified 20/40 Hire items while preserving exact hire Quote descriptions", () => {
    const proposal = buildMainCustomerInvoice(facts({
      dealNumber: "D702941",
      quoteNumber: "Q531794",
      containerSituation: "HIRED",
      originSuburb: "BRENDALE, 4500, QLD",
      destinationSuburb: "MORPHETT VALE, 5162, SA",
      serviceLines: [
        { serviceVtigerId: "25x7217", description: "20 Foot Standard Height Container Hire per 30 days", quantity: 1, unitAmount: 209.25 },
        { serviceVtigerId: "25x7218", description: "40 Foot Standard Height Container Hire per 30 days", quantity: 2, unitAmount: 309.25 },
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
      expect.objectContaining({ itemCode: "20' Hire", description: "20 Foot Standard Height Container Hire per 30 days", quantity: 1, unitAmount: 209.25, accountCode: "200" }),
      expect.objectContaining({ itemCode: "40' Hire", description: "40 Foot Standard Height Container Hire per 30 days", quantity: 2, unitAmount: 309.25, accountCode: "200" }),
      expect.objectContaining({ itemCode: "SER60", description: "Empty & Loaded Container from BRENDALE, 4500, QLD to MORPHETT VALE, 5162, SA", quantity: 1, unitAmount: 4251.83, accountCode: "200" }),
    ]);
    expect(mainCustomerInvoiceContainerHireItemCode("20 Foot Standard Height Container Hire per 30 days")).toBe("20' Hire");
    expect(mainCustomerInvoiceContainerHireItemCode("40 Foot Standard Height Container Hire per 30 days")).toBe("40' Hire");
    expect(mainCustomerInvoiceContainerHireItemCode("20 Foot Standard Height Container - Cargoworthy Grade")).toBeNull();
    expect(mainCustomerInvoiceContainerHireItemCode("20 Foot High Cube Container Hire per 30 days")).toBe("20' Hire");
  });

  it("holds rather than inferring customer, Quote or malformed service evidence", () => {
    expect(buildMainCustomerInvoice(facts({ quoteId: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Quote") });
    expect(buildMainCustomerInvoice(facts({ customerName: "" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("customer") });
    const transportLine = [{ serviceVtigerId: "14x10", description: "Transport - Loaded Container", quantity: 1, unitAmount: 250 }];
    expect(buildMainCustomerInvoice(facts({ containerSituation: "IMPORT", serviceLines: transportLine }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Container Situation") });
    expect(buildMainCustomerInvoice(facts({ originSuburb: "", serviceLines: transportLine }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Origin Suburb") });
    expect(buildMainCustomerInvoice(facts({ serviceLines: [{ serviceVtigerId: "", description: "", quantity: 0, unitAmount: 0 }] }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("billable Service") });
    expect(buildMainCustomerInvoice(facts({ fullContainerPickupDate: "31/02/26" }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("Pickup DATE") });
    expect(buildMainCustomerInvoice(facts({ fullContainerPickupDate: "" }))).toMatchObject({ eligible: true });
    expect(buildMainCustomerInvoice(facts({ sourceHoldReason: "Deal field mapping for Full Container Pickup DATE is missing or ambiguous; no alias will be guessed." }))).toMatchObject({ eligible: false, holdReason: expect.stringContaining("mapping") });
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
