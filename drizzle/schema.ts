import {
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  decimal,
  boolean,
  json,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  status: mysqlEnum("status", ["active", "disabled"]).default("active").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Suppliers ────────────────────────────────────────────────────────────────

export const suppliers = mysqlTable("suppliers", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  abn: varchar("abn", { length: 20 }),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 50 }),
  address: text("address"),
  contactName: varchar("contactName", { length: 255 }),
  xeroContactId: varchar("xeroContactId", { length: 64 }),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  createdBy: int("createdBy"),
});

export type Supplier = typeof suppliers.$inferSelect;
export type InsertSupplier = typeof suppliers.$inferInsert;

// ─── Invoices ─────────────────────────────────────────────────────────────────

export const invoices = mysqlTable("invoices", {
  id: int("id").autoincrement().primaryKey(),

  // File storage
  fileKey: varchar("fileKey", { length: 512 }).notNull(),
  fileUrl: varchar("fileUrl", { length: 1024 }).notNull(),
  originalFileName: varchar("originalFileName", { length: 255 }),

  // Status workflow
  status: mysqlEnum("status", [
    "uploaded",
    "extracting",
    "extracted",
    "verified",
    "under_budget",
    "approved",
    "flagged",
    "queried",
    "queried_2nd",
    "queried_3rd",
    "queried_4th",
    "queried_5th",
    "resolved",
    "duplicate",
    "archived",
  ])
    .default("uploaded")
    .notNull(),

  // Query tracking
  queryCount: int("queryCount").default(0).notNull(),

  // Extracted fields (from LLM/OCR)
  extractedInvoiceNumber: varchar("extractedInvoiceNumber", { length: 100 }),
  extractedPoNumber: varchar("extractedPoNumber", { length: 100 }),
  extractedContainerNumbers: text("extractedContainerNumbers"), // JSON array stored as text
  extractedSupplierName: varchar("extractedSupplierName", { length: 255 }),
  extractedSupplierAbn: varchar("extractedSupplierAbn", { length: 20 }),
  extractedSupplierEmail: varchar("extractedSupplierEmail", { length: 320 }),
  extractedInvoiceDate: varchar("extractedInvoiceDate", { length: 50 }),
  extractedDueDate: varchar("extractedDueDate", { length: 50 }),
  extractedSubtotal: decimal("extractedSubtotal", { precision: 15, scale: 2 }),
  extractedTax: decimal("extractedTax", { precision: 15, scale: 2 }),
  extractedTotal: decimal("extractedTotal", { precision: 15, scale: 2 }),
  extractedCurrency: varchar("extractedCurrency", { length: 10 }).default("AUD"),
  extractedRawData: json("extractedRawData"), // Full LLM response

  // Supplier link
  supplierId: int("supplierId"),

  // Xero verification
  xeroInvoiceId: varchar("xeroInvoiceId", { length: 64 }),
  xeroInvoiceNumber: varchar("xeroInvoiceNumber", { length: 100 }),
  xeroTotal: decimal("xeroTotal", { precision: 15, scale: 2 }),
  xeroSubtotal: decimal("xeroSubtotal", { precision: 15, scale: 2 }),
  xeroTax: decimal("xeroTax", { precision: 15, scale: 2 }),
  xeroStatus: varchar("xeroStatus", { length: 50 }),
  xeroVerifiedAt: timestamp("xeroVerifiedAt"),
  // Multi-PO verification results: array of { poNumber, found, status, poTotal, discrepancy, diff, lineItems[] }
  xeroPoResults: json("xeroPoResults"),

  // Discrepancy
  hasDiscrepancy: boolean("hasDiscrepancy").default(false),
  discrepancyNotes: text("discrepancyNotes"),
  discrepancyAmount: decimal("discrepancyAmount", { precision: 15, scale: 2 }),
  // Total net difference across all POs: positive = net over-billed, negative = net under-billed
  totalNetDiff: decimal("totalNetDiff", { precision: 15, scale: 2 }),

  // Multi-PO numbers (up to 15, stored as JSON array)
  extractedPoNumbers: json("extractedPoNumbers"), // string[]

  // Original PO amounts stored on first verification (for variance reports)
  // { [poNumber]: amount } — immutable after first verify
  originalPoAmounts: json("originalPoAmounts"), // Record<string, number>

  // Two-layer approval
  staffApproved: boolean("staffApproved").default(false),
  staffApprovedBy: int("staffApprovedBy"),
  staffApprovedAt: timestamp("staffApprovedAt"),
  adminApproved: boolean("adminApproved").default(false),
  adminApprovedBy: int("adminApprovedBy"),
  adminApprovedAt: timestamp("adminApprovedAt"),
  approvalNotes: text("approvalNotes"),
  requiresAdminApproval: boolean("requiresAdminApproval").default(false),

  // Query points (numbered list of dispute reasons)
  queryPoints: json("queryPoints"), // string[]

  // Resolution
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: int("resolvedBy"),
  resolutionNotes: text("resolutionNotes"),
  xeroFinalBillId: varchar("xeroFinalBillId", { length: 64 }),
  xeroFinalBillNumber: varchar("xeroFinalBillNumber", { length: 100 }),
  pdfAttachedToXero: boolean("pdfAttachedToXero").default(false),

  // Archive (paid invoices)
  archivedAt: timestamp("archivedAt"),

  // Metadata
  uploadedBy: int("uploadedBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Invoice = typeof invoices.$inferSelect;
export type InsertInvoice = typeof invoices.$inferInsert;

// ─── Invoice Line Items ───────────────────────────────────────────────────────

export const invoiceLineItems = mysqlTable("invoice_line_items", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),
  description: text("description"),
  quantity: decimal("quantity", { precision: 10, scale: 3 }),
  unitPrice: decimal("unitPrice", { precision: 15, scale: 2 }),
  amount: decimal("amount", { precision: 15, scale: 2 }),
  taxRate: decimal("taxRate", { precision: 5, scale: 2 }),
  accountCode: varchar("accountCode", { length: 50 }),
  // PO number associated with this specific line item (e.g. from "Cust Ref" column on Pacific National invoices)
  poNumber: varchar("poNumber", { length: 50 }),
  // Set to true when a user manually edits the poNumber field — signals that the edited value is
  // authoritative and the original custRef/description scan should be ignored for this line.
  poNumberEdited: boolean("poNumberEdited").default(false),
  // Raw customer reference field from invoice (may contain container number + PO number)
  custRef: varchar("custRef", { length: 200 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;
export type InsertInvoiceLineItem = typeof invoiceLineItems.$inferInsert;

// ─── Email Logs ───────────────────────────────────────────────────────────────

export const emailLogs = mysqlTable("email_logs", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),
  sentBy: int("sentBy").notNull(),
  fromAddress: varchar("fromAddress", { length: 320 }).notNull(),
  toAddress: varchar("toAddress", { length: 320 }).notNull(),
  ccAddress: varchar("ccAddress", { length: 320 }),
  subject: varchar("subject", { length: 500 }).notNull(),
  body: text("body").notNull(),
  status: mysqlEnum("status", ["sent", "failed", "pending"]).default("pending").notNull(),
  errorMessage: text("errorMessage"),
  sentAt: timestamp("sentAt"),
  // Reply tracking
  replyBody: text("replyBody"),
  repliedAt: timestamp("repliedAt"),
  repliedBy: int("repliedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type EmailLog = typeof emailLogs.$inferSelect;
export type InsertEmailLog = typeof emailLogs.$inferInsert;

// ─── Conversation Notes ───────────────────────────────────────────────────────

export const conversationNotes = mysqlTable("conversation_notes", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoiceId").notNull(),
  authorId: int("authorId").notNull(),
  type: mysqlEnum("type", ["note", "email_sent", "email_received", "status_change", "system"])
    .default("note")
    .notNull(),
  content: text("content").notNull(),
  emailLogId: int("emailLogId"), // link to email_logs if type = email_sent
  metadata: json("metadata"), // extra context (old status, new status, etc.)
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ConversationNote = typeof conversationNotes.$inferSelect;
export type InsertConversationNote = typeof conversationNotes.$inferInsert;

// ─── Pending Invites ─────────────────────────────────────────────────────────
// Admin pre-registers an email + role; when that user signs in via OAuth,
// they are automatically assigned the pre-configured role.

export const pendingInvites = mysqlTable("pending_invites", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  name: varchar("name", { length: 255 }), // optional display name hint
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  claimedAt: timestamp("claimedAt"), // set when the invited user first signs in
  claimedBy: int("claimedBy"), // FK to users.id
});

export type PendingInvite = typeof pendingInvites.$inferSelect;
export type InsertPendingInvite = typeof pendingInvites.$inferInsert;

// ─── Xero Tokens ─────────────────────────────────────────────────────────────

export const xeroTokens = mysqlTable("xero_tokens", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: varchar("tenantId", { length: 64 }).notNull(),
  tenantName: varchar("tenantName", { length: 255 }),
  accessToken: text("accessToken").notNull(),
  refreshToken: text("refreshToken").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  scope: text("scope"),
  connectedBy: int("connectedBy").notNull(),
  rateLimitPausedUntil: timestamp("rateLimitPausedUntil"),
  rateLimitProblem: varchar("rateLimitProblem", { length: 32 }),
  rateLimitRetryAfterSeconds: int("rateLimitRetryAfterSeconds"),
  rateLimitMinuteRemaining: int("rateLimitMinuteRemaining"),
  rateLimitDayRemaining: int("rateLimitDayRemaining"),
  rateLimitUpdatedAt: timestamp("rateLimitUpdatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type XeroToken = typeof xeroTokens.$inferSelect;
export type InsertXeroToken = typeof xeroTokens.$inferInsert;

export const xeroApiCache = mysqlTable("xero_api_cache", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: varchar("tenantId", { length: 64 }).notNull(),
  cacheKey: varchar("cacheKey", { length: 255 }).notNull(),
  responseData: json("responseData").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  tenantCacheKey: uniqueIndex("xero_api_cache_tenant_key").on(table.tenantId, table.cacheKey),
}));

export type XeroApiCache = typeof xeroApiCache.$inferSelect;
export type InsertXeroApiCache = typeof xeroApiCache.$inferInsert;

// ─── Microsoft 365 Graph Inbound Invoice Processing ──────────────────────────

export const microsoftGraphStates = mysqlTable("microsoft_graph_states", {
  id: int("id").autoincrement().primaryKey(),
  mailbox: varchar("mailbox", { length: 320 }).notNull(),
  invoiceAlias: varchar("invoiceAlias", { length: 320 }).notNull(),
  subscriptionId: varchar("subscriptionId", { length: 128 }),
  subscriptionExpiresAt: timestamp("subscriptionExpiresAt"),
  scheduleCronTaskUid: varchar("scheduleCronTaskUid", { length: 65 }),
  lastSubscriptionError: text("lastSubscriptionError"),
  lastNotificationAt: timestamp("lastNotificationAt"),
  lastRenewedAt: timestamp("lastRenewedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  mailboxUnique: uniqueIndex("microsoft_graph_states_mailbox_unique").on(table.mailbox),
}));

export type MicrosoftGraphState = typeof microsoftGraphStates.$inferSelect;
export type InsertMicrosoftGraphState = typeof microsoftGraphStates.$inferInsert;

export const emailInvoiceSubmissions = mysqlTable("email_invoice_submissions", {
  id: int("id").autoincrement().primaryKey(),
  graphMessageId: varchar("graphMessageId", { length: 512 }).notNull(),
  graphAttachmentId: varchar("graphAttachmentId", { length: 512 }).notNull(),
  internetMessageId: varchar("internetMessageId", { length: 512 }),
  senderName: varchar("senderName", { length: 320 }),
  senderAddress: varchar("senderAddress", { length: 320 }),
  recipientAddress: varchar("recipientAddress", { length: 320 }).notNull(),
  subject: varchar("subject", { length: 500 }),
  receivedAt: timestamp("receivedAt"),
  attachmentName: varchar("attachmentName", { length: 512 }).notNull(),
  attachmentMimeType: varchar("attachmentMimeType", { length: 128 }),
  attachmentSize: int("attachmentSize"),
  invoiceId: int("invoiceId"),
  status: mysqlEnum("status", ["received", "processing", "processed", "ignored", "duplicate", "failed"])
    .default("received")
    .notNull(),
  errorMessage: text("errorMessage"),
  metadata: json("metadata"),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  messageAttachmentUnique: uniqueIndex("email_invoice_submissions_message_attachment_unique")
    .on(table.graphMessageId, table.graphAttachmentId),
}));

export type EmailInvoiceSubmission = typeof emailInvoiceSubmissions.$inferSelect;
export type InsertEmailInvoiceSubmission = typeof emailInvoiceSubmissions.$inferInsert;

// ─── PO Requests (Vtiger → Xero) ─────────────────────────────────────────────
// Each row represents one Vtiger Deal webhook event that triggered PO creation.

export const poRequests = mysqlTable("po_requests", {
  id: int("id").autoincrement().primaryKey(),

  // Vtiger identifiers
  vtigerDealId: varchar("vtigerDealId", { length: 64 }).notNull(),
  vtigerDealNumber: varchar("vtigerDealNumber", { length: 64 }),
  vtigerDealName: varchar("vtigerDealName", { length: 255 }),
  vtigerQuoteId: varchar("vtigerQuoteId", { length: 64 }),
  vtigerQuoteNumber: varchar("vtigerQuoteNumber", { length: 64 }),

  // Processing status
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed", "partial"])
    .default("pending")
    .notNull(),

  // Raw webhook payload (for debugging and field discovery)
  rawPayload: json("rawPayload"),

  // Per-PO results: array of { poNumber, prefix, amount, supplier, accountCode, xeroPoId, xeroPoNumber, status, error }
  poResults: json("poResults"),

  // Error message if overall processing failed
  errorMessage: text("errorMessage"),

  // Timestamps
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type PoRequest = typeof poRequests.$inferSelect;
export type InsertPoRequest = typeof poRequests.$inferInsert;

// ─── Workflow Failure Monitoring ─────────────────────────────────────────────

/** Durable, de-duplicated operational failures from all automated workflows. */
export const workflowFailures = mysqlTable("workflow_failures", {
  id: int("id").autoincrement().primaryKey(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  recordKey: varchar("recordKey", { length: 255 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  errorMessage: text("errorMessage").notNull(),
  details: json("details"),
  severity: mysqlEnum("severity", ["warning", "error"]).default("error").notNull(),
  status: mysqlEnum("status", ["open", "resolved"]).default("open").notNull(),
  occurrenceCount: int("occurrenceCount").default(1).notNull(),
  firstOccurredAt: timestamp("firstOccurredAt").defaultNow().notNull(),
  lastOccurredAt: timestamp("lastOccurredAt").defaultNow().notNull(),
  lastAlertedAt: timestamp("lastAlertedAt"),
  alertError: text("alertError"),
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: int("resolvedBy"),
  resolutionNotes: text("resolutionNotes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  workflowRecordUnique: uniqueIndex("workflow_failures_workflow_record_unique")
    .on(table.workflowType, table.recordKey),
}));

export type WorkflowFailure = typeof workflowFailures.$inferSelect;
export type InsertWorkflowFailure = typeof workflowFailures.$inferInsert;

/** Project-level settings for the operational failure monitor. */
export const workflowMonitoringSettings = mysqlTable("workflow_monitoring_settings", {
  id: int("id").autoincrement().primaryKey(),
  dailySummaryCronTaskUid: varchar("dailySummaryCronTaskUid", { length: 65 }),
  lastDailySummaryAt: timestamp("lastDailySummaryAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type WorkflowMonitoringSettings = typeof workflowMonitoringSettings.$inferSelect;
export type InsertWorkflowMonitoringSettings = typeof workflowMonitoringSettings.$inferInsert;
