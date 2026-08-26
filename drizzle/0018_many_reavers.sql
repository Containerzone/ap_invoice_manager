CREATE TABLE `email_invoice_submissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`graphMessageId` varchar(512) NOT NULL,
	`graphAttachmentId` varchar(512) NOT NULL,
	`internetMessageId` varchar(512),
	`senderName` varchar(320),
	`senderAddress` varchar(320),
	`recipientAddress` varchar(320) NOT NULL,
	`subject` varchar(500),
	`receivedAt` timestamp,
	`attachmentName` varchar(512) NOT NULL,
	`attachmentMimeType` varchar(128),
	`attachmentSize` int,
	`invoiceId` int,
	`status` enum('received','processing','processed','ignored','duplicate','failed') NOT NULL DEFAULT 'received',
	`errorMessage` text,
	`metadata` json,
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `email_invoice_submissions_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_invoice_submissions_message_attachment_unique` UNIQUE(`graphMessageId`,`graphAttachmentId`)
);
--> statement-breakpoint
CREATE TABLE `microsoft_graph_states` (
	`id` int AUTO_INCREMENT NOT NULL,
	`mailbox` varchar(320) NOT NULL,
	`invoiceAlias` varchar(320) NOT NULL,
	`subscriptionId` varchar(128),
	`subscriptionExpiresAt` timestamp,
	`scheduleCronTaskUid` varchar(65),
	`lastSubscriptionError` text,
	`lastNotificationAt` timestamp,
	`lastRenewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `microsoft_graph_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `microsoft_graph_states_mailbox_unique` UNIQUE(`mailbox`)
);
