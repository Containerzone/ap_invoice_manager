ALTER TABLE `financial_candidate_roster` DROP INDEX `financial_candidate_roster_reference_unique`;--> statement-breakpoint
ALTER TABLE `financial_candidate_discoveries` MODIFY COLUMN `sourceCategory` enum('deal','container_control','storage_billing_event') NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_candidate_discoveries` MODIFY COLUMN `outcome` enum('found','not_found','ambiguous','blocked','no_current_candidate') NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` MODIFY COLUMN `discoveryStatus` enum('draft','found','not_found','ambiguous','blocked','needs_data','no_current_candidate') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `financial_release_families` MODIFY COLUMN `releaseStatus` enum('included','held','no_current_candidate','excluded') NOT NULL DEFAULT 'no_current_candidate';--> statement-breakpoint
ALTER TABLE `financial_candidate_discoveries` ADD `familyKey` varchar(96);--> statement-breakpoint
ALTER TABLE `financial_candidate_discoveries` ADD `candidateSummaries` json;--> statement-breakpoint
ALTER TABLE `financial_candidate_discoveries` ADD `sourceSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_candidate_discoveries` ADD `rulesSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_candidate_discoveries` ADD `xeroPreflightHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD `familyKey` varchar(96);--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD `selectedPeriodStart` timestamp;--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD `selectedPeriodEnd` timestamp;--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD `evidenceStatus` enum('unverified','fresh','stale','needs_data') DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD `sourceSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD `rulesSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD `xeroPreflightHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_release_families` ADD `sourceSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_release_families` ADD `rulesSnapshotHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_release_families` ADD `xeroPreflightHash` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_release_families` ADD `evidenceStale` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_release_families` ADD `postSuccessMappingReadiness` json;--> statement-breakpoint
ALTER TABLE `financial_release_manifests` ADD `noCurrentCandidateFamilyCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_billing_events` ADD `provenance` enum('unverified_legacy','verified_execution') DEFAULT 'unverified_legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_billing_events` ADD `activationExecutionId` int;--> statement-breakpoint
ALTER TABLE `storage_billing_events` ADD `finalisationExecutionId` int;--> statement-breakpoint
ALTER TABLE `storage_billing_events` ADD `verifiedAt` timestamp;--> statement-breakpoint
ALTER TABLE `financial_candidate_roster` ADD CONSTRAINT `financial_candidate_roster_reference_unique` UNIQUE(`sourceCategory`,`businessNumber`,`familyKey`);