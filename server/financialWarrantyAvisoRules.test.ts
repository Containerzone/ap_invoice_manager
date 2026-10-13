import { describe, expect, it } from "vitest";
import { warrantyFixture } from "./financialWarrantyAvisoFixtures";
import { assertWarrantyReadback, buildWarrantyPlan, WARRANTY_ADDED_SERVICES_MAPPINGS } from "./financialWarrantyAvisoRules";
describe("Warranty exact Draft append and Aviso rules", () => {
  it("allows only the approved first ten current Added Services bands and leaves higher live bands unsupported", () => {
    expect(WARRANTY_ADDED_SERVICES_MAPPINGS).toEqual([
      { addedServicesValue: "Warranty $25k", itemCode: "WAR25", premiumExGst: 192.5 },
      { addedServicesValue: "Warranty $30k", itemCode: "WAR30", premiumExGst: 228.9 },
      { addedServicesValue: "Warranty $40k", itemCode: "WAR40", premiumExGst: 305.2 },
      { addedServicesValue: "Warranty $50k", itemCode: "WAR50", premiumExGst: 381.5 },
      { addedServicesValue: "Warranty $60k", itemCode: "WAR60", premiumExGst: 457.8 },
      { addedServicesValue: "Warranty $70k", itemCode: "WAR70", premiumExGst: 534.1 },
      { addedServicesValue: "Warranty $75k", itemCode: "WAR75", premiumExGst: 572.25 },
      { addedServicesValue: "Warranty $80k", itemCode: "WAR80", premiumExGst: 610.4 },
      { addedServicesValue: "Warranty $90k", itemCode: "WAR90", premiumExGst: 686.7 },
      { addedServicesValue: "Warranty $100k", itemCode: "WAR100", premiumExGst: 763 },
    ]);
    expect(WARRANTY_ADDED_SERVICES_MAPPINGS.map(row => row.addedServicesValue)).not.toContain("Warranty $150k");
    expect(WARRANTY_ADDED_SERVICES_MAPPINGS.map(row => row.addedServicesValue)).not.toContain("Warranty $200k");
    expect(WARRANTY_ADDED_SERVICES_MAPPINGS.map(row => row.addedServicesValue)).not.toContain("Warranty $250k");
  });
  it("preserves all original lines, IDs, tracking, reference and dates; main uses the Added Services label/200/OUTPUT and Aviso uses the native purchase description/313/INPUT", () => {
    const { facts, evidence, config, plan } = warrantyFixture();
    expect(plan.mainPayload.method).toBe("POST"); expect(plan.mainPayload.endpoint).toBe("/Invoices/main-id");
    expect(plan.expectedMain.LineItems).toHaveLength(2); expect(plan.expectedMain.LineItems[0]).toEqual(evidence.main!.LineItems[0]);
    expect(plan.expectedMain.Total).toBe(431.75); expect(plan.expectedMain.TotalTax).toBe(39.25);
    expect(plan.expectedMain.Reference).toBe(evidence.main!.Reference); expect(plan.expectedMain.DueDate).toBe("2026-10-15");
    expect(plan.expectedMain.LineItems[1]).toMatchObject({ ItemCode: "WAR25", Description: facts.addedServices, AccountCode: "200", TaxType: "OUTPUT", UnitAmount: 192.5 });
    expect(plan.poPayload.body.PurchaseOrders[0]).toMatchObject({ Status: "DRAFT", PurchaseOrderNumber: "ID77", CurrencyCode: "AUD", LineAmountTypes: "Exclusive", LineItems: [{ ItemCode: "WAR25", Description: facts.mapping!.nativeDescription, AccountCode: "313", TaxType: "INPUT", UnitAmount: 192.5 }] });
    expect(buildWarrantyPlan(facts, evidence, config)).toEqual(plan);
  });
  it("uses the approved Added Services premium rather than an item default price", () => {
    const { facts, evidence, config } = warrantyFixture();
    evidence.item.SalesDetails.UnitPrice = 999;
    evidence.item.PurchaseDetails.UnitPrice = 888;
    const plan = buildWarrantyPlan(facts, evidence, config);
    expect(plan.expectedMain.LineItems.at(-1)).toMatchObject({ UnitAmount: 192.5, LineAmount: 192.5, TaxAmount: 19.25 });
    expect(plan.expectedPo.LineItems[0]).toMatchObject({ UnitAmount: 192.5, LineAmount: 192.5, TaxAmount: 19.25 });
  });
  it.each(["SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED", "UNKNOWN"])("non-Draft %s holds requiring unimplemented explicit suffix policy", status => {
    const f = warrantyFixture(); f.evidence.main!.Status = status;
    expect(() => buildWarrantyPlan(f.facts, f.evidence, f.config)).toThrow(/WARRANTY_AP_SUFFIX_V1/);
  });
  it.each(["DRAFT", "SUBMITTED", "AUTHORISED", "BILLED", "PAID", "VOIDED", "DELETED", "UNKNOWN"])("Aviso collision %s holds with no adoption/bypass", Status => {
    const f = warrantyFixture(); f.evidence.poHistory = [{ PurchaseOrderID: "other-id", PurchaseOrderNumber: "ID77", Status }];
    expect(() => buildWarrantyPlan(f.facts, f.evidence, f.config)).toThrow(/collision/);
  });
  it.each(["customer", "supplier", "purchaseDescription", "purchaseAccount", "purchaseTax", "accountStatus", "taxRate", "currency", "inclusive", "allocations", "existingWar", "mainDuplicate", "unknownLine", "lineTotal", "mainTotal", "duplicateLineId", "oldSuffix"])("holds on exact %s mismatch", scenario => {
    const f = warrantyFixture(); const e = f.evidence;
    if (scenario === "customer") e.customer.Name = "Wrong customer";
    if (scenario === "supplier") e.supplier.Name = "Aviso";
    if (scenario === "purchaseDescription") e.item.PurchaseDescription = "Wrong";
    if (scenario === "purchaseAccount") e.item.PurchaseDetails.AccountCode = "312";
    if (scenario === "purchaseTax") e.item.PurchaseDetails.TaxType = "NONE";
    if (scenario === "accountStatus") e.accounts[0].Status = "ARCHIVED";
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
  it("preserves an absent current main due date instead of inventing one", () => {
    const f = warrantyFixture(); delete f.evidence.main!.DueDate;
    const plan = buildWarrantyPlan(f.facts, f.evidence, f.config);
    expect(plan.expectedMain).not.toHaveProperty("DueDate");
    const readback = structuredClone(plan.expectedMain); readback.LineItems[1].LineItemID = "new-id";
    expect(() => assertWarrantyReadback(readback, plan.expectedMain, "main", "main-id")).not.toThrow();
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
