CREATE TABLE `financial_execution_approvals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`approvalKey` varchar(96) NOT NULL,
	`workflowRunId` int NOT NULL,
	`documentIntentId` int NOT NULL,
	`releaseManifestId` int,
	`releaseFamilyId` int,
	`cutoverPackId` int,
	`workflowType` varchar(80) NOT NULL,
	`documentFamily` enum('purchase_order','customer_invoice') NOT NULL,
	`proposedAction` enum('create_draft','update_draft') NOT NULL,
	`proposalHash` varchar(64) NOT NULL,
	`sourceSnapshotHash` varchar(64) NOT NULL,
	`rulesSnapshotHash` varchar(64) NOT NULL,
	`xeroPreflightHash` varchar(64) NOT NULL,
	`sourceRecordId` varchar(128),
	`sourceRecordNumber` varchar(128),
	`proposedDocumentNumber` varchar(128) NOT NULL,
	`counterpartyName` varchar(255),
	`approvalReference` varchar(255) NOT NULL,
	`acknowledgement` text NOT NULL,
	`approvalSummary` json NOT NULL,
	`status` enum('approved','consumed','invalidated','rejected','expired') NOT NULL DEFAULT 'approved',
	`invalidationReason` text,
	`approvedBy` int NOT NULL,
	`approvedAt` timestamp NOT NULL DEFAULT (now()),
	`consumedByExecutionId` int,
	`consumedAt` timestamp,
	`expiresAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_execution_approvals_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_execution_approval_key_unique` UNIQUE(`approvalKey`),
	CONSTRAINT `financial_execution_approval_intent_hash_unique` UNIQUE(`documentIntentId`,`proposalHash`,`status`)
);
--> statement-breakpoint
CREATE TABLE `financial_post_success_actions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`executionId` int NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`actionType` enum('vtiger_note','vtiger_task','vtiger_hire_end_update') NOT NULL,
	`actionKey` varchar(128) NOT NULL,
	`sourceRecordId` varchar(128) NOT NULL,
	`payloadHash` varchar(64) NOT NULL,
	`safePayloadSummary` json NOT NULL,
	`status` enum('pending','succeeded','failed','reconciliation_required') NOT NULL DEFAULT 'pending',
	`vtigerRecordId` varchar(128),
	`errorMessage` text,
	`attemptCount` int NOT NULL DEFAULT 0,
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_post_success_actions_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_post_success_action_key_unique` UNIQUE(`actionKey`)
);
--> statement-breakpoint
ALTER TABLE `financial_document_intents` ADD `proposalHash` varchar(64);--> statement-breakpoint
ALTER TABLE `financial_document_intents` ADD `sourceSnapshotHash` varchar(64);--> statement-breakpoint
ALTER TABLE `financial_document_intents` ADD `rulesSnapshotHash` varchar(64);--> statement-breakpoint
ALTER TABLE `financial_document_intents` ADD `xeroPreflightHash` varchar(64);--> statement-breakpoint
ALTER TABLE `financial_document_intents` ADD `immutableAt` timestamp;--> statement-breakpoint
ALTER TABLE `financial_workflow_runs` ADD `sourceSnapshotHash` varchar(64);--> statement-breakpoint
ALTER TABLE `financial_workflow_runs` ADD `rulesSnapshotHash` varchar(64);--> statement-breakpoint
ALTER TABLE `financial_workflow_runs` ADD `proposalVersion` varchar(32) DEFAULT '2026-09-29' NOT NULL;