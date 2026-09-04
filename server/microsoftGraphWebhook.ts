import type { Express, Request, Response } from "express";
import { getMicrosoftGraphConfig } from "./microsoftGraphConfig";
import { getGraphMessage, getGraphPdfAttachments, isInvoiceAliasRecipient, microsoftInvoiceInboxResource, microsoftWebhookClientState } from "./microsoftGraphService";
import { processMicrosoftEmailPdf } from "./emailInvoiceProcessingService";
import { getMicrosoftGraphState, updateMicrosoftGraphState } from "./db";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

type GraphNotification = {
  clientState?: string;
  resource?: string;
  resourceData?: { id?: string };
};

let notificationQueue: Promise<void> = Promise.resolve();
const queuedMessageIds = new Set<string>();

async function processNotification(notification: GraphNotification) {
  const expectedResource = microsoftInvoiceInboxResource();
  if (notification.clientState !== microsoftWebhookClientState(expectedResource)) {
    throw new Error("Rejected Microsoft Graph notification with an invalid client state");
  }
  const messageId = notification.resourceData?.id;
  if (!messageId) return;
  if (queuedMessageIds.has(messageId)) return;
  queuedMessageIds.add(messageId);
  try {
  const message = await getGraphMessage(messageId);
  if (!isInvoiceAliasRecipient(message) || !message.hasAttachments) return;
  const [attachment] = await getGraphPdfAttachments(message.id);
  if (!attachment) return;
  await processMicrosoftEmailPdf(message, attachment);
  const { mailbox } = getMicrosoftGraphConfig();
  await updateMicrosoftGraphState(mailbox, { lastNotificationAt: new Date(), lastSubscriptionError: null });
  } finally {
    queuedMessageIds.delete(messageId);
  }
}

export function registerMicrosoftGraphWebhook(app: Express) {
  app.post("/api/microsoft/notifications", (req: Request, res: Response) => {
    const validationToken = typeof req.query.validationToken === "string" ? req.query.validationToken : undefined;
    if (validationToken) return res.status(200).type("text/plain").send(validationToken);
    const notifications = Array.isArray(req.body?.value) ? req.body.value as GraphNotification[] : [];
    res.status(202).json({ accepted: notifications.length });
    setImmediate(() => {
      for (const notification of notifications) {
        notificationQueue = notificationQueue.catch(() => undefined).then(async () => {
          try {
            await processNotification(notification);
          } catch (error: any) {
            const mailbox = getMicrosoftGraphConfig().mailbox;
            await updateMicrosoftGraphState(mailbox, { lastSubscriptionError: error.message });
            reportWorkflowFailureSafely({
              workflowType: "microsoft-graph-notification",
              recordKey: `graph-message:${notification.resourceData?.id ?? "unknown"}`,
              title: "Microsoft invoice notification processing failed",
              errorMessage: error.message ?? "Microsoft Graph notification processing failed",
              details: { mailbox, messageId: notification.resourceData?.id, resource: notification.resource },
              severity: "error",
            });
            console.error("[microsoft-graph] Notification processing failed:", error.message);
          }
        });
      }
    });
  });
}
