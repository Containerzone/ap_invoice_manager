CREATE TABLE `financial_for_hire_manual_handover_audits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`handoverId` int,
	`containerControlId` varchar(128) NOT NULL,
	`action` varchar(80) NOT NULL,
	`planHash` varchar(64),
	`actorId` int,
	`details` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_for_hire_manual_handover_audits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `financial_for_hire_manual_handovers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`containerControlId` varchar(128) NOT NULL,
	`containerControlNumber` varchar(64) NOT NULL,
	`manualPoId` varchar(64) NOT NULL,
	`manualPoNumber` varchar(128) NOT NULL,
	`coveredThrough` varchar(10) NOT NULL,
	`nextBillingDate` varchar(10),
	`status` enum('approved','reserved','completed','reconciliation_required','dehired') NOT NULL DEFAULT 'approved',
	`plan` json NOT NULL,
	`planHash` varchar(64) NOT NULL,
	`evidence` json NOT NULL,
	`approvedBy` int NOT NULL,
	`approvedAt` timestamp NOT NULL DEFAULT (now()),
	`manualCreationStopped` boolean NOT NULL,
	`acknowledgement` varchar(80) NOT NULL,
	`processingToken` varchar(64),
	`firstApEventId` int,
	`holdReason` text,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_for_hire_manual_handovers_id` PRIMARY KEY(`id`),
	CONSTRAINT `manual_hire_handover_control_unique` UNIQUE(`containerControlId`),
	CONSTRAINT `manual_hire_handover_po_unique` UNIQUE(`manualPoId`)
);
