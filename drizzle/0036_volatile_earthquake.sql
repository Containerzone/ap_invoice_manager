ALTER TABLE `financial_initial_storage_events` ADD `eventKind` enum('initial','recurring','recovery') DEFAULT 'initial' NOT NULL;--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `parentEventId` int;--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `nextBillingDate` varchar(10);--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `finalisedAt` timestamp;--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `releaseKey` varchar(96);--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `authorisedPayloads` json;--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `finalisationResults` json;--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `finalDate` varchar(10);--> statement-breakpoint
ALTER TABLE `financial_initial_storage_events` ADD `processingToken` varchar(64);