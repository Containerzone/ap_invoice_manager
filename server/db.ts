import { and, desc, eq, gte, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  ConversationNote,
  EmailLog,
  InsertConversationNote,
  InsertEmailLog,
  InsertInvoice,
  InsertInvoiceLineItem,
  InsertMicrosoftGraphState,
  InsertPendingInvite,
  InsertSupplier,
  InsertUser,
  InsertXeroToken,
  EmailInvoiceSubmission,
  Invoice,
  InvoiceLineItem,
  MicrosoftGraphState,
  PendingInvite,
  Supplier,
  User,
  XeroToken,
  conversationNotes,
  emailLogs,
  emailInvoiceSubmissions,
  invoiceLineItems,
  invoices,
  microsoftGraphStates,
  pendingInvites,
  suppliers,
  users,
  xeroApiCache,
  xeroTokens,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  const textFields = ["name", "email", "loginMethod"] as const;
  textFields.forEach((field) => {
    const value = user[field];
    if (value === undefined) return;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  });
  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getFirstActiveAdmin(): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")))
    .orderBy(users.id)
    .limit(1);
  return result[0];
}

export async function getAllUsers(): Promise<User[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function updateUserRole(userId: number, role: "user" | "admin"): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function updateUserStatus(userId: number, status: "active" | "disabled"): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(users).set({ status }).where(eq(users.id, userId));
}

// ─── Suppliers ────────────────────────────────────────────────────────────────

export async function getAllSuppliers(): Promise<Supplier[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(suppliers).orderBy(suppliers.name);
}

export async function getSupplierById(id: number): Promise<Supplier | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  return result[0];
}

export async function findMatchingSupplier(
  name?: string,
  abn?: string,
  email?: string
): Promise<Supplier | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const conditions = [];
  if (abn) conditions.push(eq(suppliers.abn, abn));
  if (email) conditions.push(eq(suppliers.email, email));
  if (name) conditions.push(like(suppliers.name, `%${name}%`));
  if (conditions.length === 0) return undefined;
  const result = await db
    .select()
    .from(suppliers)
    .where(or(...conditions))
    .limit(1);
  return result[0];
}

export async function createSupplier(data: InsertSupplier): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(suppliers).values(data);
  return (result[0] as any).insertId;
}

export async function updateSupplier(
  id: number,
  data: Partial<InsertSupplier>
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(suppliers).set(data).where(eq(suppliers.id, id));
}

export async function deleteSupplier(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(suppliers).where(eq(suppliers.id, id));
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export async function createInvoice(data: InsertInvoice): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(invoices).values(data);
  return (result[0] as any).insertId;
}

export async function getInvoiceById(id: number): Promise<Invoice | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return result[0];
}

export async function getAllInvoices(filters?: {
  status?: string;
  supplierId?: number;
  search?: string;
  includeArchived?: boolean;
}): Promise<Invoice[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  const isArchivedFilter = filters?.status === "archived";
  if (filters?.status && !isArchivedFilter) conditions.push(eq(invoices.status, filters.status as any));
  if (filters?.supplierId) conditions.push(eq(invoices.supplierId, filters.supplierId));
  if (filters?.search) {
    conditions.push(
      or(
        like(invoices.extractedInvoiceNumber, `%${filters.search}%`),
        like(invoices.extractedSupplierName, `%${filters.search}%`),
        like(invoices.extractedPoNumber, `%${filters.search}%`),
        like(invoices.originalFileName, `%${filters.search}%`)
      )
    );
  }
  if (isArchivedFilter) {
    // Show only archived invoices (archivedAt IS NOT NULL)
    conditions.push(sql`${invoices.archivedAt} IS NOT NULL`);
  } else if (!filters?.includeArchived) {
    // Default: exclude archived invoices
    conditions.push(isNull(invoices.archivedAt));
  }
  const query = db.select().from(invoices).orderBy(desc(invoices.createdAt));
  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
}

// Get archived invoices (for archive view)
export async function getArchivedInvoices(): Promise<Invoice[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(invoices)
    .where(sql`${invoices.archivedAt} IS NOT NULL`)
    .orderBy(desc(invoices.archivedAt));
}

// Delete invoices archived more than N days ago
export async function deleteOldArchivedInvoices(daysOld: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const result = await db.delete(invoices)
    .where(and(
      sql`${invoices.archivedAt} IS NOT NULL`,
      lt(invoices.archivedAt, cutoff)
    ));
  return (result as any)[0]?.affectedRows ?? 0;
}

export async function updateInvoice(id: number, data: Partial<InsertInvoice>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(invoices).set(data).where(eq(invoices.id, id));
}

export async function deleteInvoice(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  // Delete child records first to respect foreign keys
  await db.delete(conversationNotes).where(eq(conversationNotes.invoiceId, id));
  await db.delete(emailLogs).where(eq(emailLogs.invoiceId, id));
  await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, id));
  await db.delete(invoices).where(eq(invoices.id, id));
}

