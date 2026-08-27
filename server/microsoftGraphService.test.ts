import { describe, expect, it } from "vitest";
import { isGraphPdfAttachment, isInvoiceAliasRecipient, microsoftGraphRetryDelayMs, microsoftWebhookClientState, selectFirstGraphPdfAttachment } from "./microsoftGraphService";

describe("Microsoft Graph inbound email safeguards", () => {
  it("uses Retry-After values and bounded fallback delays for transient Graph throttling", () => {
    expect(microsoftGraphRetryDelayMs("3", 0)).toBe(3000);
    expect(microsoftGraphRetryDelayMs("invalid", 0)).toBe(1000);
    expect(microsoftGraphRetryDelayMs(null, 2)).toBe(4000);
  });

  it("selects only concrete non-inline PDF attachment metadata before fetching content", () => {
    expect(isGraphPdfAttachment({ id: "pdf", contentType: "application/pdf" })).toBe(true);
    expect(isGraphPdfAttachment({ id: "pdf-name", name: "supplier-invoice.PDF", contentType: "application/octet-stream" })).toBe(true);
    expect(isGraphPdfAttachment({ id: "inline-pdf", contentType: "application/pdf", isInline: true })).toBe(false);
    expect(isGraphPdfAttachment({ id: "image", contentType: "image/png" })).toBe(false);
    expect(isGraphPdfAttachment({ id: "csv", name: "export.csv", contentType: "text/csv" })).toBe(false);
    expect(isGraphPdfAttachment({ id: "", contentType: "application/pdf" })).toBe(false);
  });

  it("selects one PDF only and ignores CSV or later PDF attachments", () => {
    expect(selectFirstGraphPdfAttachment([
      { id: "csv", name: "lines.csv", contentType: "text/csv" },
      { id: "invoice", name: "invoice.pdf", contentType: "application/pdf" },
      { id: "supporting", name: "supporting.pdf", contentType: "application/pdf" },
    ])?.id).toBe("invoice");
  });

  it("processes messages addressed to the configured invoice alias only", () => {
    expect(isInvoiceAliasRecipient({
      id: "message-1",
      toRecipients: [{ emailAddress: { address: "Invoices@ContainerZone.com.au" } }],
    })).toBe(true);
    expect(isInvoiceAliasRecipient({
      id: "message-2",
      toRecipients: [{ emailAddress: { address: "admin@containerzone.com.au" } }],
    })).toBe(false);
    expect(isInvoiceAliasRecipient({
      id: "message-3",
      toRecipients: [{ emailAddress: { address: "admin@containerzone.com.au" } }],
      internetMessageHeaders: [{ name: "X-ContainerZone-Invoice-Upload", value: "true" }],
    })).toBe(true);
  });

  it("creates a deterministic client-state value for the exact mailbox resource", () => {
    const resource = "users/admin@containerzone.com.au/messages";
    expect(microsoftWebhookClientState(resource)).toBe(microsoftWebhookClientState(resource));
    expect(microsoftWebhookClientState(resource)).not.toBe(microsoftWebhookClientState("users/other@example.com/messages"));
  });
});
