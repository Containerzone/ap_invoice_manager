import type { GraphMessage } from "./microsoftGraphService";

export const MICROSOFT_RECONCILIATION_LOOKBACK_MS = 2 * 60 * 60 * 1000;
export const MICROSOFT_RECONCILIATION_MAX_MESSAGES = 10;

export function selectRecentAttachedMessageIds(
  messages: GraphMessage[],
  now = new Date(),
  lookbackMs = MICROSOFT_RECONCILIATION_LOOKBACK_MS,
  maxMessages = MICROSOFT_RECONCILIATION_MAX_MESSAGES,
): string[] {
  const cutoff = now.getTime() - lookbackMs;
  return messages
    .filter((message) => {
      if (!message.id || !message.hasAttachments || !message.receivedDateTime) return false;
      const receivedAt = new Date(message.receivedDateTime).getTime();
      return Number.isFinite(receivedAt) && receivedAt >= cutoff && receivedAt <= now.getTime();
    })
    .slice(0, maxMessages)
    .map((message) => message.id);
}

export async function reconcileRecentInvoiceMessages(
  messages: GraphMessage[],
  processMessage: (messageId: string) => Promise<void>,
  now = new Date(),
): Promise<{ considered: number; recovered: number; failedMessageIds: string[] }> {
  const messageIds = selectRecentAttachedMessageIds(messages, now);
  const failedMessageIds: string[] = [];
  let recovered = 0;
  for (const messageId of messageIds) {
    try {
      await processMessage(messageId);
      recovered += 1;
    } catch {
      failedMessageIds.push(messageId);
    }
  }
  return { considered: messageIds.length, recovered, failedMessageIds };
}
