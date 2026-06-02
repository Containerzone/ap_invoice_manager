import { and, desc, eq, gte, isNull, like, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  ConversationNote,
  EmailLog,
  InsertConversationNote,
  InsertEmailLog,
  InsertInvoice,
  InsertInvoiceLineItem,
  InsertSupplier,
  InsertUser,
  InsertXeroToken,
  Invoice,
  InvoiceLineItem,
  Supplier,
  User,
  XeroToken,
  conversationNotes,
  emailLogs,
  invoiceLineItems,
  invoices,
  suppliers,
  users,
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
}): Promise<Invoice[]> {
  const db = await getDb();
  if (!db) return [];
  const conditions = [];
  if (filters?.status) conditions.push(eq(invoices.status, filters.status as any));
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
  const query = db.select().from(invoices).orderBy(desc(invoices.createdAt));
  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }
  return query;
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
      .where(eq(invoices.status, "queried")),
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

export async function deleteXeroToken(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(xeroTokens);
}
