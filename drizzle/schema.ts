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
  // True when the PO number list was manually saved, including an intentional
  // empty list. This prevents raw OCR references from being reintroduced.
  poNumbersManuallyEdited: boolean("poNumbersManuallyEdited").default(false).notNull(),

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
  // Read-only snapshot of the exact linked ACCPAY bill used by the Reports
  // reconciliation tab. Updated only by an explicit reconciliation refresh.
  xeroBillReconciliationSnapshot: json("xeroBillReconciliationSnapshot"),

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
  notificationUrl: varchar("notificationUrl", { length: 1024 }),
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
  mailboxReconciliationCronTaskUid: varchar("mailboxReconciliationCronTaskUid", { length: 65 }),
  lastDailySummaryAt: timestamp("lastDailySummaryAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type WorkflowMonitoringSettings = typeof workflowMonitoringSettings.$inferSelect;
export type InsertWorkflowMonitoringSettings = typeof workflowMonitoringSettings.$inferInsert;

// ─── Financial Trigger Migration — Shadow-Mode Ledger ─────────────────────────
//
// These tables are deliberately additive and independent from AP supplier-bill
// processing. Phase one records proposed financial actions and validation only;
// no row in this ledger authorises a Xero write.

export const financialWorkflowRuns = mysqlTable("financial_workflow_runs", {
  id: int("id").autoincrement().primaryKey(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  triggerType: mysqlEnum("triggerType", ["webhook", "scheduled", "manual", "re_evaluation"])
    .default("manual")
    .notNull(),
  sourceSystem: varchar("sourceSystem", { length: 40 }).default("vtiger").notNull(),
  sourceRecordType: varchar("sourceRecordType", { length: 80 }),
  sourceRecordId: varchar("sourceRecordId", { length: 128 }),
  sourceRecordNumber: varchar("sourceRecordNumber", { length: 128 }),
  idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
  mode: mysqlEnum("mode", ["shadow", "dry_run", "live"] as const).default("shadow").notNull(),
  status: mysqlEnum("status", ["queued", "evaluated", "held", "failed", "duplicate"] as const)
    .default("queued")
    .notNull(),
  validationOutcome: mysqlEnum("validationOutcome", ["pending", "passed", "warning", "failed"] as const)
    .default("pending")
    .notNull(),
  safeRequestSummary: json("safeRequestSummary"),
  sourceSnapshot: json("sourceSnapshot"),
  validationResults: json("validationResults"),
  resultReferences: json("resultReferences"),
  /** SHA-256 of the exact current VTiger source used for this evaluated proposal. */
  sourceSnapshotHash: varchar("sourceSnapshotHash", { length: 64 }),
  /** SHA-256 of the effective non-secret financial rule set used by the proposal. */
  rulesSnapshotHash: varchar("rulesSnapshotHash", { length: 64 }),
  /** Immutable proposal contract version; retained to invalidate superseded approval formats. */
  proposalVersion: varchar("proposalVersion", { length: 32 }).default("2026-09-29").notNull(),
  errorMessage: text("errorMessage"),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  evaluatedAt: timestamp("evaluatedAt"),
  completedAt: timestamp("completedAt"),
  createdBy: int("createdBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  workflowIdempotencyUnique: uniqueIndex("financial_workflow_runs_idempotency_unique")
    .on(table.workflowType, table.idempotencyKey),
}));

export type FinancialWorkflowRun = typeof financialWorkflowRuns.$inferSelect;
export type InsertFinancialWorkflowRun = typeof financialWorkflowRuns.$inferInsert;

export const financialDocumentIntents = mysqlTable("financial_document_intents", {
  id: int("id").autoincrement().primaryKey(),
  workflowRunId: int("workflowRunId").notNull(),
  documentFamily: mysqlEnum("documentFamily", ["purchase_order", "customer_invoice"] as const).notNull(),
  documentType: varchar("documentType", { length: 80 }).notNull(),
  proposedAction: mysqlEnum("proposedAction", ["create_draft", "update_draft", "validate_only", "hold"] as const)
    .default("create_draft")
    .notNull(),
  proposedDocumentNumber: varchar("proposedDocumentNumber", { length: 128 }),
  reference: varchar("reference", { length: 255 }),
  partyName: varchar("partyName", { length: 255 }),
  partySourceId: varchar("partySourceId", { length: 128 }),
  accountCode: varchar("accountCode", { length: 32 }),
  gstTreatment: varchar("gstTreatment", { length: 64 }),
  currency: varchar("currency", { length: 10 }).default("AUD").notNull(),
  subtotal: decimal("subtotal", { precision: 15, scale: 2 }).default("0.00").notNull(),
  taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }).default("0.00").notNull(),
  total: decimal("total", { precision: 15, scale: 2 }).default("0.00").notNull(),
  issueDate: timestamp("issueDate"),
  dueDate: timestamp("dueDate"),
  lineItems: json("lineItems").notNull(),
  sourceWorkflow: varchar("sourceWorkflow", { length: 80 }).notNull(),
  sourceRecordId: varchar("sourceRecordId", { length: 128 }),
  validationStatus: mysqlEnum("validationStatus", ["proposed", "valid", "warning", "held", "invalid"] as const)
    .default("proposed")
    .notNull(),
  validationSummary: json("validationSummary"),
  /** Stable hash of every document field that an administrator approves. */
  proposalHash: varchar("proposalHash", { length: 64 }),
  sourceSnapshotHash: varchar("sourceSnapshotHash", { length: 64 }),
  rulesSnapshotHash: varchar("rulesSnapshotHash", { length: 64 }),
  xeroPreflightHash: varchar("xeroPreflightHash", { length: 64 }),
  immutableAt: timestamp("immutableAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type FinancialDocumentIntent = typeof financialDocumentIntents.$inferSelect;
export type InsertFinancialDocumentIntent = typeof financialDocumentIntents.$inferInsert;

// ─── Financial Proposal Approval and Post-success Audit ──────────────────────
//
// These tables bind one named Xero draft action to one immutable AP proposal.
// They do not enable a writer. An approval is single-use and will be invalidated
// by a material source, rule, proposal or preflight change before any transport.

export const financialExecutionApprovals = mysqlTable("financial_execution_approvals", {
  id: int("id").autoincrement().primaryKey(),
  approvalKey: varchar("approvalKey", { length: 96 }).notNull(),
  workflowRunId: int("workflowRunId").notNull(),
  documentIntentId: int("documentIntentId").notNull(),
  releaseManifestId: int("releaseManifestId"),
  releaseFamilyId: int("releaseFamilyId"),
  cutoverPackId: int("cutoverPackId"),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  documentFamily: mysqlEnum("documentFamily", ["purchase_order", "customer_invoice"] as const).notNull(),
  proposedAction: mysqlEnum("proposedAction", ["create_draft", "update_draft"] as const).notNull(),
  proposalHash: varchar("proposalHash", { length: 64 }).notNull(),
  sourceSnapshotHash: varchar("sourceSnapshotHash", { length: 64 }).notNull(),
  rulesSnapshotHash: varchar("rulesSnapshotHash", { length: 64 }).notNull(),
  xeroPreflightHash: varchar("xeroPreflightHash", { length: 64 }).notNull(),
  sourceRecordId: varchar("sourceRecordId", { length: 128 }),
  sourceRecordNumber: varchar("sourceRecordNumber", { length: 128 }),
  proposedDocumentNumber: varchar("proposedDocumentNumber", { length: 128 }).notNull(),
  counterpartyName: varchar("counterpartyName", { length: 255 }),
  approvalReference: varchar("approvalReference", { length: 255 }).notNull(),
  acknowledgement: text("acknowledgement").notNull(),
  approvalSummary: json("approvalSummary").notNull(),
  status: mysqlEnum("status", ["approved", "consumed", "invalidated", "rejected", "expired"] as const)
    .default("approved")
    .notNull(),
  invalidationReason: text("invalidationReason"),
  approvedBy: int("approvedBy").notNull(),
  approvedAt: timestamp("approvedAt").defaultNow().notNull(),
  consumedByExecutionId: int("consumedByExecutionId"),
  consumedAt: timestamp("consumedAt"),
  expiresAt: timestamp("expiresAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialExecutionApprovalKeyUnique: uniqueIndex("financial_execution_approval_key_unique").on(table.approvalKey),
  financialExecutionApprovalIntentUnique: uniqueIndex("financial_execution_approval_intent_hash_unique")
    .on(table.documentIntentId, table.proposalHash, table.status),
}));

export type FinancialExecutionApproval = typeof financialExecutionApprovals.$inferSelect;
export type InsertFinancialExecutionApproval = typeof financialExecutionApprovals.$inferInsert;

/** Post-success VTiger work is named, retryable and never replays the Xero write. */
export const financialPostSuccessActions = mysqlTable("financial_post_success_actions", {
  id: int("id").autoincrement().primaryKey(),
  executionId: int("executionId").notNull(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  actionType: mysqlEnum("actionType", ["vtiger_note", "vtiger_task", "vtiger_hire_end_update"] as const).notNull(),
  actionKey: varchar("actionKey", { length: 128 }).notNull(),
  sourceRecordId: varchar("sourceRecordId", { length: 128 }).notNull(),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  safePayloadSummary: json("safePayloadSummary").notNull(),
  status: mysqlEnum("status", ["pending", "succeeded", "failed", "reconciliation_required"] as const)
    .default("pending")
    .notNull(),
  vtigerRecordId: varchar("vtigerRecordId", { length: 128 }),
  errorMessage: text("errorMessage"),
  attemptCount: int("attemptCount").default(0).notNull(),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialPostSuccessActionKeyUnique: uniqueIndex("financial_post_success_action_key_unique").on(table.actionKey),
}));

export type FinancialPostSuccessAction = typeof financialPostSuccessActions.$inferSelect;
export type InsertFinancialPostSuccessAction = typeof financialPostSuccessActions.$inferInsert;

/** Imported or later-confirmed Xero document snapshots. Shadow mode only reads them. */
export const financialDocuments = mysqlTable("financial_documents", {
  id: int("id").autoincrement().primaryKey(),
  intentId: int("intentId"),
  workflowRunId: int("workflowRunId"),
  sourceWorkflow: varchar("sourceWorkflow", { length: 80 }),
  documentFamily: mysqlEnum("documentFamily", ["purchase_order", "customer_invoice"] as const).notNull(),
  documentType: varchar("documentType", { length: 80 }).notNull(),
  xeroDocumentId: varchar("xeroDocumentId", { length: 128 }),
  documentNumber: varchar("documentNumber", { length: 128 }).notNull(),
  reference: varchar("reference", { length: 255 }),
  partyName: varchar("partyName", { length: 255 }),
  status: varchar("status", { length: 64 }),
  currency: varchar("currency", { length: 10 }).default("AUD").notNull(),
  subtotal: decimal("subtotal", { precision: 15, scale: 2 }),
  taxAmount: decimal("taxAmount", { precision: 15, scale: 2 }),
  total: decimal("total", { precision: 15, scale: 2 }),
  issueDate: timestamp("issueDate"),
  dueDate: timestamp("dueDate"),
  lineSnapshot: json("lineSnapshot"),
  xeroReadAt: timestamp("xeroReadAt"),
  refreshedAt: timestamp("refreshedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  documentXeroUnique: uniqueIndex("financial_documents_xero_document_unique")
    .on(table.documentFamily, table.xeroDocumentId),
}));

export type FinancialDocument = typeof financialDocuments.$inferSelect;
export type InsertFinancialDocument = typeof financialDocuments.$inferInsert;

export const storageBillingEvents = mysqlTable("storage_billing_events", {
  id: int("id").autoincrement().primaryKey(),
  dealId: varchar("dealId", { length: 128 }),
  containerControlId: varchar("containerControlId", { length: 128 }),
  containerNumber: varchar("containerNumber", { length: 128 }),
  containerType: varchar("containerType", { length: 80 }),
  storageStage: varchar("storageStage", { length: 80 }),
  origin: varchar("origin", { length: 255 }),
  destination: varchar("destination", { length: 255 }),
  dateIn: timestamp("dateIn"),
  dateOut: timestamp("dateOut"),
  billedThroughDate: timestamp("billedThroughDate"),
  nextBillingDate: timestamp("nextBillingDate"),
  customerInvoiceDocumentId: int("customerInvoiceDocumentId"),
  jdPurchaseOrderDocumentId: int("jdPurchaseOrderDocumentId"),
  gdPurchaseOrderDocumentId: int("gdPurchaseOrderDocumentId"),
  finalisationStatus: mysqlEnum("finalisationStatus", ["open", "pending", "finalised", "held"] as const)
    .default("open")
    .notNull(),
  sourceSnapshot: json("sourceSnapshot"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type StorageBillingEvent = typeof storageBillingEvents.$inferSelect;
export type InsertStorageBillingEvent = typeof storageBillingEvents.$inferInsert;

export const recurringHireRuns = mysqlTable("recurring_hire_runs", {
  id: int("id").autoincrement().primaryKey(),
  workflowRunId: int("workflowRunId"),
  containerControlId: varchar("containerControlId", { length: 128 }).notNull(),
  containerControlNumber: varchar("containerControlNumber", { length: 128 }),
  billingPeriodStart: timestamp("billingPeriodStart").notNull(),
  billingPeriodEnd: timestamp("billingPeriodEnd").notNull(),
  reservationKey: varchar("reservationKey", { length: 255 }).notNull(),
  proposedPoNumber: varchar("proposedPoNumber", { length: 128 }),
  status: mysqlEnum("status", ["reserved", "evaluated", "held", "confirmed"] as const).default("reserved").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  recurringHireReservationUnique: uniqueIndex("recurring_hire_runs_reservation_unique").on(table.reservationKey),
}));

export type RecurringHireRun = typeof recurringHireRuns.$inferSelect;
export type InsertRecurringHireRun = typeof recurringHireRuns.$inferInsert;

export const extraHireRuns = mysqlTable("extra_hire_runs", {
  id: int("id").autoincrement().primaryKey(),
  workflowRunId: int("workflowRunId"),
  dealId: varchar("dealId", { length: 128 }).notNull(),
  sourceHireEndDate: varchar("sourceHireEndDate", { length: 32 }).notNull(),
  reservationKey: varchar("reservationKey", { length: 255 }).notNull(),
  proposedInvoiceNumber: varchar("proposedInvoiceNumber", { length: 128 }),
  status: mysqlEnum("status", ["reserved", "evaluated", "held", "confirmed"] as const).default("reserved").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  extraHireReservationUnique: uniqueIndex("extra_hire_runs_reservation_unique").on(table.reservationKey),
}));

export type ExtraHireRun = typeof extraHireRuns.$inferSelect;
export type InsertExtraHireRun = typeof extraHireRuns.$inferInsert;

export const warrantyDocuments = mysqlTable("warranty_documents", {
  id: int("id").autoincrement().primaryKey(),
  workflowRunId: int("workflowRunId"),
  dealId: varchar("dealId", { length: 128 }).notNull(),
  warrantyCode: varchar("warrantyCode", { length: 64 }),
  warrantyDescription: varchar("warrantyDescription", { length: 255 }),
  customerInvoiceDocumentId: int("customerInvoiceDocumentId"),
  avisoPurchaseOrderDocumentId: int("avisoPurchaseOrderDocumentId"),
  reconciliationStatus: mysqlEnum("reconciliationStatus", ["proposed", "matched", "held", "exception"] as const)
    .default("proposed")
    .notNull(),
  sourceSnapshot: json("sourceSnapshot"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type WarrantyDocument = typeof warrantyDocuments.$inferSelect;
export type InsertWarrantyDocument = typeof warrantyDocuments.$inferInsert;

export const financialWorkflowExceptions = mysqlTable("financial_workflow_exceptions", {
  id: int("id").autoincrement().primaryKey(),
  workflowRunId: int("workflowRunId"),
  documentIntentId: int("documentIntentId"),
  exceptionCode: varchar("exceptionCode", { length: 100 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  details: text("details").notNull(),
  severity: mysqlEnum("severity", ["warning", "error"] as const).default("error").notNull(),
  status: mysqlEnum("status", ["open", "resolved", "ignored"] as const).default("open").notNull(),
  sourceContext: json("sourceContext"),
  assignedTo: int("assignedTo"),
  resolvedBy: int("resolvedBy"),
  resolvedAt: timestamp("resolvedAt"),
  resolutionNotes: text("resolutionNotes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type FinancialWorkflowException = typeof financialWorkflowExceptions.$inferSelect;
export type InsertFinancialWorkflowException = typeof financialWorkflowExceptions.$inferInsert;

export const financialWorkflowExceptionComments = mysqlTable("financial_workflow_exception_comments", {
  id: int("id").autoincrement().primaryKey(),
  exceptionId: int("exceptionId").notNull(),
  authorId: int("authorId").notNull(),
  comment: text("comment").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type FinancialWorkflowExceptionComment = typeof financialWorkflowExceptionComments.$inferSelect;
export type InsertFinancialWorkflowExceptionComment = typeof financialWorkflowExceptionComments.$inferInsert;

/** Configuration records only; they never register, enable or invoke a task. */
export const workflowSchedules = mysqlTable("workflow_schedules", {
  id: int("id").autoincrement().primaryKey(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  cronExpression: varchar("cronExpression", { length: 128 }),
  taskUid: varchar("taskUid", { length: 65 }),
  enabled: boolean("enabled").default(false).notNull(),
  lastRunAt: timestamp("lastRunAt"),
  nextRunAt: timestamp("nextRunAt"),
  lastOutcome: varchar("lastOutcome", { length: 80 }),
  auditData: json("auditData"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialWorkflowScheduleUnique: uniqueIndex("workflow_schedules_workflow_unique").on(table.workflowType),
}));

export type WorkflowSchedule = typeof workflowSchedules.$inferSelect;
export type InsertWorkflowSchedule = typeof workflowSchedules.$inferInsert;

/** Admin-editable, non-secret financial mappings and shadow validation rules. */
export const financialWorkflowConfig = mysqlTable("financial_workflow_config", {
  id: int("id").autoincrement().primaryKey(),
  configKey: varchar("configKey", { length: 128 }).notNull(),
  configValue: json("configValue").notNull(),
  description: varchar("description", { length: 500 }),
  updatedBy: int("updatedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialWorkflowConfigKeyUnique: uniqueIndex("financial_workflow_config_key_unique").on(table.configKey),
}));

export type FinancialWorkflowConfig = typeof financialWorkflowConfig.$inferSelect;
export type InsertFinancialWorkflowConfig = typeof financialWorkflowConfig.$inferInsert;

// ─── Financial Shadow Validation Evidence ───────────────────────────────────
//
// Phase 1.5 remains evidence-only. These records make each administrator-led
// read-only test reproducible without creating or changing a Xero document.

export const financialWorkflowConfigAudits = mysqlTable("financial_workflow_config_audits", {
  id: int("id").autoincrement().primaryKey(),
  configKey: varchar("configKey", { length: 128 }).notNull(),
  previousValue: json("previousValue"),
  nextValue: json("nextValue").notNull(),
  description: varchar("description", { length: 500 }),
  changedBy: int("changedBy").notNull(),
  changedAt: timestamp("changedAt").defaultNow().notNull(),
});

export type FinancialWorkflowConfigAudit = typeof financialWorkflowConfigAudits.$inferSelect;
export type InsertFinancialWorkflowConfigAudit = typeof financialWorkflowConfigAudits.$inferInsert;

export const financialShadowTests = mysqlTable("financial_shadow_tests", {
  id: int("id").autoincrement().primaryKey(),
  testKey: varchar("testKey", { length: 128 }).notNull(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  branch: varchar("branch", { length: 120 }).notNull(),
  sourceRecordType: varchar("sourceRecordType", { length: 80 }),
  sourceRecordId: varchar("sourceRecordId", { length: 128 }),
  sourceRecordNumber: varchar("sourceRecordNumber", { length: 128 }),
  expectedResult: json("expectedResult").notNull(),
  actualResult: json("actualResult"),
  fieldComparisons: json("fieldComparisons"),
  xeroPreflight: json("xeroPreflight"),
  status: mysqlEnum("status", ["pending", "passed", "failed", "held", "needs_data", "blocked"] as const)
    .default("pending")
    .notNull(),
  differenceExplanation: text("differenceExplanation"),
  sourceRefreshedAt: timestamp("sourceRefreshedAt"),
  workflowRunId: int("workflowRunId"),
  documentIntentIds: json("documentIntentIds"),
  exceptionIds: json("exceptionIds"),
  initiatedBy: int("initiatedBy"),
  testedAt: timestamp("testedAt"),
  reviewStatus: mysqlEnum("reviewStatus", ["pending", "confirmed", "rejected"] as const)
    .default("pending")
    .notNull(),
  reviewedBy: int("reviewedBy"),
  reviewedAt: timestamp("reviewedAt"),
  reviewerComment: text("reviewerComment"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  shadowTestKeyUnique: uniqueIndex("financial_shadow_tests_test_key_unique").on(table.testKey),
}));

export type FinancialShadowTest = typeof financialShadowTests.$inferSelect;
export type InsertFinancialShadowTest = typeof financialShadowTests.$inferInsert;

/**
 * Every exact AP-side VTiger candidate lookup is retained without storing a
 * raw source payload. This proves a named discovery search occurred without
 * turning the evidence ledger into a copy of the CRM database.
 */
export const financialCandidateDiscoveries = mysqlTable("financial_candidate_discoveries", {
  id: int("id").autoincrement().primaryKey(),
  sourceCategory: mysqlEnum("sourceCategory", ["deal", "container_control"] as const).notNull(),
  businessNumber: varchar("businessNumber", { length: 128 }).notNull(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  outcome: mysqlEnum("outcome", ["found", "not_found", "ambiguous", "blocked"] as const).notNull(),
  candidateRecordIds: json("candidateRecordIds"),
  sourceRefreshedAt: timestamp("sourceRefreshedAt"),
  message: text("message"),
  initiatedBy: int("initiatedBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type FinancialCandidateDiscovery = typeof financialCandidateDiscoveries.$inferSelect;
export type InsertFinancialCandidateDiscovery = typeof financialCandidateDiscoveries.$inferInsert;

/**
 * A deliberately small, administrator-entered list of named records that may
 * be used for Phase 1.7 shadow validation. It is never populated by a VTiger
 * enumeration or historical import, and it contains no raw CRM payload.
 */
export const financialCandidateRoster = mysqlTable("financial_candidate_roster", {
  id: int("id").autoincrement().primaryKey(),
  sourceCategory: mysqlEnum("sourceCategory", ["deal", "container_control"] as const).notNull(),
  businessNumber: varchar("businessNumber", { length: 128 }).notNull(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  branch: varchar("branch", { length: 120 }).notNull(),
  businessNote: text("businessNote"),
  ownerId: int("ownerId"),
  reviewerId: int("reviewerId"),
  discoveryStatus: mysqlEnum("discoveryStatus", ["draft", "found", "not_found", "ambiguous", "blocked", "needs_data"] as const)
    .default("draft")
    .notNull(),
  candidateRecordId: varchar("candidateRecordId", { length: 128 }),
  latestDiscoveryId: int("latestDiscoveryId"),
  latestShadowTestId: int("latestShadowTestId"),
  lastDiscoveryMessage: text("lastDiscoveryMessage"),
  lastResolvedAt: timestamp("lastResolvedAt"),
  createdBy: int("createdBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  candidateRosterReferenceUnique: uniqueIndex("financial_candidate_roster_reference_unique").on(table.sourceCategory, table.businessNumber),
}));

export type FinancialCandidateRoster = typeof financialCandidateRoster.$inferSelect;
export type InsertFinancialCandidateRoster = typeof financialCandidateRoster.$inferInsert;

/**
 * Contains non-secret AP integration outcomes, such as a completed GET-only
 * Xero tenant check or an OAuth reconnect. Credentials and raw responses are
 * never stored here.
 */
export const financialIntegrationAudits = mysqlTable("financial_integration_audits", {
  id: int("id").autoincrement().primaryKey(),
  integration: mysqlEnum("integration", ["xero", "vtiger"] as const).notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  outcome: mysqlEnum("outcome", ["passed", "blocked", "failed"] as const).notNull(),
  tenantName: varchar("tenantName", { length: 255 }),
  tenantId: varchar("tenantId", { length: 128 }),
  details: json("details"),
  actorId: int("actorId"),
  checkedAt: timestamp("checkedAt").defaultNow().notNull(),
});

export type FinancialIntegrationAudit = typeof financialIntegrationAudits.$inferSelect;
export type InsertFinancialIntegrationAudit = typeof financialIntegrationAudits.$inferInsert;

// ─── Financial Cutover Controls — Permanently Disabled Until Approval ─────────
//
// These records prepare an auditable, per-family migration plan. They do not
// register a writer endpoint, enable a schedule, or authorise a Xero request.

export const financialCutoverControls = mysqlTable("financial_cutover_controls", {
  id: int("id").autoincrement().primaryKey(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  mode: mysqlEnum("mode", ["shadow", "live_ready_disabled", "live_enabled", "paused", "retired"] as const)
    .default("shadow")
    .notNull(),
  implementationVersion: varchar("implementationVersion", { length: 128 }).notNull(),
  ruleVersion: varchar("ruleVersion", { length: 128 }).notNull(),
  currentWriterOwner: mysqlEnum("currentWriterOwner", ["operations", "ap_management", "unknown"] as const)
    .default("unknown")
    .notNull(),
  previousWriterOwner: mysqlEnum("previousWriterOwner", ["operations", "ap_management", "unknown"] as const)
    .default("unknown")
    .notNull(),
  legacyWriterIdentifier: varchar("legacyWriterIdentifier", { length: 500 }),
  replacementIdentifier: varchar("replacementIdentifier", { length: 500 }).notNull(),
  liveEnabled: boolean("liveEnabled").default(false).notNull(),
  lastShadowRunId: int("lastShadowRunId"),
  lastLiveRunId: int("lastLiveRunId"),
  failureCount: int("failureCount").default(0).notNull(),
  reconciliationState: mysqlEnum("reconciliationState", ["not_started", "shadow_ready", "awaiting_approval", "reconciled", "exception"] as const)
    .default("not_started")
    .notNull(),
  approvalReference: varchar("approvalReference", { length: 255 }),
  rollbackPlan: text("rollbackPlan").notNull(),
  updatedBy: int("updatedBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  cutoverControlWorkflowUnique: uniqueIndex("financial_cutover_controls_workflow_unique").on(table.workflowType),
}));

export type FinancialCutoverControl = typeof financialCutoverControls.$inferSelect;
export type InsertFinancialCutoverControl = typeof financialCutoverControls.$inferInsert;

export const financialCutoverPacks = mysqlTable("financial_cutover_packs", {
  id: int("id").autoincrement().primaryKey(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  shadowTestId: int("shadowTestId"),
  candidateRosterEntryId: int("candidateRosterEntryId"),
  sourceRecordNumber: varchar("sourceRecordNumber", { length: 128 }),
  proposedDocumentIntentIds: json("proposedDocumentIntentIds").notNull(),
  documentSummary: json("documentSummary").notNull(),
  xeroPreflight: json("xeroPreflight"),
  idempotencyKey: varchar("idempotencyKey", { length: 255 }),
  legacyWriterIdentifier: varchar("legacyWriterIdentifier", { length: 500 }),
  replacementIdentifier: varchar("replacementIdentifier", { length: 500 }).notNull(),
  rollbackPlan: text("rollbackPlan").notNull(),
  requiredApprovalText: text("requiredApprovalText").notNull(),
  state: mysqlEnum("state", ["prepared", "awaiting_approval", "approved", "superseded"] as const)
    .default("prepared")
    .notNull(),
  preparedBy: int("preparedBy").notNull(),
  approvedBy: int("approvedBy"),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type FinancialCutoverPack = typeof financialCutoverPacks.$inferSelect;
export type InsertFinancialCutoverPack = typeof financialCutoverPacks.$inferInsert;

/** Append-only local audit of disabled cutover planning; no credential values are stored. */
export const financialCutoverAudits = mysqlTable("financial_cutover_audits", {
  id: int("id").autoincrement().primaryKey(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  cutoverControlId: int("cutoverControlId"),
  cutoverPackId: int("cutoverPackId"),
  action: varchar("action", { length: 100 }).notNull(),
  outcome: mysqlEnum("outcome", ["prepared", "blocked", "rejected"] as const).notNull(),
  details: json("details"),
  actorId: int("actorId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type FinancialCutoverAudit = typeof financialCutoverAudits.$inferSelect;
export type InsertFinancialCutoverAudit = typeof financialCutoverAudits.$inferInsert;

// ─── All Financial Operations Go-Live Release Preparation ───────────────────
//
// These records are strictly planning and evidence artefacts. They preserve a
// frozen all-family release manifest without enabling an AP writer, changing an
// Operations/VTiger configuration, or authorising a Xero transport.

export const financialReleaseManifests = mysqlTable("financial_release_manifests", {
  id: int("id").autoincrement().primaryKey(),
  releaseId: varchar("releaseId", { length: 96 }).notNull(),
  status: mysqlEnum("status", ["preparation", "awaiting_approval", "approved", "superseded"] as const)
    .default("preparation")
    .notNull(),
  implementationVersion: varchar("implementationVersion", { length: 128 }).notNull(),
  frozenRuleVersion: varchar("frozenRuleVersion", { length: 128 }).notNull(),
  frozenRules: json("frozenRules").notNull(),
  xeroReadiness: json("xeroReadiness").notNull(),
  vtigerReadiness: json("vtigerReadiness").notNull(),
  maintenanceWindow: varchar("maintenanceWindow", { length: 255 }),
  releaseOwner: varchar("releaseOwner", { length: 255 }),
  currentDocumentManifest: json("currentDocumentManifest").notNull(),
  includedFamilyCount: int("includedFamilyCount").default(0).notNull(),
  heldFamilyCount: int("heldFamilyCount").default(0).notNull(),
  excludedFamilyCount: int("excludedFamilyCount").default(0).notNull(),
  preparedBy: int("preparedBy").notNull(),
  preparedAt: timestamp("preparedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialReleaseManifestReleaseUnique: uniqueIndex("financial_release_manifest_release_unique").on(table.releaseId),
}));

export type FinancialReleaseManifest = typeof financialReleaseManifests.$inferSelect;
export type InsertFinancialReleaseManifest = typeof financialReleaseManifests.$inferInsert;

export const financialReleaseFamilies = mysqlTable("financial_release_families", {
  id: int("id").autoincrement().primaryKey(),
  manifestId: int("manifestId").notNull(),
  familyKey: varchar("familyKey", { length: 96 }).notNull(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  displayName: varchar("displayName", { length: 255 }).notNull(),
  branch: varchar("branch", { length: 160 }).notNull(),
  releaseStatus: mysqlEnum("releaseStatus", ["included", "held", "excluded"] as const).default("excluded").notNull(),
  statusReason: text("statusReason").notNull(),
  expectedReferencePattern: varchar("expectedReferencePattern", { length: 255 }).notNull(),
  partyAndAccountRules: json("partyAndAccountRules").notNull(),
  calculationRules: json("calculationRules").notNull(),
  draftOnlyRestriction: text("draftOnlyRestriction").notNull(),
  firstExpectedTrigger: varchar("firstExpectedTrigger", { length: 500 }).notNull(),
  apEndpointIdentifier: varchar("apEndpointIdentifier", { length: 500 }).notNull(),
  apAuthentication: varchar("apAuthentication", { length: 500 }).notNull(),
  apScheduleDefinition: varchar("apScheduleDefinition", { length: 500 }),
  shadowTestId: int("shadowTestId"),
  candidateRosterEntryId: int("candidateRosterEntryId"),
  sourceRecordNumber: varchar("sourceRecordNumber", { length: 128 }),
  sourcePreflightAt: timestamp("sourcePreflightAt"),
  xeroPreflight: json("xeroPreflight"),
  currentDocumentSummary: json("currentDocumentSummary"),
  legacyWriterIdentifier: varchar("legacyWriterIdentifier", { length: 500 }),
  legacyWriterOwner: varchar("legacyWriterOwner", { length: 255 }),
  legacyDisableAction: text("legacyDisableAction"),
  conditionPayloadContract: text("conditionPayloadContract").notNull(),
  rollbackPlan: text("rollbackPlan").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialReleaseFamilyUnique: uniqueIndex("financial_release_family_unique").on(table.manifestId, table.familyKey),
}));

export type FinancialReleaseFamily = typeof financialReleaseFamilies.$inferSelect;
export type InsertFinancialReleaseFamily = typeof financialReleaseFamilies.$inferInsert;

/** Append-only audit for manifest preparation and non-secret legacy inventory updates. */
export const financialReleaseAudits = mysqlTable("financial_release_audits", {
  id: int("id").autoincrement().primaryKey(),
  manifestId: int("manifestId").notNull(),
  familyId: int("familyId"),
  action: varchar("action", { length: 100 }).notNull(),
  outcome: mysqlEnum("outcome", ["prepared", "updated", "blocked", "exported"] as const).notNull(),
  details: json("details"),
  actorId: int("actorId").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type FinancialReleaseAudit = typeof financialReleaseAudits.$inferSelect;
export type InsertFinancialReleaseAudit = typeof financialReleaseAudits.$inferInsert;

// ─── Guarded Financial Writer Execution Ledger ───────────────────────────────
//
// This ledger is additive and records any future Draft-only writer attempt. The
// writer remains environment-locked and there is intentionally no current route
// or schedule that invokes it. A future approved cutover must create an audit
// trail before and after a Xero request, allowing safe reconciliation of a
// gateway timeout without guessing whether a financial document was created.

export const financialWriterExecutions = mysqlTable("financial_writer_executions", {
  id: int("id").autoincrement().primaryKey(),
  executionKey: varchar("executionKey", { length: 128 }).notNull(),
  workflowRunId: int("workflowRunId"),
  documentIntentId: int("documentIntentId"),
  releaseManifestId: int("releaseManifestId"),
  releaseFamilyId: int("releaseFamilyId"),
  cutoverPackId: int("cutoverPackId"),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  documentFamily: mysqlEnum("documentFamily", ["purchase_order", "customer_invoice"] as const).notNull(),
  proposedAction: mysqlEnum("proposedAction", ["create_draft", "update_draft"] as const).notNull(),
  proposedDocumentNumber: varchar("proposedDocumentNumber", { length: 128 }).notNull(),
  targetXeroDocumentId: varchar("targetXeroDocumentId", { length: 128 }),
  endpoint: varchar("endpoint", { length: 500 }).notNull(),
  method: mysqlEnum("method", ["POST", "PUT"] as const).notNull(),
  idempotencyKey: varchar("idempotencyKey", { length: 128 }).notNull(),
  payloadFingerprint: varchar("payloadFingerprint", { length: 128 }).notNull(),
  status: mysqlEnum("status", ["prepared", "blocked", "submitted", "succeeded", "failed", "reconciliation_required"] as const)
    .default("prepared")
    .notNull(),
  approvalReference: varchar("approvalReference", { length: 255 }),
  safePayloadSummary: json("safePayloadSummary"),
  xeroDocumentId: varchar("xeroDocumentId", { length: 128 }),
  xeroDocumentStatus: varchar("xeroDocumentStatus", { length: 64 }),
  xeroResponseSummary: json("xeroResponseSummary"),
  errorMessage: text("errorMessage"),
  preparedBy: int("preparedBy"),
  submittedAt: timestamp("submittedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialWriterExecutionKeyUnique: uniqueIndex("financial_writer_execution_key_unique").on(table.executionKey),
  financialWriterIdempotencyUnique: uniqueIndex("financial_writer_execution_idempotency_unique").on(table.idempotencyKey),
}));

export type FinancialWriterExecution = typeof financialWriterExecutions.$inferSelect;
export type InsertFinancialWriterExecution = typeof financialWriterExecutions.$inferInsert;

// ─── AP Financial Webhook Interface — Proposal-Only Audit ────────────────────
//
// These events are received by AP Management only. They are deliberately
// separate from VTiger configuration and Xero document tables: an event can
// record a proposal, pause, duplicate or failure outcome, but cannot authorise
// a financial write.

export const financialWebhookEvents = mysqlTable("financial_webhook_events", {
  id: int("id").autoincrement().primaryKey(),
  eventId: varchar("eventId", { length: 160 }).notNull(),
  routeKey: varchar("routeKey", { length: 100 }).notNull(),
  workflowType: varchar("workflowType", { length: 80 }).notNull(),
  sourceSystem: varchar("sourceSystem", { length: 40 }).default("vtiger").notNull(),
  sourceEntityType: varchar("sourceEntityType", { length: 80 }).notNull(),
  sourceRecordId: varchar("sourceRecordId", { length: 128 }).notNull(),
  sourceRecordNumber: varchar("sourceRecordNumber", { length: 128 }),
  sourceChangedAt: timestamp("sourceChangedAt"),
  payloadFingerprint: varchar("payloadFingerprint", { length: 128 }).notNull(),
  status: mysqlEnum("status", ["received", "proposed", "held", "paused", "duplicate", "rejected", "failed"] as const)
    .default("received")
    .notNull(),
  workflowRunId: int("workflowRunId"),
  safeSummary: json("safeSummary"),
  errorMessage: text("errorMessage"),
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  financialWebhookEventUnique: uniqueIndex("financial_webhook_event_unique").on(table.eventId),
}));

export type FinancialWebhookEvent = typeof financialWebhookEvents.$inferSelect;
export type InsertFinancialWebhookEvent = typeof financialWebhookEvents.$inferInsert;
