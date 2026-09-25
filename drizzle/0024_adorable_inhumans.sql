CREATE TABLE `extra_hire_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowRunId` int,
	`dealId` varchar(128) NOT NULL,
	`sourceHireEndDate` varchar(32) NOT NULL,
	`reservationKey` varchar(255) NOT NULL,
	`proposedInvoiceNumber` varchar(128),
	`status` enum('reserved','evaluated','held','confirmed') NOT NULL DEFAULT 'reserved',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `extra_hire_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `extra_hire_runs_reservation_unique` UNIQUE(`reservationKey`)
);
--> statement-breakpoint
CREATE TABLE `financial_document_intents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowRunId` int NOT NULL,
	`documentFamily` enum('purchase_order','customer_invoice') NOT NULL,
	`documentType` varchar(80) NOT NULL,
	`proposedAction` enum('create_draft','update_draft','validate_only','hold') NOT NULL DEFAULT 'create_draft',
	`proposedDocumentNumber` varchar(128),
	`reference` varchar(255),
	`partyName` varchar(255),
	`partySourceId` varchar(128),
	`accountCode` varchar(32),
	`gstTreatment` varchar(64),
	`currency` varchar(10) NOT NULL DEFAULT 'AUD',
	`subtotal` decimal(15,2) NOT NULL DEFAULT '0.00',
	`taxAmount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`total` decimal(15,2) NOT NULL DEFAULT '0.00',
	`issueDate` timestamp,
	`dueDate` timestamp,
	`lineItems` json NOT NULL,
	`sourceWorkflow` varchar(80) NOT NULL,
	`sourceRecordId` varchar(128),
	`validationStatus` enum('proposed','valid','warning','held','invalid') NOT NULL DEFAULT 'proposed',
	`validationSummary` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_document_intents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`intentId` int,
	`workflowRunId` int,
	`sourceWorkflow` varchar(80),
	`documentFamily` enum('purchase_order','customer_invoice') NOT NULL,
	`documentType` varchar(80) NOT NULL,
	`xeroDocumentId` varchar(128),
	`documentNumber` varchar(128) NOT NULL,
	`reference` varchar(255),
	`partyName` varchar(255),
	`status` varchar(64),
	`currency` varchar(10) NOT NULL DEFAULT 'AUD',
	`subtotal` decimal(15,2),
	`taxAmount` decimal(15,2),
	`total` decimal(15,2),
	`issueDate` timestamp,
	`dueDate` timestamp,
	`lineSnapshot` json,
	`xeroReadAt` timestamp,
	`refreshedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_documents_xero_document_unique` UNIQUE(`documentFamily`,`xeroDocumentId`)
);
--> statement-breakpoint
CREATE TABLE `financial_workflow_config` (
	`id` int AUTO_INCREMENT NOT NULL,
	`configKey` varchar(128) NOT NULL,
	`configValue` json NOT NULL,
	`description` varchar(500),
	`updatedBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_workflow_config_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_workflow_config_key_unique` UNIQUE(`configKey`)
);
--> statement-breakpoint
CREATE TABLE `financial_workflow_exception_comments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`exceptionId` int NOT NULL,
	`authorId` int NOT NULL,
	`comment` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_workflow_exception_comments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_workflow_exceptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowRunId` int,
	`documentIntentId` int,
	`exceptionCode` varchar(100) NOT NULL,
	`title` varchar(255) NOT NULL,
	`details` text NOT NULL,
	`severity` enum('warning','error') NOT NULL DEFAULT 'error',
	`status` enum('open','resolved','ignored') NOT NULL DEFAULT 'open',
	`sourceContext` json,
	`assignedTo` int,
	`resolvedBy` int,
	`resolvedAt` timestamp,
	`resolutionNotes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_workflow_exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_workflow_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`triggerType` enum('webhook','scheduled','manual','re_evaluation') NOT NULL DEFAULT 'manual',
	`sourceSystem` varchar(40) NOT NULL DEFAULT 'vtiger',
	`sourceRecordType` varchar(80),
	`sourceRecordId` varchar(128),
	`sourceRecordNumber` varchar(128),
	`idempotencyKey` varchar(255) NOT NULL,
	`mode` enum('shadow','dry_run','live') NOT NULL DEFAULT 'shadow',
	`status` enum('queued','evaluated','held','failed','duplicate') NOT NULL DEFAULT 'queued',
	`validationOutcome` enum('pending','passed','warning','failed') NOT NULL DEFAULT 'pending',
	`safeRequestSummary` json,
	`sourceSnapshot` json,
	`validationResults` json,
	`resultReferences` json,
	`errorMessage` text,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`evaluatedAt` timestamp,
	`completedAt` timestamp,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_workflow_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_workflow_runs_idempotency_unique` UNIQUE(`workflowType`,`idempotencyKey`)
);
--> statement-breakpoint
CREATE TABLE `recurring_hire_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowRunId` int,
	`containerControlId` varchar(128) NOT NULL,
	`containerControlNumber` varchar(128),
	`billingPeriodStart` timestamp NOT NULL,
	`billingPeriodEnd` timestamp NOT NULL,
	`reservationKey` varchar(255) NOT NULL,
	`proposedPoNumber` varchar(128),
	`status` enum('reserved','evaluated','held','confirmed') NOT NULL DEFAULT 'reserved',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `recurring_hire_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `recurring_hire_runs_reservation_unique` UNIQUE(`reservationKey`)
);
--> statement-breakpoint
CREATE TABLE `storage_billing_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`dealId` varchar(128),
	`containerControlId` varchar(128),
	`containerNumber` varchar(128),
	`containerType` varchar(80),
	`storageStage` varchar(80),
	`origin` varchar(255),
	`destination` varchar(255),
	`dateIn` timestamp,
	`dateOut` timestamp,
	`billedThroughDate` timestamp,
	`nextBillingDate` timestamp,
	`customerInvoiceDocumentId` int,
	`jdPurchaseOrderDocumentId` int,
	`gdPurchaseOrderDocumentId` int,
	`finalisationStatus` enum('open','pending','finalised','held') NOT NULL DEFAULT 'open',
	`sourceSnapshot` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `storage_billing_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `warranty_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowRunId` int,
	`dealId` varchar(128) NOT NULL,
	`warrantyCode` varchar(64),
	`warrantyDescription` varchar(255),
	`customerInvoiceDocumentId` int,
	`avisoPurchaseOrderDocumentId` int,
	`reconciliationStatus` enum('proposed','matched','held','exception') NOT NULL DEFAULT 'proposed',
	`sourceSnapshot` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `warranty_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `workflow_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workflowType` varchar(80) NOT NULL,
	`cronExpression` varchar(128),
	`taskUid` varchar(65),
	`enabled` boolean NOT NULL DEFAULT false,
	`lastRunAt` timestamp,
	`nextRunAt` timestamp,
	`lastOutcome` varchar(80),
	`auditData` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workflow_schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `workflow_schedules_workflow_unique` UNIQUE(`workflowType`)
);
