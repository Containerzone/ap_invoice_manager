CREATE TABLE `xero_api_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` varchar(64) NOT NULL,
	`cacheKey` varchar(255) NOT NULL,
	`responseData` json NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `xero_api_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `xero_api_cache_tenant_key` UNIQUE(`tenantId`,`cacheKey`)
);
--> statement-breakpoint
ALTER TABLE `xero_tokens` ADD `rateLimitPausedUntil` timestamp;--> statement-breakpoint
ALTER TABLE `xero_tokens` ADD `rateLimitProblem` varchar(32);--> statement-breakpoint
ALTER TABLE `xero_tokens` ADD `rateLimitRetryAfterSeconds` int;--> statement-breakpoint
ALTER TABLE `xero_tokens` ADD `rateLimitMinuteRemaining` int;--> statement-breakpoint
ALTER TABLE `xero_tokens` ADD `rateLimitDayRemaining` int;--> statement-breakpoint
ALTER TABLE `xero_tokens` ADD `rateLimitUpdatedAt` timestamp;