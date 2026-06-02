import { describe, expect, it } from "vitest";
import { applyPoNumberRegex, type ExtractedInvoiceData } from "./extractionService";

function makeData(overrides: Partial<ExtractedInvoiceData> = {}): ExtractedInvoiceData {
  return {
    invoiceNumber: null,
    poNumber: null,
    containerNumbers: [],
    supplierName: null,
    supplierAbn: null,
    supplierEmail: null,
    supplierPhone: null,
    supplierAddress: null,
    supplierContactName: null,
    invoiceDate: null,
    dueDate: null,
    subtotal: null,
    tax: null,
    total: null,
    currency: "AUD",
    lineItems: [],
    confidence: "low",
    notes: null,
    ...overrides,
  };
}

describe("applyPoNumberRegex", () => {
  it("accepts a valid 2-letter + 6-digit PO number from LLM output", () => {
    const data = makeData({ poNumber: "AD123456" });
    expect(applyPoNumberRegex(data)).toBe("AD123456");
  });

  it("rejects a single-letter prefix (must be exactly 2 letters)", () => {
    const data = makeData({ poNumber: "A123456" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("rejects an invalid LLM poNumber and falls back to line item description", () => {
    const data = makeData({
      poNumber: "INVALID-PO",
      lineItems: [
        { description: "Freight charge for PO BD001234", quantity: 1, unitPrice: 500, amount: 500, taxRate: null },
      ],
    });
    expect(applyPoNumberRegex(data)).toBe("BD001234");
  });

  it("finds PO number in line item description with PO# prefix", () => {
    const data = makeData({
      lineItems: [
        { description: "Container handling PO#DD987654", quantity: 1, unitPrice: 200, amount: 200, taxRate: null },
      ],
    });
    expect(applyPoNumberRegex(data)).toBe("DD987654");
  });

  it("finds PO number in notes field (combined text blob)", () => {
    const data = makeData({ notes: "Reference: Purchase Order ED111111 for container shipment" });
    expect(applyPoNumberRegex(data)).toBe("ED111111");
  });

  it("finds PO number in rawText parameter (invoice reference field)", () => {
    const data = makeData();
    const rawText = "Invoice Ref: AD765432 | Customer PO";
    expect(applyPoNumberRegex(data, rawText)).toBe("AD765432");
  });

  it("finds PO number in invoiceNumber field (combined blob)", () => {
    const data = makeData({ invoiceNumber: "INV-BD222222" });
    expect(applyPoNumberRegex(data)).toBe("BD222222");
  });

  it("returns null when no PO pattern found anywhere", () => {
    const data = makeData({ notes: "No purchase order on this invoice" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("does not match 5-digit numbers (too short)", () => {
    const data = makeData({ notes: "Reference AD12345 is not a valid PO" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("does not match 7-digit numbers (too long)", () => {
    const data = makeData({ notes: "Reference AD1234567 is not a valid PO" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("does not match 3-letter prefix (too many letters)", () => {
    const data = makeData({ notes: "Reference ABC123456 is not a valid PO" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("prefers line item match over notes match", () => {
    const data = makeData({
      notes: "Also see ED999999",
      lineItems: [
        { description: "Freight for AD123456", quantity: 1, unitPrice: 100, amount: 100, taxRate: null },
      ],
    });
    expect(applyPoNumberRegex(data)).toBe("AD123456");
  });

  it("handles all common 2-letter prefixes: AD, BD, DD, ED", () => {
    const prefixes = ["AD", "BD", "DD", "ED"];
    for (const prefix of prefixes) {
      const data = makeData({ notes: `Order ${prefix}123456` });
      expect(applyPoNumberRegex(data)).toBe(`${prefix}123456`);
    }
  });
});
