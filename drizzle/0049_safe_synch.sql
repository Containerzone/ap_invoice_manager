ALTER TABLE `financial_customer_contact_events` ADD `workflowFamily` varchar(64);--> statement-breakpoint
ALTER TABLE `financial_customer_contact_events` ADD `sourceSummary` json;--> statement-breakpoint
ALTER TABLE `financial_customer_contact_events` ADD `outcome` varchar(96);--> statement-breakpoint
ALTER TABLE `financial_customer_contact_events` ADD `lookupSummary` json;