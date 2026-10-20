CREATE TABLE `financial_deposit_main_deduction_attempts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`attemptKey` varchar(64) NOT NULL,
	`dealId` varchar(128),
	`dealNumber` varchar(128),
	`trigger` varchar(32) NOT NULL,
	`outcome` enum('disabled','not_ready','already_deducted','held','reconciliation_required','deducted') NOT NULL,
	`phase` enum('release','source','xero_read','eligibility','reservation','writer','completed') NOT NULL,
	`deductionEventId` int,
	`executionId` int,
	`reason` varchar(2000),
	`details` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `financial_deposit_main_deduction_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `financial_deposit_main_deduction_attempt_unique` UNIQUE(`attemptKey`)
);
