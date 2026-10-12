CREATE TABLE `financial_customer_contact_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`customerKey` varchar(64) NOT NULL,
	`customerVtigerId` varchar(128) NOT NULL,
	`sourceSnapshotHash` varchar(64) NOT NULL,
	`tenantIdHash` varchar(64) NOT NULL,
	`idempotencyKey` varchar(64) NOT NULL,
	`xeroContactId` varchar(128),
	`status` enum('reserved','matched','created','held','reconciliation_required') NOT NULL,
	`evidence` json,
	`holdReason` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_customer_contact_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_customer_contact_key_unique` UNIQUE(`customerKey`),
	CONSTRAINT `financial_customer_contact_idempotency_unique` UNIQUE(`idempotencyKey`)
);
