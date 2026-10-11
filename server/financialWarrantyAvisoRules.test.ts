import { describe, expect, it } from "vitest";
import { warrantyFixture } from "./financialWarrantyAvisoFixtures";
import { assertWarrantyReadback, buildWarrantyPlan } from "./financialWarrantyAvisoRules";
describe("Warranty exact Draft append and Aviso rules", () => {
  it("preserves all original lines, IDs, tracking, reference and dates and appends exactly one native WAR; PO is 313/INPUT/AUD/Exclusive", () => {
    const { facts, evidence, config, plan } = warrantyFixture();
    expect(plan.mainPayload.method).toBe("PUT"); expect(plan.mainPayload.endpoint).toBe("/Invoices/main-id");
    expect(plan.expectedMain.LineItems).toHaveLength(2); expect(plan.expectedMain.LineItems[0]).toEqual(evidence.main!.LineItems[0]);
    expect(plan.expectedMain.Total).toBe(330); expect(plan.expectedMain.TotalTax).toBe(30);
    expect(plan.expectedMain.Reference).toBe(evidence.main!.Reference); expect(plan.expectedMain.DueDate).toBe("2026-10-15");
    expect(plan.poPayload.body.PurchaseOrders[0]).toMatchObject({ Status: "DRAFT", PurchaseOrderNumber: "I77", CurrencyCode: "AUD", LineAmountTypes: "Exclusive", LineItems: [{ ItemCode: "WAR-TEST", Description: facts.mapping!.nativeDescription, AccountCode: "313", TaxType: "INPUT", UnitAmount: 100 }] });
    expect(buildWarrantyPlan(facts, evidence, config)).toEqual(plan);
  });
  it.each(["SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED", "UNKNOWN"])("non-Draft %s holds requiring unimplemented explicit suffix policy", status => {
    const f = warrantyFixture(); f.evidence.main!.Status = status;
    expect(() => buildWarrantyPlan(f.facts, f.evidence, f.config)).toThrow(/WARRANTY_AP_SUFFIX_V1/);
  });
  it.each(["DRAFT", "SUBMITTED", "AUTHORISED", "BILLED", "PAID", "VOIDED", "DELETED", "UNKNOWN"])("Aviso collision %s holds with no adoption/bypass", Status => {
    const f = warrantyFixture(); f.evidence.poHistory = [{ PurchaseOrderID: "other-id", PurchaseOrderNumber: "I77", Status }];
    expect(() => buildWarrantyPlan(f.facts, f.evidence, f.config)).toThrow(/collision/);
  });
  it.each(["customer", "supplier", "nativeDescription", "purchaseDescription", "salesPremium", "purchasePremium", "purchaseAccount", "salesTax", "purchaseTax", "accountStatus", "taxRate", "currency", "inclusive", "allocations", "existingWar", "mainDuplicate", "unknownLine", "lineTotal", "mainTotal", "duplicateLineId", "oldSuffix"])("holds on exact %s mismatch", scenario => {
    const f = warrantyFixture(); const e = f.evidence;
    if (scenario === "customer") e.customer.Name = "Wrong customer";
    if (scenario === "supplier") e.supplier.Name = "Aviso";
    if (scenario === "nativeDescription") e.item.Description = "Guessed";
    if (scenario === "purchaseDescription") e.item.PurchaseDescription = "Wrong";
    if (scenario === "salesPremium") e.item.SalesDetails.UnitPrice = 99;
    if (scenario === "purchasePremium") e.item.PurchaseDetails.UnitPrice = 99;
    if (scenario === "purchaseAccount") e.item.PurchaseDetails.AccountCode = "312";
    if (scenario === "salesTax") e.item.SalesDetails.TaxType = "NONE";
    if (scenario === "purchaseTax") e.item.PurchaseDetails.TaxType = "NONE";
    if (scenario === "accountStatus") e.accounts[1].Status = "ARCHIVED";
    if (scenario === "taxRate") e.taxes[0].EffectiveRate = 0;
    if (scenario === "currency") e.main!.CurrencyCode = "USD";
    if (scenario === "inclusive") e.main!.LineAmountTypes = "Inclusive";
    if (scenario === "allocations") e.main!.Payments = [{ PaymentID: "paid" }];
    if (scenario === "existingWar") e.main!.LineItems[0].ItemCode = "WAR-OTHER";
    if (scenario === "mainDuplicate") e.mainHistory.push({ ...e.mainHistory[0], InvoiceID: "duplicate-id", Status: "DELETED" });
    if (scenario === "unknownLine") e.main!.LineItems[0].UnexpectedEditableField = 1;
    if (scenario === "lineTotal") e.main!.LineItems[0].LineAmount = 201;
    if (scenario === "mainTotal") e.main!.Total = 221;
    if (scenario === "duplicateLineId") e.main!.LineItems.push({ ...e.main!.LineItems[0] });
    if (scenario === "oldSuffix") e.otherInvoices = [{ InvoiceNumber: "INV-77-OLD", Status: "DELETED", LineItems: [{ ItemCode: "WAR-OLD" }] }];
    expect(() => buildWarrantyPlan(f.facts, e, f.config)).toThrow();
  });
  it("main absent holds, source issue/due mismatch holds rather than updating dates", () => {
    const f = warrantyFixture(); f.evidence.mainHistory = []; expect(() => buildWarrantyPlan(f.facts, f.evidence, f.config)).toThrow(/missing\/ambiguous/);
    const g = warrantyFixture(); g.config.dateSemantics.issue = "source_iso_date"; g.config.fields.issueDate = { ...g.config.fields.dealNumber, type: { name: "date" } }; g.facts.issueDate = "2026-10-02";
    expect(() => buildWarrantyPlan(g.facts, g.evidence, g.config)).toThrow(/semantics/);
  });
  it("factual source hold cannot be bypassed by Warranty Confirmed", () => {
    const f = warrantyFixture(); f.facts.holdReason = "Current Added Services unsupported"; (f.facts as any).warrantyConfirmed = true;
    expect(() => buildWarrantyPlan(f.facts, f.evidence, f.config)).toThrow(/Added Services/);
  });
  it("full document readback verifies original IDs/full lines/totals plus appended native WAR", () => {
    const { plan } = warrantyFixture(); const main = structuredClone(plan.expectedMain); main.LineItems[1].LineItemID = "new-id";
    expect(() => assertWarrantyReadback(main, plan.expectedMain, "main", "main-id")).not.toThrow();
    const po = { ...structuredClone(plan.expectedPo), PurchaseOrderID: "po-id" }; po.LineItems[0].LineItemID = "po-line";
    expect(() => assertWarrantyReadback(po, plan.expectedPo, "po", "po-id")).not.toThrow();
  });
  it.each(["status", "id", "contact", "item", "description", "quantity", "account", "tax", "lineId", "lineAmount", "tracking", "total", "date", "due", "reference", "lineCount"])("full readback %s drift requires reconciliation", scenario => {
    const { plan } = warrantyFixture(); const a = structuredClone(plan.expectedMain);
    const edits: Record<string, () => void> = { status: () => a.Status = "AUTHORISED", id: () => a.InvoiceID = "wrong-id", contact: () => a.Contact.ContactID = "wrong", item: () => a.LineItems[0].ItemCode = "changed", description: () => a.LineItems[0].Description = "changed", quantity: () => a.LineItems[0].Quantity = 1, account: () => a.LineItems[0].AccountCode = "201", tax: () => a.LineItems[1].TaxType = "INPUT", lineId: () => a.LineItems[0].LineItemID = "new-id", lineAmount: () => a.LineItems[0].LineAmount = 199, tracking: () => a.LineItems[0].Tracking = [], total: () => a.Total = 329, date: () => a.Date = "2026-10-02", due: () => a.DueDate = "2026-10-16", reference: () => a.Reference = "changed", lineCount: () => a.LineItems.shift() };
    edits[scenario](); expect(() => assertWarrantyReadback(a, plan.expectedMain, "main", "main-id")).toThrow();
  });
});
