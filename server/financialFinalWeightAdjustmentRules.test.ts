import { describe, expect, it } from "vitest";
import { assertFinalWeightReadback, buildFinalWeightAdjustment, finalWeightDate, finalWeightDraftEvidence, finalWeightSydneyCalendarDueDate, normalizedFinalWeightDepositStatus, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { baseLine, facts, invoice, xero } from "./_test/finalWeightFixtures";
describe("Final weight isolated pure Draft amendment rules", () => {
  it("adds one positive GST-exclusive SER70 and preserves every original full line/header", () => {
    const evidence = xero(); const before = structuredClone(evidence);
    const result = buildFinalWeightAdjustment(facts(), "overweight", evidence);
    expect(result.eligible).toBe(true); expect(result.excessAmountExclusive).toBe(250);
    expect(result.expectedDraft!.LineItems[0]).toEqual(baseLine());
    expect(result.expectedDraft!.LineItems[1]).toEqual({ ItemCode: "SER70", Description: "Excess weight", Quantity: 1, UnitAmount: 250, AccountCode: "200", TaxType: "OUTPUT" });
    const { LineItems: _, Reference: _reference, Date: _date, DueDate: _dueDate, ...headers } = result.originalDraft!;
    expect(result.expectedDraft).toMatchObject(headers); expect(evidence).toEqual(before);
    expect(result.expectedDraft!.Reference).toBe("Synthetic Customer PO");
    expect(result.expectedDraft).toMatchObject({ Date: "2026-10-20", DueDate: "2026-10-22" });
    const payload = prepareFinalWeightPayload(result, "source");
    expect(payload).toMatchObject({ method: "POST", endpoint: "/Invoices/invoice-exact", expectedXeroDocumentId: "invoice-exact", documentNumber: "INV-702877" });
    expect(payload.body.Invoices).toEqual([result.expectedDraft]);
    expect(prepareFinalWeightPayload(result, "source")).toEqual(payload);
  });
  it("replaces all duplicate SER70 at its first position, retains one existing line ID and never drops unrelated lines", () => {
    const retained = { ...baseLine(), LineItemID: "line-other", Description: "Other line" };
    const previous = { ...baseLine(), ItemCode: "SER70", LineItemID: "ser-original" };
    const full = invoice({ LineItems: [baseLine(), previous, retained, { ...previous, ItemCode: "ser70", LineItemID: "duplicate" }] });
    const result = buildFinalWeightAdjustment(facts(), "overweight", xero({ invoice: full }));
    expect(result.expectedDraft!.LineItems).toHaveLength(3);
    expect(result.expectedDraft!.LineItems[0]).toEqual(baseLine());
    expect(result.expectedDraft!.LineItems[1]).toMatchObject({ ItemCode: "SER70", UnitAmount: 250, LineItemID: "ser-original" });
    expect(result.expectedDraft!.LineItems[1]).not.toHaveProperty("TaxAmount");
    expect(result.expectedDraft!.LineItems[2]).toEqual(retained);
  });
  it("overweight prioritizes the current Deal Customer PO for Reference", () => {
    const result = buildFinalWeightAdjustment(facts({ customerPO: "  PO-42  ", dealName: "Container 8" }), "overweight", xero());
    expect(result).toMatchObject({ eligible: true, expectedDraft: { Reference: "PO-42" } });
    const readback = invoice({ Date: "2026-10-20", DueDate: "2026-10-22", Reference: "PO-42", LineItems: [baseLine(), { ...result.expectedDraft!.LineItems[1], LineItemID: "new-ser70", LineAmount: 250, TaxAmount: 25 }], SubTotal: 340, TotalTax: 34, Total: 374 });
    expect(() => assertFinalWeightReadback(readback, result.expectedDraft!)).not.toThrow();
    expect(() => assertFinalWeightReadback({ ...readback, Reference: "wrong" }, result.expectedDraft!)).toThrow(/Reference/);
  });
  it("accepts an exact Xero Draft amendment when Xero reorders its retained and new lines", () => {
    const result = buildFinalWeightAdjustment(facts({ customerPO: "PO-42" }), "overweight", xero());
    const readback = invoice({
      Date: "2026-10-20",
      DueDate: "2026-10-22",
      Reference: "PO-42",
      LineItems: [
        { ...result.expectedDraft!.LineItems[1], LineItemID: "new-ser70", LineAmount: 250, TaxAmount: 25 },
        baseLine(),
      ],
      SubTotal: 340,
      TotalTax: 34,
      Total: 374,
    });
    expect(() => assertFinalWeightReadback(readback, result.expectedDraft!)).not.toThrow();
  });
  it("overweight falls back only to the current Deal Container number when Customer PO is blank", () => {
    const result = buildFinalWeightAdjustment(facts({ customerPO: "  ", dealName: "Container 8" }), "overweight", xero());
    expect(result).toMatchObject({ eligible: true, expectedDraft: { Reference: "Container 8" } });
  });
  it("underweight changes exactly Date/DueDate with no new or negative line, even if existing SER70 exists", () => {
    const full = invoice({ LineItems: [baseLine(), { ...baseLine(), ItemCode: "SER70", LineItemID: "existing-ser" }] });
    const result = buildFinalWeightAdjustment(facts({ actualWeight: 9, collectionDate: "2026-10-20", perExtraTonne: null }), "underweight", xero({ invoice: full, ser70: null }));
    expect(result.eligible).toBe(true);
    expect(result.expectedDraft!.LineItems).toEqual(full.LineItems);
    expect(result.expectedDraft).toEqual({ ...result.originalDraft, Date: "2026-10-20", DueDate: "2026-10-22" });
    expect(result.expectedDraft!.Reference).toBe("Preserve this reference");
    expect(result.excessAmountExclusive).toBeNull();
  });
  it("uses ON ACCOUNT case/whitespace-normalized Deposit Status for a 14-Sydney-calendar-day due date", () => {
    const result = buildFinalWeightAdjustment(facts({ collectionDate: "2026-10-04", depositStatus: "  on   account  " }), "overweight", xero());
    expect(result).toMatchObject({ eligible: true, expectedDraft: { Date: "2026-10-04", DueDate: "2026-10-18" } });
    expect(finalWeightSydneyCalendarDueDate("2026-10-04", "Deposit Required")).toBe("2026-10-06");
    expect(normalizedFinalWeightDepositStatus("  on   account  ")).toBe("ON ACCOUNT");
  });
  it("uses the default two-Sydney-calendar-day due date when the current Deposit Status is blank", () => {
    const result = buildFinalWeightAdjustment(facts({ collectionDate: "2026-10-04", depositStatus: "" }), "overweight", xero());
    expect(result).toMatchObject({ eligible: true, expectedDraft: { Date: "2026-10-04", DueDate: "2026-10-06" } });
  });
  it.each(["AUTHORISED", "PAID", "VOIDED", "DELETED", "SUBMITTED", "DRAFT "])("holds status %s without an invoice proposal", status => {
    const result = buildFinalWeightAdjustment(facts(), "overweight", xero({ exactMatches: [invoice({ Status: status })], invoice: invoice({ Status: status }) }));
    expect(result.eligible).toBe(false);
    expect(result.holdReason).toContain(`is ${status.trim().toUpperCase()} ACCREC`);
  });
  it.each([
    { exactMatches: [] }, { exactMatches: [invoice(), invoice({ InvoiceID: "collision", Status: "DELETED" })] },
    { invoice: null }, { invoice: invoice({ InvoiceID: "wrong-id" }) }, { invoice: invoice({ InvoiceNumber: "INV-702877-D" }) },
    { invoice: invoice({ Type: "ACCPAY" }) }, { invoice: invoice({ AmountPaid: 1 }) }, { invoice: invoice({ Payments: [{}] }) },
    { invoice: invoice({ AmountCredited: 1 }) }, { invoice: invoice({ CreditNotes: [{}] }) }, { invoice: invoice({ CurrencyCode: "NZD" }) },
    { invoice: invoice({ LineAmountTypes: "Inclusive" }) },
    { invoice: invoice({ LineItems: [] }) }, { invoice: invoice({ LineItems: [{ Description: "partial" }] }) },
    { contact: { count: 2, contactId: "customer-exact", partyName: "Synthetic Customer" } },
    { invoice: invoice({ Contact: { ContactID: "wrong" } }) }, { ser70: null },
  ])("holds incomplete/non-exact/colliding Xero evidence %#", patch => {
    expect(buildFinalWeightAdjustment(facts(), "overweight", xero(patch as any))).toMatchObject({ eligible: false, expectedDraft: null });
  });
  it.each([
    { dealNumber: "702877" }, { dealNumber: "D702877-D" }, { dealName: "" }, { customerVtigerId: "bad" }, { customerName: "" },
    { estimatedWeight: null }, { actualWeight: NaN }, { actualWeight: -1 }, { estimatedWeight: -1 }, { actualWeight: 10 }, { actualWeight: 9 },
    { perExtraTonne: 0 }, { perExtraTonne: -2 }, { perExtraTonne: Infinity }, { sourceHoldReason: "Ambiguous metadata" },
  ])("holds invalid current overweight source %#", patch => {
    expect(buildFinalWeightAdjustment(facts(patch), "overweight", xero()).eligible).toBe(false);
  });
  it.each([null, "", "2026-02-30", "20-10-2026", "2026-10-20T04:00:00Z"])("both routes hold missing/ambiguous collection date %s", collectionDate => {
    expect(buildFinalWeightAdjustment(facts({ collectionDate }), "overweight", xero()).eligible).toBe(false);
    expect(buildFinalWeightAdjustment(facts({ actualWeight: 9, collectionDate }), "underweight", xero()).eligible).toBe(false);
  });
  it.each([null, 10, {}, []])("both routes hold missing/non-scalar Deposit Status %#", depositStatus => {
    expect(buildFinalWeightAdjustment(facts({ depositStatus: depositStatus as any }), "overweight", xero()).eligible).toBe(false);
    expect(buildFinalWeightAdjustment(facts({ actualWeight: 9, depositStatus: depositStatus as any }), "underweight", xero()).eligible).toBe(false);
  });
  it("rounds positive net excess to cents but holds rounded zero and overflow", () => {
    expect(buildFinalWeightAdjustment(facts({ actualWeight: 10.12345, perExtraTonne: 12.34 }), "overweight", xero()).excessAmountExclusive).toBe(1.52);
    expect(buildFinalWeightAdjustment(facts({ actualWeight: 10.000001 }), "overweight", xero()).eligible).toBe(false);
    expect(buildFinalWeightAdjustment(facts({ actualWeight: 1e20 }), "overweight", xero()).eligible).toBe(false);
  });
  it("normalizes exact Xero dates and validates all retained line keys in readback", () => {
    expect(finalWeightDate("/Date(1791676800000+0000)/")).toBe("2026-10-11");
    expect(finalWeightDate("2026-02-30")).toBeNull();
    const original = invoice(); const expected = finalWeightDraftEvidence(original);
    expect(() => assertFinalWeightReadback(original, expected)).not.toThrow();
    for (const key of ["ItemCode", "Description", "Quantity", "UnitAmount", "TaxType", "AccountCode", "DiscountRate", "Tracking", "LineItemID", "TaxAmount"]) {
      const changed = structuredClone(original); changed.LineItems[0][key as keyof typeof changed.LineItems[0]] = "wrong" as never;
      expect(() => assertFinalWeightReadback(changed, expected)).toThrow(/line/);
    }
    for (const patch of [{ DueDate: "2026-10-22" }, { Reference: "lost" }, { Contact: { ContactID: "wrong" } }, { LineItems: [] }]) expect(() => assertFinalWeightReadback({ ...original, ...patch }, expected)).toThrow();
  });
});
