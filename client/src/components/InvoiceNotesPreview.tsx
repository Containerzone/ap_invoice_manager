import { BusinessText, useBusinessReferenceText } from "@/components/BusinessReferenceDisplay";
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
  const businessText = useBusinessReferenceText([queryNotePreview, internalNotePreview]);
  if (!queryNotePreview && !internalNotePreview) {
    return <span className="text-[11px] text-muted-foreground"><BusinessText value={queryNoteCount + internalNoteCount > 0 ? "No note text" : "—"} /></span>;
  }
  return <div className="min-w-0 space-y-1 text-[11px] leading-4">
    {queryNotePreview && <p className="min-w-0 line-clamp-2 break-words [overflow-wrap:anywhere] text-foreground" title={businessText(`Latest query note: ${queryNotePreview}`)}>
      <span className="mr-1 font-semibold text-blue-700">QN<BusinessText value={queryNoteCount > 1 ? ` ${queryNoteCount}` : ""} /></span>
      <span><BusinessText value={queryNotePreview} /></span>
    </p>}
    {internalNotePreview && <p className="min-w-0 line-clamp-2 break-words [overflow-wrap:anywhere] text-foreground" title={businessText(`${internalNotePreviewType === "activity" ? "Latest activity" : "Latest internal note"}: ${internalNotePreview}`)}>
      <span className="mr-1 font-semibold text-violet-700"><BusinessText value={internalNotePreviewType === "activity" ? "Activity" : "IN"} /><BusinessText value={internalNoteCount > 1 ? ` ${internalNoteCount}` : ""} /></span>
      <span><BusinessText value={internalNotePreview} /></span>
    </p>}
  </div>;
}
