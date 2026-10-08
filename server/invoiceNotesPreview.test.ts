import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceNotesPreview } from "../client/src/components/InvoiceNotesPreview";

describe("invoice list note text cell", () => {
  it("shows small QN and IN previews with counts and two-line clipping", () => {
    const html = renderToStaticMarkup(createElement(InvoiceNotesPreview, {
      queryNoteCount: 3, internalNoteCount: 2, queryNotePreview: "Supplier will reissue next week",
      internalNotePreview: "Check GST amount", internalNotePreviewType: "note",
    }));
    expect(html).toContain("QN 3");
    expect(html).toContain("Supplier will reissue next week");
    expect(html).toContain("IN 2");
    expect(html).toContain("Check GST amount");
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("Latest query note:");
  });
  it("distinguishes activity and renders user-provided text as text, not HTML", () => {
    const html = renderToStaticMarkup(createElement(InvoiceNotesPreview, {
      internalNoteCount: 1, internalNotePreview: "<script>alert(1)</script>", internalNotePreviewType: "activity",
    }));
    expect(html).toContain("Activity");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(renderToStaticMarkup(createElement(InvoiceNotesPreview, {}))).toContain("—");
  });
});
