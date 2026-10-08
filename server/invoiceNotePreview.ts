type NoteType = "note" | "email_sent" | "email_received" | "status_change" | "system";

export type InvoiceListNote = {
  invoiceId: number;
  id: number;
  type: NoteType;
  content: string;
  createdAt: Date;
};

export type InvoiceListNoteSummary = {
  queryNoteCount: number;
  internalNoteCount: number;
  queryNotePreview: string | null;
  internalNotePreview: string | null;
  internalNotePreviewType: "note" | "activity" | null;
};

const empty = (): InvoiceListNoteSummary => ({
  queryNoteCount: 0,
  internalNoteCount: 0,
  queryNotePreview: null,
  internalNotePreview: null,
  internalNotePreviewType: null,
});

/** Count every saved note, but return only the latest meaningful snippet per category. */
export function summarizeInvoiceListNotes(notes: InvoiceListNote[]): Map<number, InvoiceListNoteSummary> {
  const byInvoice = new Map<number, InvoiceListNoteSummary>();
  const latest = new Map<number, { query: InvoiceListNote | null; manual: InvoiceListNote | null; activity: InvoiceListNote | null }>();
  const newer = (a: InvoiceListNote, b: InvoiceListNote) => a.createdAt.getTime() > b.createdAt.getTime()
    || (a.createdAt.getTime() === b.createdAt.getTime() && a.id > b.id);

  for (const note of notes) {
    const summary = byInvoice.get(note.invoiceId) ?? empty();
    byInvoice.set(note.invoiceId, summary);
    const current = latest.get(note.invoiceId) ?? { query: null, manual: null, activity: null };
    latest.set(note.invoiceId, current);
    const text = note.content.replace(/\s+/g, " ").trim();
    if (note.type === "email_sent" || note.type === "email_received") {
      summary.queryNoteCount += 1;
      if (text && (!current.query || newer(note, current.query))) current.query = note;
    } else if (note.type === "note" || note.type === "status_change" || note.type === "system") {
      summary.internalNoteCount += 1;
      const key = note.type === "note" ? "manual" : "activity";
      if (text && (!current[key] || newer(note, current[key]))) current[key] = note;
    }
  }

  byInvoice.forEach((summary, invoiceId) => {
    const current = latest.get(invoiceId)!;
    const clean = (value: string) => {
      const normalized = value.replace(/\s+/g, " ").trim();
      return normalized.length >= 800 ? `${normalized.slice(0, 799)}…` : normalized;
    };
    summary.queryNotePreview = current.query ? clean(current.query.content) : null;
    const internal = current.manual ?? current.activity;
    summary.internalNotePreview = internal ? clean(internal.content) : null;
    summary.internalNotePreviewType = current.manual ? "note" : current.activity ? "activity" : null;
  });
  return byInvoice;
}
