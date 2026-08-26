import { createHmac } from "node:crypto";
import { getMicrosoftGraphConfig, requestMicrosoftGraphAccessToken } from "./microsoftGraphConfig";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
let cachedToken: { value: string; expiresAt: number } | null = null;

export interface GraphRecipient { emailAddress?: { address?: string } }
export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: GraphRecipient[];
  hasAttachments?: boolean;
}
export interface GraphFileAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
  isInline?: boolean;
  "@odata.type"?: string;
}

async function graphToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const token = await requestMicrosoftGraphAccessToken();
  cachedToken = { value: token.accessToken, expiresAt: Date.now() + token.expiresInSeconds * 1000 };
  return token.accessToken;
}

async function graphRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await graphToken();
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Microsoft Graph request failed (${response.status}): ${(data as any)?.error?.code ?? "unknown_error"}`);
  return data as T;
}

export function microsoftWebhookClientState(resource: string): string {
  return createHmac("sha256", process.env.JWT_SECRET ?? "").update(`microsoft-graph:${resource}`).digest("hex");
}

export function isInvoiceAliasRecipient(message: GraphMessage): boolean {
  const { invoiceAlias } = getMicrosoftGraphConfig();
  return (message.toRecipients ?? []).some((recipient) =>
    recipient.emailAddress?.address?.trim().toLowerCase() === invoiceAlias
  );
}

export async function getGraphMessage(messageId: string): Promise<GraphMessage> {
  const { mailbox } = getMicrosoftGraphConfig();
  return graphRequest<GraphMessage>(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=id,internetMessageId,subject,receivedDateTime,from,toRecipients,hasAttachments`);
}

/** Confirms Mail.Read application access without reading email content. */
export async function getMicrosoftInboxMetadata(): Promise<{ id: string; displayName?: string }> {
  const { mailbox } = getMicrosoftGraphConfig();
  return graphRequest<{ id: string; displayName?: string }>(
    `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id,displayName`
  );
}

export async function getGraphPdfAttachments(messageId: string): Promise<GraphFileAttachment[]> {
  const { mailbox } = getMicrosoftGraphConfig();
  const data = await graphRequest<{ value?: GraphFileAttachment[] }>(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,contentBytes,isInline`);
  return (data.value ?? []).filter((attachment) =>
    !attachment.isInline && attachment.contentType === "application/pdf" && Boolean(attachment.contentBytes)
  );
}

export async function createGraphMessageSubscription(notificationUrl: string): Promise<{ id: string; expirationDateTime: string }> {
  const { mailbox } = getMicrosoftGraphConfig();
  const resource = `users/${mailbox}/messages`;
  return graphRequest("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource,
      expirationDateTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      clientState: microsoftWebhookClientState(resource),
    }),
  });
}

export async function renewGraphMessageSubscription(subscriptionId: string): Promise<{ id: string; expirationDateTime: string }> {
  return graphRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expirationDateTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() }),
  });
}
