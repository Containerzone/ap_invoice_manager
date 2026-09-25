import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuthenticateRequest, mockGetInvoiceById, mockStorageGetSignedUrl } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockGetInvoiceById: vi.fn(),
  mockStorageGetSignedUrl: vi.fn(),
}));

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: mockAuthenticateRequest } }));
vi.mock("./db", () => ({ getInvoiceById: mockGetInvoiceById }));
vi.mock("./storage", () => ({ storageGetSignedUrl: mockStorageGetSignedUrl }));

import {
  getInvoicePdfStorageKey,
  sanitizePdfFilename,
  serveInvoicePdf,
} from "./invoicePdfProxy";

function createResponse() {
  const response = {
    headersSent: false,
    status: vi.fn(),
    set: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.set.mockReturnValue(response);
  return response;
}

describe("invoice PDF proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({ id: 7, status: "active", isCron: false });
    mockGetInvoiceById.mockResolvedValue({
      id: 5812,
      fileKey: "invoices/email/invoice-5812.pdf",
      fileUrl: "/manus-storage/invoices/email/invoice-5812.pdf",
      originalFileName: "Invoice 5812.pdf",
    });
    mockStorageGetSignedUrl.mockResolvedValue("https://storage.example.test/signed-invoice.pdf");
  });

  it("uses the durable file key and never an external file URL", () => {
    expect(getInvoicePdfStorageKey({ fileKey: "invoices/email/invoice.pdf", fileUrl: "https://untrusted.example/file.pdf" })).toBe("invoices/email/invoice.pdf");
    expect(getInvoicePdfStorageKey({ fileUrl: "/manus-storage/invoices/invoice.pdf" })).toBe("invoices/invoice.pdf");
    expect(getInvoicePdfStorageKey({ fileUrl: "https://untrusted.example/file.pdf" })).toBeNull();
  });

  it("requires an active signed-in user before requesting storage", async () => {
    mockAuthenticateRequest.mockResolvedValue({ id: 7, status: "disabled" });
    const response = createResponse();

    await serveInvoicePdf({ params: { invoiceId: "5812" }, headers: {} } as any, response as any);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(mockGetInvoiceById).not.toHaveBeenCalled();
    expect(mockStorageGetSignedUrl).not.toHaveBeenCalled();
  });

  it("serves a verified PDF through the app origin without redirecting the browser to storage", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(Buffer.from("%PDF-"), { status: 206, headers: { "content-type": "application/pdf" } }))
      .mockResolvedValueOnce(new Response(Buffer.from("%PDF-1.7 invoice bytes"), {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "22", "accept-ranges": "bytes" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const response = createResponse();

    await serveInvoicePdf({ params: { invoiceId: "5812" }, headers: {} } as any, response as any);

    expect(mockStorageGetSignedUrl).toHaveBeenCalledWith("invoices/email/invoice-5812.pdf");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://storage.example.test/signed-invoice.pdf", { headers: { Range: "bytes=0-4" } });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://storage.example.test/signed-invoice.pdf", { headers: undefined });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.set).toHaveBeenCalledWith(expect.objectContaining({
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store, max-age=0",
      "Cross-Origin-Resource-Policy": "same-origin",
    }));
    expect(response.send).toHaveBeenCalledWith(expect.any(Buffer));
  });

  it("rejects a non-PDF object before serving it from the application origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>not a PDF</html>", { status: 200 })));
    const response = createResponse();

    await serveInvoicePdf({ params: { invoiceId: "5812" }, headers: {} } as any, response as any);

    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.send).toHaveBeenCalledWith("Invoice document is not a valid PDF");
  });

  it("sanitizes filenames for the inline content-disposition header", () => {
    expect(sanitizePdfFilename('unsafe\"name\r\n.pdf', 5812)).toBe("unsafe_name__.pdf");
    expect(sanitizePdfFilename(null, 5812)).toBe("invoice-5812.pdf");
  });
});
