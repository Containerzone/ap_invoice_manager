CREATE TABLE `pending_invites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`name` varchar(255),
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`claimedAt` timestamp,
	`claimedBy` int,
	CONSTRAINT `pending_invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `pending_invites_email_unique` UNIQUE(`email`)
);