export async function getDashboardMetrics() {
  const db = await getDb();
  if (!db) return { total: 0, flagged: 0, openQueries: 0, resolvedThisMonth: 0 };

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalResult, flaggedResult, queriedResult, resolvedResult] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(invoices),
    db
      .select({ count: sql<number>`count(*)` })
      .from(invoices)
      .where(eq(invoices.status, "flagged")),
    db
      .select({ count: sql<number>`count(*)` })
      .from(invoices)
      .where(inArray(invoices.status, ["queried", "queried_2nd", "queried_3rd"])),
    db
      .select({ count: sql<number>`count(*)` })
      .from(invoices)
      .where(and(eq(invoices.status, "resolved"), gte(invoices.resolvedAt, startOfMonth))),
  ]);

  return {
    total: Number(totalResult[0]?.count ?? 0),
    flagged: Number(flaggedResult[0]?.count ?? 0),
    openQueries: Number(queriedResult[0]?.count ?? 0),
    resolvedThisMonth: Number(resolvedResult[0]?.count ?? 0),
  };
}

// ─── Invoice Line Items ───────────────────────────────────────────────────────

export async function createLineItems(items: InsertInvoiceLineItem[]): Promise<void> {
  const db = await getDb();
  if (!db || items.length === 0) return;
  await db.insert(invoiceLineItems).values(items);
}

export async function getLineItemsByInvoice(invoiceId: number): Promise<InvoiceLineItem[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));
}

export async function updateLineItem(
  id: number,
  data: Partial<Pick<InvoiceLineItem, "description" | "quantity" | "unitPrice" | "amount" | "taxRate" | "poNumber" | "poNumberEdited" | "custRef">>
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(invoiceLineItems).set(data).where(eq(invoiceLineItems.id, id));
}

export async function deleteLineItemsByInvoice(invoiceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));
}

// ─── Email Logs ───────────────────────────────────────────────────────────────

export async function createEmailLog(data: InsertEmailLog): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(emailLogs).values(data);
  return (result[0] as any).insertId;
}

export async function getEmailLogsByInvoice(invoiceId: number): Promise<EmailLog[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(emailLogs)
    .where(eq(emailLogs.invoiceId, invoiceId))
    .orderBy(desc(emailLogs.createdAt));
}

export async function updateEmailLogStatus(
  id: number,
  status: "sent" | "failed",
  errorMessage?: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(emailLogs)
    .set({ status, errorMessage: errorMessage ?? null, sentAt: status === "sent" ? new Date() : null })
    .where(eq(emailLogs.id, id));
}

export async function logEmailReply(
  emailLogId: number,
  replyBody: string,
  repliedBy: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(emailLogs)
    .set({ replyBody, repliedAt: new Date(), repliedBy })
    .where(eq(emailLogs.id, emailLogId));
}

// ─── Conversation Notes ───────────────────────────────────────────────────────

export async function createConversationNote(data: InsertConversationNote): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(conversationNotes).values(data);
  return (result[0] as any).insertId;
}

export async function getNotesByInvoice(invoiceId: number): Promise<ConversationNote[]> {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(conversationNotes)
    .where(eq(conversationNotes.invoiceId, invoiceId))
    .orderBy(conversationNotes.createdAt);
}

// ─── Xero Tokens ─────────────────────────────────────────────────────────────

export async function getXeroToken(): Promise<XeroToken | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(xeroTokens).orderBy(desc(xeroTokens.updatedAt)).limit(1);
  return result[0];
}

export async function upsertXeroToken(data: InsertXeroToken): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const existing = await db
    .select()
    .from(xeroTokens)
    .where(eq(xeroTokens.tenantId, data.tenantId))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(xeroTokens)
      .set({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt,
        scope: data.scope,
        tenantName: data.tenantName,
      })
      .where(eq(xeroTokens.tenantId, data.tenantId));
  } else {
    await db.insert(xeroTokens).values(data);
  }
}

export async function updateXeroRateLimitState(
  tenantId: string,
  state: {
    rateLimitPausedUntil?: Date | null;
    rateLimitProblem?: string | null;
    rateLimitRetryAfterSeconds?: number | null;
    rateLimitMinuteRemaining?: number | null;
    rateLimitDayRemaining?: number | null;
    rateLimitUpdatedAt?: Date | null;
  }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(xeroTokens).set(state).where(eq(xeroTokens.tenantId, tenantId));
}

export async function getXeroApiCache<T>(tenantId: string, cacheKey: string): Promise<T | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ responseData: xeroApiCache.responseData })
    .from(xeroApiCache)
    .where(and(
      eq(xeroApiCache.tenantId, tenantId),
      eq(xeroApiCache.cacheKey, cacheKey),
      gte(xeroApiCache.expiresAt, new Date()),
    ))
    .limit(1);
  return (rows[0]?.responseData as T | undefined) ?? null;
}

