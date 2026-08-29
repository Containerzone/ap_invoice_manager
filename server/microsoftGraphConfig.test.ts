import { describe, expect, it } from "vitest";
import { getMicrosoftGraphConfig, requestMicrosoftGraphAccessToken } from "./microsoftGraphConfig";
import { getMicrosoftInboxMetadata } from "./microsoftGraphService";

describe("Microsoft Graph credential configuration", () => {
  it("accepts the securely configured production credential set without exposing values", () => {
    const config = getMicrosoftGraphConfig();

    expect(config.tenantId).not.toHaveLength(0);
    expect(config.clientId).not.toHaveLength(0);
    expect(config.clientSecret).not.toHaveLength(0);
    expect(config.mailbox).toBe("invoices@containerzone.com.au");
    expect(config.invoiceAlias).toBe("invoices@containerzone.com.au");
  });

  it("obtains a Microsoft Graph access token without reading mailbox content", async () => {
    const token = await requestMicrosoftGraphAccessToken();

    expect(token.accessToken.length).toBeGreaterThan(100);
    expect(token.expiresInSeconds).toBeGreaterThan(0);
  }, 20_000);

  it("can access inbox metadata without reading email content", async () => {
    const inbox = await getMicrosoftInboxMetadata();
    expect(inbox.id).not.toHaveLength(0);
  }, 20_000);
});
