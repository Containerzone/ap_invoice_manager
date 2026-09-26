CREATE TABLE `financial_candidate_discoveries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceCategory` enum('deal','container_control') NOT NULL,
	`businessNumber` varchar(128) NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`outcome` enum('found','not_found','ambiguous','blocked') NOT NULL,
	`candidateRecordIds` json,
	`sourceRefreshedAt` timestamp,
	`message` text,
	`initiatedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_candidate_discoveries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_integration_audits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`integration` enum('xero','vtiger') NOT NULL,
	`action` varchar(80) NOT NULL,
	`outcome` enum('passed','blocked','failed') NOT NULL,
	`tenantName` varchar(255),
	`tenantId` varchar(128),
	`details` json,
	`actorId` int,
	`checkedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_integration_audits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `financial_shadow_tests` ADD `reviewStatus` enum('pending','confirmed','rejected') DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_shadow_tests` ADD `reviewedBy` int;--> statement-breakpoint
ALTER TABLE `financial_shadow_tests` ADD `reviewedAt` timestamp;--> statement-breakpoint
ALTER TABLE `financial_shadow_tests` ADD `reviewerComment` text;