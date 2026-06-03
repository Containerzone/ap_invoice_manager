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
} from "drizzle-orm/mysql-core";

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
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
    "flagged",
    "queried",
    "queried_2nd",
    "queried_3rd",
    "resolved",
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

  // Query points (numbered list of dispute reasons)
  queryPoints: json("queryPoints"), // string[]

  // Resolution
  resolvedAt: timestamp("resolvedAt"),
  resolvedBy: int("resolvedBy"),
  resolutionNotes: text("resolutionNotes"),
  xeroFinalBillId: varchar("xeroFinalBillId", { length: 64 }),
  xeroFinalBillNumber: varchar("xeroFinalBillNumber", { length: 100 }),

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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type XeroToken = typeof xeroTokens.$inferSelect;
export type InsertXeroToken = typeof xeroTokens.$inferInsert;
