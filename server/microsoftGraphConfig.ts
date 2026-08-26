export interface MicrosoftGraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
  invoiceAlias: string;
}

export interface MicrosoftGraphAccessToken {
  accessToken: string;
  expiresInSeconds: number;
}

const REQUIRED_KEYS = [
  "MICROSOFT_TENANT_ID",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_MAILBOX",
  "MICROSOFT_INVOICE_ALIAS",
] as const;

function requireValue(env: NodeJS.ProcessEnv, key: typeof REQUIRED_KEYS[number]): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required Microsoft Graph setting: ${key}`);
  return value;
}

export function getMicrosoftGraphConfig(env: NodeJS.ProcessEnv = process.env): MicrosoftGraphConfig {
  const config = {
    tenantId: requireValue(env, "MICROSOFT_TENANT_ID"),
    clientId: requireValue(env, "MICROSOFT_CLIENT_ID"),
    clientSecret: requireValue(env, "MICROSOFT_CLIENT_SECRET"),
    mailbox: requireValue(env, "MICROSOFT_MAILBOX").toLowerCase(),
    invoiceAlias: requireValue(env, "MICROSOFT_INVOICE_ALIAS").toLowerCase(),
  };

  if (!config.mailbox.includes("@") || !config.invoiceAlias.includes("@")) {
    throw new Error("Microsoft mailbox and invoice alias must be email addresses");
  }

  return config;
}

/** Uses client credentials only; it does not read or alter mailbox content. */
export async function requestMicrosoftGraphAccessToken(
  config = getMicrosoftGraphConfig()
): Promise<MicrosoftGraphAccessToken> {
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }
  );
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(`Microsoft Graph authentication failed (${response.status}): ${payload.error ?? "unknown_error"}`);
  }
  return {
    accessToken: payload.access_token,
    expiresInSeconds: payload.expires_in ?? 0,
  };
}
