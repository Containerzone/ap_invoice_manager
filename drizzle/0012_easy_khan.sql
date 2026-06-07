CREATE TABLE `po_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`vtigerDealId` varchar(64) NOT NULL,
	`vtigerDealNumber` varchar(64),
	`vtigerDealName` varchar(255),
	`vtigerQuoteId` varchar(64),
	`vtigerQuoteNumber` varchar(64),
	`status` enum('pending','processing','completed','failed','partial') NOT NULL DEFAULT 'pending',
	`rawPayload` json,
	`poResults` json,
	`errorMessage` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `po_requests_id` PRIMARY KEY(`id`)
);
