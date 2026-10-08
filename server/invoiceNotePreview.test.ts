import { describe, expect, it } from "vitest";
import { summarizeInvoiceListNotes, type InvoiceListNote } from "./invoiceNotePreview";

const note = (id: number, invoiceId: number, type: InvoiceListNote["type"], content: string, minute = id): InvoiceListNote => ({
  id, invoiceId, type, content, createdAt: new Date(Date.UTC(2026, 9, 8, 1, minute % 60)),
});

describe("invoice list note previews", () => {
  it("keeps existing QN/IN counts and chooses each newest note across an unordered batch", () => {
    const result = summarizeInvoiceListNotes([
      note(3, 1, "email_received", " Latest\n supplier   reply ", 3),
      note(4, 1, "system", "Automated process completed", 4),
      note(1, 1, "email_sent", "Old query", 1),
      note(2, 1, "note", "Review price  and  GST", 2),
      note(5, 2, "email_sent", "Another invoice query", 5),
    ]);
    expect(result.get(1)).toEqual({ queryNoteCount: 2, internalNoteCount: 2,
      queryNotePreview: "Latest supplier reply", internalNotePreview: "Review price and GST", internalNotePreviewType: "note" });
    expect(result.get(2)).toMatchObject({ queryNoteCount: 1, internalNoteCount: 0, queryNotePreview: "Another invoice query", internalNotePreview: null });
  });
  it("uses latest activity when there is no authored internal note, and ignores blank text", () => {
    const result = summarizeInvoiceListNotes([
      note(10, 3, "status_change", "Changed to queried", 10),
      note(11, 3, "system", "  System   update ", 11),
      note(12, 3, "email_sent", "  ", 12),
    ]);
    expect(result.get(3)).toEqual({ queryNoteCount: 1, internalNoteCount: 2,
      queryNotePreview: null, internalNotePreview: "System update", internalNotePreviewType: "activity" });
  });
  it("returns a bounded preview while preserving note counts and latest timestamp tie ordering", () => {
    const long = "a".repeat(1_200);
    const result = summarizeInvoiceListNotes([
      note(5, 4, "note", "Earlier same timestamp", 6),
      note(6, 4, "note", long, 6),
      note(7, 4, "email_received", "Reply", 7),
    ]);
    expect(result.get(4)?.internalNotePreview).toBe(`${"a".repeat(799)}…`);
    expect(result.get(4)?.internalNoteCount).toBe(2);
    expect(result.get(4)?.queryNotePreview).toBe("Reply");
    expect(summarizeInvoiceListNotes([]).size).toBe(0);
  });
});
