ALTER TABLE `invoices` ADD `extractedPoNumbers` json;--> statement-breakpoint
ALTER TABLE `invoices` ADD `staffApproved` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `invoices` ADD `staffApprovedBy` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `staffApprovedAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `adminApproved` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `invoices` ADD `adminApprovedBy` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `adminApprovedAt` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `approvalNotes` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `requiresAdminApproval` boolean DEFAULT false;