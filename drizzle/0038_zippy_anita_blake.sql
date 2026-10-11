ALTER TABLE `financial_for_hire_po_events` ADD `releaseKey` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_for_hire_po_events` ADD `authorisedPayload` json;--> statement-breakpoint
ALTER TABLE `financial_for_hire_po_events` ADD `processingToken` varchar(128);--> statement-breakpoint
ALTER TABLE `financial_for_hire_po_events` ADD `nextBillingDate` varchar(10);