CREATE TABLE `financial_for_hire_initial_provenance` (
	`id` int AUTO_INCREMENT NOT NULL,
	`containerControlId` varchar(128) NOT NULL,
	`initialEventId` int NOT NULL,
	`origin` varchar(80) NOT NULL,
	`initialCreatedAt` timestamp NOT NULL,
	`initialWriterExecutionId` int NOT NULL,
	`initialXeroPurchaseOrderId` varchar(128) NOT NULL,
	`initialReleaseKey` varchar(128) NOT NULL,
	`initialRulesHash` varchar(64) NOT NULL,
	`initialSourceSnapshotHash` varchar(64) NOT NULL,
	`initialReceiptHash` varchar(64) NOT NULL,
	`initialReceipt` json NOT NULL,
	`recordedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_for_hire_initial_provenance_id` PRIMARY KEY(`id`),
	CONSTRAINT `for_hire_initial_provenance_control_unique` UNIQUE(`containerControlId`),
	CONSTRAINT `for_hire_initial_provenance_event_unique` UNIQUE(`initialEventId`)
);
