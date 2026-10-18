CREATE TABLE `financial_billing_party_sync_audits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`auditKey` varchar(96) NOT NULL,
	`eventFingerprint` varchar(64),
	`dealId` varchar(128) NOT NULL,
	`xeroInvoiceId` varchar(128),
	`action` enum('preview','reserved','submitted','outcome') NOT NULL,
	`outcome` enum('updated','unchanged','not_found','held','reconciliation_required','disabled') NOT NULL,
	`details` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_billing_party_sync_audits_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_billing_party_sync_audit_key_unique` UNIQUE(`auditKey`)
);
--> statement-breakpoint
CREATE TABLE `financial_billing_party_sync_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventFingerprint` varchar(64) NOT NULL,
	`dealId` varchar(128) NOT NULL,
	`trigger` enum('deposit_invoice','main_invoice_finalisation') NOT NULL,
	`tenantIdHash` varchar(64) NOT NULL,
	`xeroInvoiceId` varchar(128) NOT NULL,
	`invoiceNumber` varchar(128) NOT NULL,
	`sourceSnapshotHash` varchar(64) NOT NULL,
	`targetContactId` varchar(128) NOT NULL,
	`originalContactId` varchar(128) NOT NULL,
	`originalInvoiceFingerprint` varchar(64) NOT NULL,
	`payloadFingerprint` varchar(64) NOT NULL,
	`rulesSnapshotHash` varchar(64) NOT NULL,
	`sourceSnapshot` json NOT NULL,
	`originalInvoiceSnapshot` json NOT NULL,
	`targetContactEvidence` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_billing_party_sync_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_billing_party_sync_exact_unique` UNIQUE(`eventFingerprint`)
);
--> statement-breakpoint
CREATE TABLE `financial_billing_party_sync_locks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`xeroInvoiceId` varchar(128) NOT NULL,
	`eventFingerprint` varchar(64) NOT NULL,
	`dealId` varchar(128) NOT NULL,
	`targetContactId` varchar(128) NOT NULL,
	`state` enum('reserved','submitted','updated','held','reconciliation_required') NOT NULL DEFAULT 'reserved',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financial_billing_party_sync_locks_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_billing_party_sync_invoice_lock_unique` UNIQUE(`xeroInvoiceId`)
);
