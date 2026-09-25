export const PDF_PREVIEW_ZOOM_LEVELS = [100, 125, 150, 175, 200] as const;

export type PdfPreviewZoom = typeof PDF_PREVIEW_ZOOM_LEVELS[number];

/** Same-origin endpoint that streams a verified PDF for an active app user. */
export function getInvoicePdfUrl(invoiceId: number): string {
  return `/api/invoices/${invoiceId}/pdf`;
}

/**
 * Builds a browser-PDF-viewer URL with application-controlled zoom. Existing
 * URL fragments are removed so an uploaded filename cannot override the
 * preview's toolbar or zoom preferences.
 */
export function getPdfPreviewUrl(fileUrl: string, zoom: PdfPreviewZoom): string {
  const baseUrl = fileUrl.split("#", 1)[0] ?? fileUrl;
  return `${baseUrl}#toolbar=0&navpanes=0&scrollbar=1&zoom=${zoom}`;
}

export function nextPdfZoom(current: PdfPreviewZoom, direction: -1 | 1): PdfPreviewZoom {
  const currentIndex = PDF_PREVIEW_ZOOM_LEVELS.indexOf(current);
  const nextIndex = Math.min(PDF_PREVIEW_ZOOM_LEVELS.length - 1, Math.max(0, currentIndex + direction));
  return PDF_PREVIEW_ZOOM_LEVELS[nextIndex]!;
}
