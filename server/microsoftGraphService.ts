import { createHmac } from "node:crypto";
import { getMicrosoftGraphConfig, requestMicrosoftGraphAccessToken } from "./microsoftGraphConfig";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
let cachedToken: { value: string; expiresAt: number } | null = null;

export function microsoftGraphRetryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10_000);
  return Math.min(1_000 * 2 ** attempt, 4_000);
}

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface GraphRecipient { emailAddress?: { address?: string } }
export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: GraphRecipient[];
  hasAttachments?: boolean;
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
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

async function graphRequest<T>(path: string, init?: RequestInit, operation = "request"): Promise<T> {
  const token = await graphToken();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${GRAPH_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data as T;
    const retryAfter = response.headers.get("retry-after");
    if ((response.status === 429 || response.status === 503) && attempt < 2) {
      await pause(microsoftGraphRetryDelayMs(retryAfter, attempt));
      continue;
    }
    const graphError = (data as any)?.error;
    const suffix = response.status === 429 && retryAfter ? `; retry after ${retryAfter}s` : "";
    throw new Error(`Microsoft Graph ${operation} failed (${response.status}): ${graphError?.code ?? "unknown_error"}${graphError?.message ? ` — ${graphError.message}` : ""}${suffix}`);
  }
  throw new Error(`Microsoft Graph ${operation} failed after retries`);
}

export function microsoftWebhookClientState(resource: string): string {
  return createHmac("sha256", process.env.JWT_SECRET ?? "").update(`microsoft-graph:${resource}`).digest("hex");
}

/**
 * Subscribe to Inbox messages only. This excludes an operator's Sent Items
 * forward copy while retaining the new inbound delivery to the invoices alias.
 */
export function microsoftInvoiceInboxResource(): string {
  const { mailbox } = getMicrosoftGraphConfig();
  return `users/${mailbox}/mailFolders/inbox/messages`;
}

export function microsoftGraphMessageResource(mailbox: string, messageId: string): string {
  return `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`;
}

export function isInvoiceAliasRecipient(message: GraphMessage): boolean {
  const { invoiceAlias } = getMicrosoftGraphConfig();
  const recipientMatch = (message.toRecipients ?? []).some((recipient) =>
    recipient.emailAddress?.address?.trim().toLowerCase() === invoiceAlias
  );
  if (recipientMatch) return true;
  const headerMatch = (message.internetMessageHeaders ?? []).some((header) =>
    ["to", "cc", "delivered-to", "x-original-to"].includes(header.name?.toLowerCase() ?? "") &&
    header.value?.toLowerCase().includes(invoiceAlias)
  );
  if (headerMatch) return true;
  return (message.internetMessageHeaders ?? []).some((header) =>
    header.name?.toLowerCase() === "x-containerzone-invoice-upload" && header.value?.trim().toLowerCase() === "true"
  );
}

export function isGraphPdfAttachment(attachment: GraphFileAttachment): boolean {
  const filenameIsPdf = attachment.name?.trim().toLowerCase().endsWith(".pdf") ?? false;
  return !attachment.isInline
    && Boolean(attachment.id)
    && (attachment.contentType?.toLowerCase() === "application/pdf" || filenameIsPdf);
}

/** Select exactly the first non-inline PDF in Graph's source attachment order. */
export function selectFirstGraphPdfAttachment(attachments: GraphFileAttachment[]): GraphFileAttachment | undefined {
  return attachments.find(isGraphPdfAttachment);
}

export async function getGraphMessage(messageId: string, mailboxOverride?: string): Promise<GraphMessage> {
  const { mailbox } = getMicrosoftGraphConfig();
  const mailboxToRead = mailboxOverride ?? mailbox;
  return graphRequest<GraphMessage>(`${microsoftGraphMessageResource(mailboxToRead, messageId)}?$select=id,internetMessageId,subject,receivedDateTime,from,toRecipients,hasAttachments,internetMessageHeaders`, undefined, "retrieve notified message");
}

/** Confirms Mail.Read application access without reading email content. */
export async function getMicrosoftInboxMetadata(): Promise<{ id: string; displayName?: string }> {
  const { mailbox } = getMicrosoftGraphConfig();
  return graphRequest<{ id: string; displayName?: string }>(
    `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id,displayName`
  );
}

export async function getRecentMicrosoftMessageMetadata(limit = 10): Promise<GraphMessage[]> {
  const { mailbox } = getMicrosoftGraphConfig();
  const count = Math.min(Math.max(limit, 1), 25);
  const data = await graphRequest<{ value?: GraphMessage[] }>(
    `/users/${encodeURIComponent(mailbox)}/messages?$top=${count}&$orderby=receivedDateTime desc&$select=id,internetMessageId,subject,receivedDateTime,from,toRecipients,hasAttachments`,
    undefined,
    "list mailbox message metadata"
  );
  return data.value ?? [];
}

export async function getGraphPdfAttachments(messageId: string, mailboxOverride?: string): Promise<GraphFileAttachment[]> {
  const { mailbox } = getMicrosoftGraphConfig();
  const mailboxToRead = mailboxOverride ?? mailbox;
  const basePath = `${microsoftGraphMessageResource(mailboxToRead, messageId)}/attachments`;
  const data = await graphRequest<{ value?: GraphFileAttachment[] }>(
    `${basePath}?$select=id,name,contentType,size,isInline`,
    undefined,
    "list message attachments"
  );
  const pdfMetadata = selectFirstGraphPdfAttachment(data.value ?? []);
  if (!pdfMetadata) return [];
  const attachment = await graphRequest<GraphFileAttachment>(
    `${basePath}/${encodeURIComponent(pdfMetadata.id)}`,
    undefined,
    "retrieve first PDF attachment content"
  );
  return attachment.contentBytes ? [attachment] : [];
}

export async function createGraphMessageSubscription(notificationUrl: string): Promise<{ id: string; expirationDateTime: string }> {
  const resource = microsoftInvoiceInboxResource();
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

export async function deleteGraphMessageSubscription(subscriptionId: string): Promise<void> {
  await graphRequest(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "DELETE" },
    "delete previous mailbox subscription"
  );
}

export async function renewGraphMessageSubscription(subscriptionId: string): Promise<{ id: string; expirationDateTime: string }> {
  return graphRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ expirationDateTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() }),
  });
}
