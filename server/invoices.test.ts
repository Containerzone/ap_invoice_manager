import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock all db helpers
vi.mock("./db", () => ({
  getAllUsers: vi.fn().mockResolvedValue([]),
  updateUserRole: vi.fn().mockResolvedValue(undefined),
  getAllSuppliers: vi.fn().mockResolvedValue([]),
  getSupplierById: vi.fn().mockResolvedValue(undefined),
  findMatchingSupplier: vi.fn().mockResolvedValue(null),
  createSupplier: vi.fn().mockResolvedValue(1),
  updateSupplier: vi.fn().mockResolvedValue(undefined),
  deleteSupplier: vi.fn().mockResolvedValue(undefined),
  getAllInvoices: vi.fn().mockResolvedValue([]),
  getInvoiceById: vi.fn().mockResolvedValue(undefined),
  createInvoice: vi.fn().mockResolvedValue(1),
  updateInvoice: vi.fn().mockResolvedValue(undefined),
  createLineItems: vi.fn().mockResolvedValue(undefined),
  getLineItemsByInvoice: vi.fn().mockResolvedValue([]),
  deleteLineItemsByInvoice: vi.fn().mockResolvedValue(undefined),
  createConversationNote: vi.fn().mockResolvedValue(1),
  getNotesByInvoice: vi.fn().mockResolvedValue([]),
  createEmailLog: vi.fn().mockResolvedValue(1),
  getEmailLogsByInvoice: vi.fn().mockResolvedValue([]),
  updateEmailLogStatus: vi.fn().mockResolvedValue(undefined),
  getDashboardMetrics: vi.fn().mockResolvedValue({
    total: 0, flagged: 0, openQueries: 0, resolvedThisMonth: 0,
  }),
  getXeroToken: vi.fn().mockResolvedValue(null),
  upsertXeroToken: vi.fn().mockResolvedValue(undefined),
  deleteXeroToken: vi.fn().mockResolvedValue(undefined),
  upsertUser: vi.fn().mockResolvedValue(undefined),
  getUserByOpenId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./storage", () => ({
  storagePut: vi.fn().mockResolvedValue({ key: "test-key", url: "/manus-storage/test-key" }),
}));

vi.mock("./extractionService", () => ({
  extractInvoiceData: vi.fn().mockResolvedValue({
    invoiceNumber: "INV-001",
    poNumber: "PO-123",
    supplierName: "Test Supplier",
    supplierAbn: "12 345 678 901",
    supplierEmail: "supplier@test.com",
    invoiceDate: "2024-01-15",
    dueDate: "2024-02-15",
    subtotal: 1000,
    tax: 100,
    total: 1100,
    currency: "AUD",
    containerNumbers: ["CONT123456"],
    lineItems: [{ description: "Freight", quantity: 1, unitPrice: 1000, amount: 1000 }],
  }),
}));

vi.mock("./xeroService", () => ({
  getXeroAuthUrl: vi.fn().mockReturnValue("https://xero.com/oauth"),
  exchangeXeroCode: vi.fn().mockResolvedValue({
    accessToken: "access", refreshToken: "refresh",
    expiresAt: new Date(), scope: "openid",
  }),
  getXeroTenants: vi.fn().mockResolvedValue([{ tenantId: "t1", tenantName: "Test Org" }]),
  findXeroBillByInvoiceNumber: vi.fn().mockResolvedValue(null),
  createXeroDraftBill: vi.fn().mockResolvedValue({ invoiceId: "x1", invoiceNumber: "BILL-001" }),
  findOrCreateXeroContact: vi.fn().mockResolvedValue("contact-id"),
  refreshXeroTokenIfNeeded: vi.fn().mockResolvedValue("fresh-token"),
}));

vi.mock("./emailService", () => ({
  sendDisputeEmail: vi.fn().mockResolvedValue({ success: true, emailLogId: 1 }),
}));

vi.mock("./_core/llm", () => ({
  invokeLLM: vi.fn().mockResolvedValue({
    choices: [{ message: { content: '{"invoiceNumber":"INV-001","total":1100}' } }],
  }),
}));

function makeAdminCtx(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "admin-open-id",
      name: "Admin User",
      email: "admin@test.com",
      loginMethod: "manus",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

function makeUserCtx(): TrpcContext {
  return {
    ...makeAdminCtx(),
    user: { ...makeAdminCtx().user!, id: 2, role: "user", openId: "user-open-id" },
  };
}

describe("invoices.metrics", () => {
  it("returns dashboard metrics for authenticated users", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.invoices.metrics();
    expect(result).toMatchObject({
      total: expect.any(Number),
      flagged: expect.any(Number),
      openQueries: expect.any(Number),
      resolvedThisMonth: expect.any(Number),
    });
  });
});

describe("invoices.list", () => {
  it("returns empty list when no invoices exist", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.invoices.list({});
    expect(Array.isArray(result)).toBe(true);
  });

  it("accepts optional status filter", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.invoices.list({ status: "flagged" });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("invoices.get", () => {
  it("throws NOT_FOUND for non-existent invoice", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(caller.invoices.get({ id: 99999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("suppliers.list", () => {
  it("returns empty list when no suppliers exist", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.suppliers.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("suppliers.create", () => {
  it("admin can create a supplier with name", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.suppliers.create({ name: "New Supplier" });
    // createSupplier returns the new supplier id (number)
    expect(typeof result === "number" || (result && typeof (result as any).id === "number")).toBe(true);
  });

  it("staff cannot create a supplier (admin only)", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(caller.suppliers.create({ name: "New Supplier" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects empty supplier name even for admin", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    await expect(caller.suppliers.create({ name: "" })).rejects.toThrow();
  });
});

describe("users.list", () => {
  it("allows admin to list users", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.users.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("rejects non-admin access", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(caller.users.list()).rejects.toThrow();
  });
});

describe("users.updateRole", () => {
  it("allows admin to update user role", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    await expect(
      caller.users.updateRole({ userId: 2, role: "admin" })
    ).resolves.not.toThrow();
  });

  it("rejects non-admin role update", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(
      caller.users.updateRole({ userId: 1, role: "user" })
    ).rejects.toThrow();
  });
});

describe("xero.status", () => {
  it("returns disconnected status when no token", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.xero.status();
    expect(result.connected).toBe(false);
    expect(result.tenantName).toBeNull();
  });
});

describe("xero.getAuthUrl", () => {
  it("throws when XERO_CLIENT_ID not set", async () => {
    const caller = appRouter.createCaller(makeAdminCtx());
    await expect(
      caller.xero.getAuthUrl({ redirectUri: "https://example.com/callback" })
    ).rejects.toThrow("XERO_CLIENT_ID not set");
  });
});

describe("auth.me", () => {
  it("returns current user for authenticated session", async () => {
    const ctx = makeUserCtx();
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result?.id).toBe(2);
    expect(result?.role).toBe("user");
  });

  it("returns null for unauthenticated session", async () => {
    const ctx: TrpcContext = {
      user: null,
      req: { protocol: "https", headers: {} } as TrpcContext["req"],
      res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    };
    const caller = appRouter.createCaller(ctx);
    const result = await caller.auth.me();
    expect(result).toBeNull();
  });
});
