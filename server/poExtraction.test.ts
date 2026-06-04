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

  it("accepts a single-letter prefix (1 or 2 letters allowed)", () => {
    const data = makeData({ poNumber: "A123456" });
    expect(applyPoNumberRegex(data)).toBe("A123456");
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

import { extractAllPoNumbers } from "./extractionService";

describe("extractAllPoNumbers — single-letter prefix support", () => {
  it("extracts single-letter prefix PO from line item description", () => {
    const data = makeData({
      lineItems: [
        { description: "Freight A123456", quantity: 1, unitPrice: 500, amount: 500, taxRate: null },
      ],
    });
    expect(extractAllPoNumbers(data)).toContain("A123456");
  });

  it("extracts both 1-letter and 2-letter PO numbers from same invoice", () => {
    const data = makeData({
      lineItems: [
        { description: "Container handling AD123456", quantity: 1, unitPrice: 800, amount: 800, taxRate: null },
        { description: "Freight B654321", quantity: 1, unitPrice: 400, amount: 400, taxRate: null },
      ],
    });
    const result = extractAllPoNumbers(data);
    expect(result).toContain("AD123456");
    expect(result).toContain("B654321");
    expect(result).toHaveLength(2);
  });

  it("does not match 3-letter prefix in extractAllPoNumbers", () => {
    const data = makeData({ notes: "Reference ABC123456 is not a valid PO" });
    expect(extractAllPoNumbers(data)).toHaveLength(0);
  });
});

describe("Multi-PO line-item grouping helper", () => {
  // Replicates the getGroupedLineItemTotal logic from routers.ts
  const PO_PATTERN = /\b([A-Z]{1,2}\d{6})\b/g;

  function getGroupedLineItemTotal(
    poNum: string,
    lineItems: Array<{ description: string; amount: number }>
  ): number | null {
    if (lineItems.length === 0) return null;
    const matched = lineItems.filter((li) => {
      const matches = li.description.match(PO_PATTERN);
      return matches && matches.includes(poNum);
    });
    if (matched.length === 0) return null;
    return matched.reduce((sum, li) => sum + li.amount, 0);
  }

  it("sums line items matching a 2-letter PO number", () => {
    const lineItems = [
      { description: "Freight AD123456", amount: 800 },
      { description: "Handling AD123456 surcharge", amount: 200 },
      { description: "Container BD654321", amount: 500 },
    ];
    expect(getGroupedLineItemTotal("AD123456", lineItems)).toBe(1000);
  });

  it("sums line items matching a single-letter PO number", () => {
    const lineItems = [
      { description: "Freight A123456", amount: 400 },
      { description: "Delivery A123456", amount: 100 },
      { description: "Other B654321", amount: 300 },
    ];
    expect(getGroupedLineItemTotal("A123456", lineItems)).toBe(500);
  });

  it("returns null when no line items match the PO number", () => {
    const lineItems = [
      { description: "Freight AD123456", amount: 800 },
    ];
    expect(getGroupedLineItemTotal("BD999999", lineItems)).toBeNull();
  });

  it("returns null for empty line items array", () => {
    expect(getGroupedLineItemTotal("AD123456", [])).toBeNull();
  });

  it("correctly separates two POs on the same invoice", () => {
    const lineItems = [
      { description: "Container AD123456", amount: 1100 },
      { description: "Freight BD654321", amount: 550 },
      { description: "Handling BD654321", amount: 50 },
    ];
    expect(getGroupedLineItemTotal("AD123456", lineItems)).toBe(1100);
    expect(getGroupedLineItemTotal("BD654321", lineItems)).toBe(600);
  });
});
