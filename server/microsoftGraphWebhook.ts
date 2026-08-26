import type { Express, Request, Response } from "express";
import { getMicrosoftGraphConfig } from "./microsoftGraphConfig";
import { getGraphMessage, getGraphPdfAttachments, isInvoiceAliasRecipient, microsoftWebhookClientState } from "./microsoftGraphService";
import { processMicrosoftEmailPdf } from "./emailInvoiceProcessingService";
import { getMicrosoftGraphState, updateMicrosoftGraphState } from "./db";

type GraphNotification = {
  clientState?: string;
  resource?: string;
  resourceData?: { id?: string };
};

async function processNotification(notification: GraphNotification) {
  const { mailbox } = getMicrosoftGraphConfig();
  const expectedResource = `users/${mailbox}/messages`;
  if (notification.clientState !== microsoftWebhookClientState(expectedResource)) {
    throw new Error("Rejected Microsoft Graph notification with an invalid client state");
  }
  const messageId = notification.resourceData?.id;
  if (!messageId) return;
  const message = await getGraphMessage(messageId);
  if (!isInvoiceAliasRecipient(message) || !message.hasAttachments) return;
  const attachments = await getGraphPdfAttachments(message.id);
  for (const attachment of attachments) await processMicrosoftEmailPdf(message, attachment);
  await updateMicrosoftGraphState(mailbox, { lastNotificationAt: new Date(), lastSubscriptionError: null });
}

export function registerMicrosoftGraphWebhook(app: Express) {
  app.post("/api/microsoft/notifications", (req: Request, res: Response) => {
    const validationToken = typeof req.query.validationToken === "string" ? req.query.validationToken : undefined;
    if (validationToken) return res.status(200).type("text/plain").send(validationToken);
    const notifications = Array.isArray(req.body?.value) ? req.body.value as GraphNotification[] : [];
    res.status(202).json({ accepted: notifications.length });
    setImmediate(() => {
      void Promise.all(notifications.map(async (notification) => {
        try {
          await processNotification(notification);
        } catch (error: any) {
          const mailbox = getMicrosoftGraphConfig().mailbox;
          await updateMicrosoftGraphState(mailbox, { lastSubscriptionError: error.message });
          console.error("[microsoft-graph] Notification processing failed:", error.message);
        }
      }));
    });
  });
}
