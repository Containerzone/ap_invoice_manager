import { describe, expect, it } from "vitest";
import { isInvoiceAliasRecipient, microsoftWebhookClientState } from "./microsoftGraphService";

describe("Microsoft Graph inbound email safeguards", () => {
  it("processes messages addressed to the configured invoice alias only", () => {
    expect(isInvoiceAliasRecipient({
      id: "message-1",
      toRecipients: [{ emailAddress: { address: "Invoices@ContainerZone.com.au" } }],
    })).toBe(true);
    expect(isInvoiceAliasRecipient({
      id: "message-2",
      toRecipients: [{ emailAddress: { address: "admin@containerzone.com.au" } }],
    })).toBe(false);
  });

  it("creates a deterministic client-state value for the exact mailbox resource", () => {
    const resource = "users/admin@containerzone.com.au/messages";
    expect(microsoftWebhookClientState(resource)).toBe(microsoftWebhookClientState(resource));
    expect(microsoftWebhookClientState(resource)).not.toBe(microsoftWebhookClientState("users/other@example.com/messages"));
  });
});
