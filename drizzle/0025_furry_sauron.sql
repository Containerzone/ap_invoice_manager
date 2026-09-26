CREATE TABLE `financial_shadow_tests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`testKey` varchar(128) NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`branch` varchar(120) NOT NULL,
	`sourceRecordType` varchar(80),
	`sourceRecordId` varchar(128),
	`sourceRecordNumber` varchar(128),
	`expectedResult` json NOT NULL,
	`actualResult` json,
	`fieldComparisons` json,
	`xeroPreflight` json,
	`status` enum('pending','passed','failed','held','needs_data','blocked') NOT NULL DEFAULT 'pending',
	`differenceExplanation` text,
	`sourceRefreshedAt` timestamp,
	`workflowRunId` int,
	`documentIntentIds` json,
	`exceptionIds` json,
	`initiatedBy` int,
	`testedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_shadow_tests_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_shadow_tests_test_key_unique` UNIQUE(`testKey`)
);
--> statement-breakpoint
CREATE TABLE `financial_workflow_config_audits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configKey` varchar(128) NOT NULL,
	`previousValue` json,
	`nextValue` json NOT NULL,
	`description` varchar(500),
	`changedBy` int NOT NULL,
	`changedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_workflow_config_audits_id` PRIMARY KEY(`id`)
);
