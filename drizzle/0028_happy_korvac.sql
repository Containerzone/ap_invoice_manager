CREATE TABLE `financial_cutover_audits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`cutoverControlId` int,
	`cutoverPackId` int,
	`action` varchar(100) NOT NULL,
	`outcome` enum('prepared','blocked','rejected') NOT NULL,
	`details` json,
	`actorId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_cutover_audits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_cutover_controls` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`mode` enum('shadow','live_ready_disabled','live_enabled','paused','retired') NOT NULL DEFAULT 'shadow',
	`implementationVersion` varchar(128) NOT NULL,
	`ruleVersion` varchar(128) NOT NULL,
	`currentWriterOwner` enum('operations','ap_management','unknown') NOT NULL DEFAULT 'unknown',
	`previousWriterOwner` enum('operations','ap_management','unknown') NOT NULL DEFAULT 'unknown',
	`legacyWriterIdentifier` varchar(500),
	`replacementIdentifier` varchar(500) NOT NULL,
	`liveEnabled` boolean NOT NULL DEFAULT false,
	`lastShadowRunId` int,
	`lastLiveRunId` int,
	`failureCount` int NOT NULL DEFAULT 0,
	`reconciliationState` enum('not_started','shadow_ready','awaiting_approval','reconciled','exception') NOT NULL DEFAULT 'not_started',
	`approvalReference` varchar(255),
	`rollbackPlan` text NOT NULL,
	`updatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_cutover_controls_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_cutover_controls_workflow_unique` UNIQUE(`workflowType`)
);
--> statement-breakpoint
CREATE TABLE `financial_cutover_packs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`shadowTestId` int,
	`candidateRosterEntryId` int,
	`sourceRecordNumber` varchar(128),
	`proposedDocumentIntentIds` json NOT NULL,
	`documentSummary` json NOT NULL,
	`xeroPreflight` json,
	`idempotencyKey` varchar(255),
	`legacyWriterIdentifier` varchar(500),
	`replacementIdentifier` varchar(500) NOT NULL,
	`rollbackPlan` text NOT NULL,
	`requiredApprovalText` text NOT NULL,
	`state` enum('prepared','awaiting_approval','approved','superseded') NOT NULL DEFAULT 'prepared',
	`preparedBy` int NOT NULL,
	`approvedBy` int,
	`approvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_cutover_packs_id` PRIMARY KEY(`id`)
);
