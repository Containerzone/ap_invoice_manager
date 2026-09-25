import { describe, expect, it } from "vitest";
import { getInvoicePdfUrl, getPdfPreviewUrl, nextPdfZoom } from "../client/src/lib/pdfPreview";

describe("PDF preview zoom controls", () => {
  it("uses a same-origin authenticated endpoint for invoice PDF requests", () => {
    expect(getInvoicePdfUrl(5812)).toBe("/api/invoices/5812/pdf");
  });

  it("adds a controlled PDF viewer zoom fragment", () => {
    expect(getPdfPreviewUrl("/manus-storage/invoice.pdf", 150))
      .toBe("/manus-storage/invoice.pdf#toolbar=0&navpanes=0&scrollbar=1&zoom=150");
  });

  it("removes existing URL fragments before applying controlled viewer preferences", () => {
    expect(getPdfPreviewUrl("https://files.example/invoice.pdf#zoom=25", 200))
      .toBe("https://files.example/invoice.pdf#toolbar=0&navpanes=0&scrollbar=1&zoom=200");
  });

  it("moves through supported zoom levels without exceeding the bounds", () => {
    expect(nextPdfZoom(100, -1)).toBe(100);
    expect(nextPdfZoom(100, 1)).toBe(125);
    expect(nextPdfZoom(175, 1)).toBe(200);
    expect(nextPdfZoom(200, 1)).toBe(200);
  });
});