export async function setXeroApiCache<T>(
  tenantId: string,
  cacheKey: string,
  responseData: T,
  ttlMs: number,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(xeroApiCache).values({
    tenantId,
    cacheKey,
    responseData: responseData as any,
    expiresAt,
  }).onDuplicateKeyUpdate({
    set: { responseData: responseData as any, expiresAt, updatedAt: new Date() },
  });
}

export async function invalidateXeroApiCache(tenantId: string, cacheKeyPrefix?: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  if (cacheKeyPrefix) {
    await db.delete(xeroApiCache).where(and(
      eq(xeroApiCache.tenantId, tenantId),
      like(xeroApiCache.cacheKey, `${cacheKeyPrefix}%`),
    ));
    return;
  }
  await db.delete(xeroApiCache).where(eq(xeroApiCache.tenantId, tenantId));
}

export async function deleteExpiredXeroApiCache(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(xeroApiCache).where(lt(xeroApiCache.expiresAt, new Date()));
}

export async function deleteXeroToken(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(xeroTokens);
}

// ─── Microsoft 365 Graph Inbound Invoice Processing ──────────────────────────

export async function getMicrosoftGraphState(mailbox: string): Promise<MicrosoftGraphState | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(microsoftGraphStates)
    .where(eq(microsoftGraphStates.mailbox, mailbox.toLowerCase()))
    .limit(1);
  return rows[0];
}

export async function getMicrosoftGraphStateByScheduleTaskUid(taskUid: string): Promise<MicrosoftGraphState | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(microsoftGraphStates)
    .where(eq(microsoftGraphStates.scheduleCronTaskUid, taskUid))
    .limit(1);
  return rows[0];
}

export async function upsertMicrosoftGraphState(data: InsertMicrosoftGraphState): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  await db.insert(microsoftGraphStates).values({
    ...data,
    mailbox: data.mailbox.toLowerCase(),
    invoiceAlias: data.invoiceAlias.toLowerCase(),
  }).onDuplicateKeyUpdate({
    set: {
      invoiceAlias: data.invoiceAlias.toLowerCase(),
      subscriptionId: data.subscriptionId,
      subscriptionExpiresAt: data.subscriptionExpiresAt,
      scheduleCronTaskUid: data.scheduleCronTaskUid,
      lastSubscriptionError: data.lastSubscriptionError,
      lastNotificationAt: data.lastNotificationAt,
      lastRenewedAt: data.lastRenewedAt,
      updatedAt: new Date(),
    },
  });
}

export async function updateMicrosoftGraphState(
  mailbox: string,
  data: Partial<InsertMicrosoftGraphState>
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(microsoftGraphStates)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(microsoftGraphStates.mailbox, mailbox.toLowerCase()));
}

export async function getEmailInvoiceSubmission(
  graphMessageId: string,
  graphAttachmentId: string
): Promise<EmailInvoiceSubmission | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(emailInvoiceSubmissions)
    .where(and(
      eq(emailInvoiceSubmissions.graphMessageId, graphMessageId),
      eq(emailInvoiceSubmissions.graphAttachmentId, graphAttachmentId),
    ))
    .limit(1);
  return rows[0];
}

export async function createEmailInvoiceSubmission(
  data: Omit<import("../drizzle/schema").InsertEmailInvoiceSubmission, "id" | "createdAt" | "updatedAt">
): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(emailInvoiceSubmissions).values(data);
  return (result[0] as any).insertId;
}

export async function updateEmailInvoiceSubmission(
  id: number,
  data: Partial<import("../drizzle/schema").InsertEmailInvoiceSubmission>
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(emailInvoiceSubmissions).set(data).where(eq(emailInvoiceSubmissions.id, id));
}

export async function getRecentEmailInvoiceSubmissions(limit = 50): Promise<EmailInvoiceSubmission[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(emailInvoiceSubmissions)
    .orderBy(desc(emailInvoiceSubmissions.createdAt))
    .limit(limit);
}

export async function getPendingEmailInvoiceSubmissions(limit = 10): Promise<EmailInvoiceSubmission[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(emailInvoiceSubmissions)
    .where(eq(emailInvoiceSubmissions.status, "received"))
    .orderBy(emailInvoiceSubmissions.createdAt)
    .limit(limit);
}

// ─── Reports ──────────────────────────────────────────────────────────────────

export interface PoVarianceRow {
  invoiceId: number;
  invoiceNumber: string | null;
  supplierName: string | null;
  invoiceDate: string | null;
  status: string | null;
  extractedTotal: string | null;
  xeroTotal: string | null;
  totalNetDiff: string | null;
  xeroPoResults: unknown;
  originalPoAmounts: unknown;
  staffApproved: boolean | null;
  adminApproved: boolean | null;
  staffApprovedAt: Date | null;
  adminApprovedAt: Date | null;
}

