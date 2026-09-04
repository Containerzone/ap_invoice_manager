CREATE TABLE `workflow_failures` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`recordKey` varchar(255) NOT NULL,
	`title` varchar(255) NOT NULL,
	`errorMessage` text NOT NULL,
	`details` json,
	`severity` enum('warning','error') NOT NULL DEFAULT 'error',
	`status` enum('open','resolved') NOT NULL DEFAULT 'open',
	`occurrenceCount` int NOT NULL DEFAULT 1,
	`firstOccurredAt` timestamp NOT NULL DEFAULT (now()),
	`lastOccurredAt` timestamp NOT NULL DEFAULT (now()),
	`lastAlertedAt` timestamp,
	`alertError` text,
	`resolvedAt` timestamp,
	`resolvedBy` int,
	`resolutionNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workflow_failures_id` PRIMARY KEY(`id`),
	CONSTRAINT `workflow_failures_workflow_record_unique` UNIQUE(`workflowType`,`recordKey`)
);
--> statement-breakpoint
CREATE TABLE `workflow_monitoring_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`dailySummaryCronTaskUid` varchar(65),
	`lastDailySummaryAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workflow_monitoring_settings_id` PRIMARY KEY(`id`)
);
