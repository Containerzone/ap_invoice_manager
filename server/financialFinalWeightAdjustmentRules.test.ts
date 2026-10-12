import { describe, expect, it } from "vitest";
import { assertFinalWeightReadback, buildFinalWeightAdjustment, finalWeightDate, finalWeightDraftEvidence, prepareFinalWeightPayload } from "./financialFinalWeightAdjustmentRules";
import { baseLine, facts, invoice, xero } from "./_test/finalWeightFixtures";
describe("Final weight isolated pure Draft amendment rules", () => {
  it("adds one positive GST-exclusive SER70 and preserves every original full line/header", () => {
    const evidence = xero(); const before = structuredClone(evidence);
    const result = buildFinalWeightAdjustment(facts(), "overweight", evidence);
    expect(result.eligible).toBe(true); expect(result.excessAmountExclusive).toBe(250);
    expect(result.expectedDraft!.LineItems[0]).toEqual(baseLine());
    expect(result.expectedDraft!.LineItems[1]).toEqual({ ItemCode: "SER70", Description: "Excess weight", Quantity: 1, UnitAmount: 250, AccountCode: "200", TaxType: "OUTPUT" });
    const { LineItems: _, ...headers } = result.originalDraft!;
    expect(result.expectedDraft).toMatchObject(headers); expect(evidence).toEqual(before);
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
  it("underweight changes exactly DueDate with no new or negative line, even if existing SER70 exists", () => {
    const full = invoice({ LineItems: [baseLine(), { ...baseLine(), ItemCode: "SER70", LineItemID: "existing-ser" }] });
    const result = buildFinalWeightAdjustment(facts({ actualWeight: 9, requiredDueDate: "2026-10-20", perExtraTonne: null }), "underweight", xero({ invoice: full, ser70: null }));
    expect(result.eligible).toBe(true);
    expect(result.expectedDraft!.LineItems).toEqual(full.LineItems);
    expect(result.expectedDraft).toEqual({ ...result.originalDraft, DueDate: "2026-10-20" });
    expect(result.excessAmountExclusive).toBeNull();
  });
  it.each(["AUTHORISED", "PAID", "VOIDED", "DELETED", "SUBMITTED", "DRAFT "])("holds status %s without an invoice proposal", status => {
    expect(buildFinalWeightAdjustment(facts(), "overweight", xero({ invoice: invoice({ Status: status }) })).eligible).toBe(false);
  });
  it.each([
    { exactMatches: [] }, { exactMatches: [invoice(), invoice({ InvoiceID: "collision", Status: "DELETED" })] },
    { invoice: null }, { invoice: invoice({ InvoiceID: "wrong-id" }) }, { invoice: invoice({ InvoiceNumber: "INV-702877-D" }) },
    { invoice: invoice({ Type: "ACCPAY" }) }, { invoice: invoice({ AmountPaid: 1 }) }, { invoice: invoice({ Payments: [{}] }) },
    { invoice: invoice({ AmountCredited: 1 }) }, { invoice: invoice({ CreditNotes: [{}] }) }, { invoice: invoice({ CurrencyCode: "NZD" }) },
    { invoice: invoice({ LineAmountTypes: "Inclusive" }) }, { invoice: invoice({ Date: "" }) }, { invoice: invoice({ DueDate: "" }) },
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
  it.each([null, "", "2026-02-30", "20-10-2026", "2026-10-20T04:00:00Z"])("underweight holds missing/ambiguous source date %s", requiredDueDate => {
    expect(buildFinalWeightAdjustment(facts({ actualWeight: 9, requiredDueDate }), "underweight", xero()).eligible).toBe(false);
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
