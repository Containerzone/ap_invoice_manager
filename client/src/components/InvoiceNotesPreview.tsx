import React from "react";

type Props = {
  queryNotePreview?: string | null;
  internalNotePreview?: string | null;
  internalNotePreviewType?: "note" | "activity" | null;
  queryNoteCount?: number;
  internalNoteCount?: number;
};

export function InvoiceNotesPreview({ queryNotePreview, internalNotePreview, internalNotePreviewType,
  queryNoteCount = 0, internalNoteCount = 0 }: Props) {
  if (!queryNotePreview && !internalNotePreview) {
    return <span className="text-[11px] text-muted-foreground">{queryNoteCount + internalNoteCount > 0 ? "No note text" : "—"}</span>;
  }
  return <div className="min-w-0 space-y-1 text-[11px] leading-4">
    {queryNotePreview && <p className="min-w-0 line-clamp-2 break-words [overflow-wrap:anywhere] text-foreground" title={`Latest query note: ${queryNotePreview}`}>
      <span className="mr-1 font-semibold text-blue-700">QN{queryNoteCount > 1 ? ` ${queryNoteCount}` : ""}</span>
      <span>{queryNotePreview}</span>
    </p>}
    {internalNotePreview && <p className="min-w-0 line-clamp-2 break-words [overflow-wrap:anywhere] text-foreground" title={`${internalNotePreviewType === "activity" ? "Latest activity" : "Latest internal note"}: ${internalNotePreview}`}>
      <span className="mr-1 font-semibold text-violet-700">{internalNotePreviewType === "activity" ? "Activity" : "IN"}{internalNoteCount > 1 ? ` ${internalNoteCount}` : ""}</span>
      <span>{internalNotePreview}</span>
    </p>}
  </div>;
}
