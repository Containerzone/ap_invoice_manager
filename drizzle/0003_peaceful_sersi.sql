ALTER TABLE `invoices` MODIFY COLUMN `status` enum('uploaded','extracting','extracted','verified','flagged','queried','queried_2nd','queried_3rd','resolved') NOT NULL DEFAULT 'uploaded';--> statement-breakpoint
ALTER TABLE `email_logs` ADD `replyBody` text;--> statement-breakpoint
ALTER TABLE `email_logs` ADD `repliedAt` timestamp;--> statement-breakpoint
ALTER TABLE `email_logs` ADD `repliedBy` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `queryCount` int DEFAULT 0 NOT NULL;