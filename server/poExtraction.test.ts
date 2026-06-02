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
  it("accepts a valid 2-letter + 7-digit PO number from LLM output", () => {
    const data = makeData({ poNumber: "AD1234567" });
    expect(applyPoNumberRegex(data)).toBe("AD1234567");
  });

  it("accepts a valid 1-letter + 7-digit PO number from LLM output", () => {
    const data = makeData({ poNumber: "A1234567" });
    expect(applyPoNumberRegex(data)).toBe("A1234567");
  });

  it("rejects an invalid LLM poNumber and falls back to line item description", () => {
    const data = makeData({
      poNumber: "INVALID-PO",
      lineItems: [
        { description: "Freight charge for PO BD0012345", quantity: 1, unitPrice: 500, amount: 500, taxRate: null },
      ],
    });
    expect(applyPoNumberRegex(data)).toBe("BD0012345");
  });

  it("finds PO number in line item description with PO# prefix", () => {
    const data = makeData({
      lineItems: [
        { description: "Container handling PO#DD9876543", quantity: 1, unitPrice: 200, amount: 200, taxRate: null },
      ],
    });
    expect(applyPoNumberRegex(data)).toBe("DD9876543");
  });

  it("finds PO number in notes field (combined text blob)", () => {
    const data = makeData({ notes: "Reference: Purchase Order ED1111111 for container shipment" });
    expect(applyPoNumberRegex(data)).toBe("ED1111111");
  });

  it("finds PO number in rawText parameter (invoice reference field)", () => {
    const data = makeData();
    const rawText = "Invoice Ref: AD7654321 | Customer PO";
    expect(applyPoNumberRegex(data, rawText)).toBe("AD7654321");
  });

  it("finds PO number in invoiceNumber field (combined blob)", () => {
    const data = makeData({ invoiceNumber: "INV-BD2222222" });
    expect(applyPoNumberRegex(data)).toBe("BD2222222");
  });

  it("returns null when no PO pattern found anywhere", () => {
    const data = makeData({ notes: "No purchase order on this invoice" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("does not match 6-digit numbers (too short)", () => {
    const data = makeData({ notes: "Reference AD123456 is not a valid PO" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("does not match 8-digit numbers (too long)", () => {
    const data = makeData({ notes: "Reference AD12345678 is not a valid PO" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("does not match 3-letter prefix (too many letters)", () => {
    const data = makeData({ notes: "Reference ABC1234567 is not a valid PO" });
    expect(applyPoNumberRegex(data)).toBeNull();
  });

  it("prefers line item match over notes match", () => {
    const data = makeData({
      notes: "Also see ED9999999",
      lineItems: [
        { description: "Freight for AD1234567", quantity: 1, unitPrice: 100, amount: 100, taxRate: null },
      ],
    });
    // Line items are checked before combined blob
    expect(applyPoNumberRegex(data)).toBe("AD1234567");
  });

  it("handles all common 2-letter prefixes: AD, BD, DD, ED", () => {
    const prefixes = ["AD", "BD", "DD", "ED"];
    for (const prefix of prefixes) {
      const data = makeData({ notes: `Order ${prefix}1234567` });
      expect(applyPoNumberRegex(data)).toBe(`${prefix}1234567`);
    }
  });
});