/**
 * Returns all approved/resolved invoices with their PO variance data.
 * Used by the Reports portal to show the net over/under position per invoice.
 */
export async function getPoVarianceReport(): Promise<PoVarianceRow[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.extractedInvoiceNumber,
      supplierName: invoices.extractedSupplierName,
      invoiceDate: invoices.extractedInvoiceDate,
      status: invoices.status,
      extractedTotal: invoices.extractedTotal,
      xeroTotal: invoices.xeroTotal,
      totalNetDiff: invoices.totalNetDiff,
      xeroPoResults: invoices.xeroPoResults,
      originalPoAmounts: invoices.originalPoAmounts,
      staffApproved: invoices.staffApproved,
      adminApproved: invoices.adminApproved,
      staffApprovedAt: invoices.staffApprovedAt,
      adminApprovedAt: invoices.adminApprovedAt,
    })
    .from(invoices);
  // Filter in JS to avoid complex SQL — dataset is small
  return rows.filter((r) =>
    ["approved", "resolved", "under_budget", "verified"].includes(r.status ?? "")
  );
}

/**
 * Finds an existing invoice with the same supplier name AND invoice number.
 * Used to detect duplicate uploads. Excludes the given invoiceId (so a re-extract
 * on the same invoice doesn't flag itself).
 */
export async function findDuplicateInvoice(
  supplierName: string,
  invoiceNumber: string,
  excludeInvoiceId?: number
): Promise<{ id: number; status: string; supplierName: string | null; invoiceNumber: string | null } | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const conditions = [
    eq(invoices.extractedSupplierName, supplierName),
    eq(invoices.extractedInvoiceNumber, invoiceNumber),
  ];
  if (excludeInvoiceId !== undefined) {
    conditions.push(sql`${invoices.id} != ${excludeInvoiceId}`);
  }
  const rows = await db
    .select({
      id: invoices.id,
      status: invoices.status,
      supplierName: invoices.extractedSupplierName,
      invoiceNumber: invoices.extractedInvoiceNumber,
    })
    .from(invoices)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}

/**
 * Finds invoices that have been approved and whose extractedPoNumbers JSON array
 * contains any of the given PO numbers. Used to detect PO-already-matched conflicts.
 * Excludes the given invoiceId.
 */
export async function findInvoicesMatchingPoNumbers(
  poNumbers: string[],
  excludeInvoiceId: number
): Promise<Array<{ id: number; invoiceNumber: string | null; supplierName: string | null; status: string | null }>> {
  const db = await getDb();
  if (!db) return [];
  // Fetch all approved/resolved invoices except the current one
  const rows = await db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.extractedInvoiceNumber,
      supplierName: invoices.extractedSupplierName,
      status: invoices.status,
      extractedPoNumbers: invoices.extractedPoNumbers,
      staffApproved: invoices.staffApproved,
      adminApproved: invoices.adminApproved,
    })
    .from(invoices)
    .where(
      and(
        sql`${invoices.id} != ${excludeInvoiceId}`,
        or(
          eq(invoices.staffApproved, true),
          eq(invoices.adminApproved, true)
        )
      )
    );
  // Filter in JS: check if any PO number overlaps
  const poSet = new Set(poNumbers.map((p) => p.trim().toUpperCase()));
  return rows
    .filter((r) => {
      const stored = (r as any).extractedPoNumbers as string[] | null;
      if (!stored || stored.length === 0) return false;
      return stored.some((p: string) => poSet.has(p.trim().toUpperCase()));
    })
    .map((r) => ({
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      supplierName: r.supplierName,
      status: r.status,
    }));
}

// ─── Pending Invites ─────────────────────────────────────────────────────────

export async function getAllPendingInvites(): Promise<PendingInvite[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(pendingInvites).orderBy(desc(pendingInvites.createdAt));
}

export async function createPendingInvite(data: InsertPendingInvite): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const result = await db.insert(pendingInvites).values(data);
  return (result[0] as any).insertId;
}

export async function deletePendingInvite(id: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(pendingInvites).where(eq(pendingInvites.id, id));
}

export async function findPendingInviteByEmail(email: string): Promise<PendingInvite | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(pendingInvites)
    .where(eq(pendingInvites.email, email.toLowerCase().trim()))
    .limit(1);
  return result[0];
}

export async function claimPendingInvite(email: string, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(pendingInvites)
    .set({ claimedAt: new Date(), claimedBy: userId })
    .where(eq(pendingInvites.email, email.toLowerCase().trim()));
}

export async function countActiveInvites(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(pendingInvites)
    .where(isNull(pendingInvites.claimedAt));
  return Number(result[0]?.count ?? 0);
}
