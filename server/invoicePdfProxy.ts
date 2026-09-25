import type { Request, Response, Express } from "express";
import { getInvoiceById } from "./db";
import { storageGetSignedUrl } from "./storage";
import { sdk } from "./_core/sdk";

const PDF_SIGNATURE = Buffer.from("%PDF-");
const MAX_PROXY_PDF_BYTES = 50 * 1024 * 1024;

export function getInvoicePdfStorageKey(invoice: { fileKey?: string | null; fileUrl?: string | null }): string | null {
  if (invoice.fileKey && !invoice.fileKey.startsWith("/manus-storage/")) return invoice.fileKey;
  const storagePath = invoice.fileUrl?.match(/^\/manus-storage\/(.+)$/)?.[1];
  return storagePath || null;
}

export function sanitizePdfFilename(name: string | null | undefined, invoiceId: number): string {
  const sanitized = (name ?? `invoice-${invoiceId}.pdf`)
    .replace(/[\\/\r\n";]/g, "_")
    .trim();
  return sanitized.toLowerCase().endsWith(".pdf") ? sanitized : `${sanitized || `invoice-${invoiceId}`}.pdf`;
}

function requestedByteRange(req: Request): string | undefined {
  const value = req.headers.range;
  return typeof value === "string" && /^bytes=\d*-\d*$/.test(value) ? value : undefined;
}

function responseHeader(response: globalThis.Response, header: string): string | null {
  return response.headers.get(header) ?? response.headers.get(header.toLowerCase());
}

/**
 * Streams a verified PDF through the application origin. The standard storage
 * route intentionally returns a signed CloudFront redirect; this endpoint
 * avoids that browser-side redirect for users whose managed network blocks it.
 */
export async function serveInvoicePdf(req: Request, res: Response): Promise<void> {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.isCron || user.status !== "active") {
      res.status(403).send("Active user access is required");
      return;
    }

    const invoiceId = Number(req.params.invoiceId);
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      res.status(400).send("Invalid invoice ID");
      return;
    }

    const invoice = await getInvoiceById(invoiceId);
    if (!invoice) {
      res.status(404).send("Invoice not found");
      return;
    }

    const storageKey = getInvoicePdfStorageKey(invoice);
    if (!storageKey) {
      res.status(404).send("Invoice document is unavailable");
      return;
    }

    const signedUrl = await storageGetSignedUrl(storageKey);
    const signatureResponse = await fetch(signedUrl, { headers: { Range: "bytes=0-4" } });
    const signature = Buffer.from(await signatureResponse.arrayBuffer());
    if (!signatureResponse.ok || !signature.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
      console.error(`[InvoicePdfProxy] Stored document for invoice ${invoiceId} is not a PDF`);
      res.status(422).send("Invoice document is not a valid PDF");
      return;
    }

    const range = requestedByteRange(req);
    const documentResponse = await fetch(signedUrl, {
      headers: range ? { Range: range } : undefined,
    });
    const byteLength = Number(responseHeader(documentResponse, "content-length") ?? "0");
    if (!documentResponse.ok || (Number.isFinite(byteLength) && byteLength > MAX_PROXY_PDF_BYTES)) {
      res.status(502).send("Invoice document could not be retrieved");
      return;
    }

    const document = Buffer.from(await documentResponse.arrayBuffer());
    if (document.length > MAX_PROXY_PDF_BYTES) {
      res.status(502).send("Invoice document is too large to preview");
      return;
    }

    res.status(documentResponse.status);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${sanitizePdfFilename(invoice.originalFileName, invoice.id)}"`,
      "Content-Length": String(document.length),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Accept-Ranges": responseHeader(documentResponse, "accept-ranges") ?? "bytes",
    });
    const contentRange = responseHeader(documentResponse, "content-range");
    if (contentRange) res.set("Content-Range", contentRange);
    res.send(document);
  } catch (error: any) {
    console.error("[InvoicePdfProxy] failed:", error?.message ?? error);
    if (!res.headersSent) res.status(502).send("Invoice document could not be retrieved");
  }
}

export function registerInvoicePdfProxy(app: Express): void {
  app.get("/api/invoices/:invoiceId/pdf", serveInvoicePdf);
}
