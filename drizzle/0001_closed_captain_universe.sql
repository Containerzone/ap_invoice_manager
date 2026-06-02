CREATE TABLE `conversation_notes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`authorId` int NOT NULL,
	`type` enum('note','email_sent','email_received','status_change','system') NOT NULL DEFAULT 'note',
	`content` text NOT NULL,
	`emailLogId` int,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `conversation_notes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `email_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`sentBy` int NOT NULL,
	`fromAddress` varchar(320) NOT NULL,
	`toAddress` varchar(320) NOT NULL,
	`ccAddress` varchar(320),
	`subject` varchar(500) NOT NULL,
	`body` text NOT NULL,
	`status` enum('sent','failed','pending') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`sentAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoice_line_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`description` text,
	`quantity` decimal(10,3),
	`unitPrice` decimal(15,2),
	`amount` decimal(15,2),
	`taxRate` decimal(5,2),
	`accountCode` varchar(50),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoice_line_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fileKey` varchar(512) NOT NULL,
	`fileUrl` varchar(1024) NOT NULL,
	`originalFileName` varchar(255),
	`status` enum('uploaded','extracting','extracted','verified','flagged','queried','resolved') NOT NULL DEFAULT 'uploaded',
	`extractedInvoiceNumber` varchar(100),
	`extractedPoNumber` varchar(100),
	`extractedContainerNumbers` text,
	`extractedSupplierName` varchar(255),
	`extractedSupplierAbn` varchar(20),
	`extractedSupplierEmail` varchar(320),
	`extractedInvoiceDate` varchar(50),
	`extractedDueDate` varchar(50),
	`extractedSubtotal` decimal(15,2),
	`extractedTax` decimal(15,2),
	`extractedTotal` decimal(15,2),
	`extractedCurrency` varchar(10) DEFAULT 'AUD',
	`extractedRawData` json,
	`supplierId` int,
	`xeroInvoiceId` varchar(64),
	`xeroInvoiceNumber` varchar(100),
	`xeroTotal` decimal(15,2),
	`xeroSubtotal` decimal(15,2),
	`xeroTax` decimal(15,2),
	`xeroStatus` varchar(50),
	`xeroVerifiedAt` timestamp,
	`hasDiscrepancy` boolean DEFAULT false,
	`discrepancyNotes` text,
	`discrepancyAmount` decimal(15,2),
	`resolvedAt` timestamp,
	`resolvedBy` int,
	`resolutionNotes` text,
	`xeroFinalBillId` varchar(64),
	`xeroFinalBillNumber` varchar(100),
	`uploadedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`abn` varchar(20),
	`email` varchar(320),
	`phone` varchar(50),
	`address` text,
	`contactName` varchar(255),
	`xeroContactId` varchar(64),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdBy` int,
	CONSTRAINT `suppliers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `xero_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` varchar(64) NOT NULL,
	`tenantName` varchar(255),
	`accessToken` text NOT NULL,
	`refreshToken` text NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`scope` text,
	`connectedBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `xero_tokens_id` PRIMARY KEY(`id`)
);
