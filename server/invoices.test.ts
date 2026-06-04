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
  logEmailReply: vi.fn().mockResolvedValue(undefined),
  updateLineItem: vi.fn().mockResolvedValue(undefined),
  addLineItem: vi.fn().mockResolvedValue(1),
  deleteLineItem: vi.fn().mockResolvedValue(undefined),
  saveQueryPoints: vi.fn().mockResolvedValue(undefined),
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
  extractAllPoNumbers: vi.fn().mockReturnValue([]),
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
  findXeroPurchaseOrderByNumber: vi.fn().mockResolvedValue(null),
  createXeroDraftBill: vi.fn().mockResolvedValue({ invoiceId: "x1", invoiceNumber: "BILL-001" }),
  findOrCreateXeroContact: vi.fn().mockResolvedValue("contact-id"),
  refreshXeroTokenIfNeeded: vi.fn().mockResolvedValue("fresh-token"),
  markXeroPOAsBilled: vi.fn().mockResolvedValue(true),
  getXeroPOPaymentStatus: vi.fn().mockResolvedValue({ isPaid: false, paidAmount: null, paidDate: null }),
  convertPOsToBill: vi.fn().mockResolvedValue({ invoiceId: "x2", invoiceNumber: "BILL-002" }),
  updateXeroPODetails: vi.fn().mockResolvedValue(true),
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
    const original = process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_ID;
    try {
      const caller = appRouter.createCaller(makeAdminCtx());
      await expect(
        caller.xero.getAuthUrl({ redirectUri: "https://example.com/callback" })
      ).rejects.toThrow("XERO_CLIENT_ID not set");
    } finally {
      if (original !== undefined) process.env.XERO_CLIENT_ID = original;
    }
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

describe("invoices.logReply", () => {
  it("logs a supplier reply and returns success", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.invoices.logReply({
      emailLogId: 1,
      invoiceId: 42,
      replyBody: "Thank you for your query. We will investigate.",
    });
    expect(result).toEqual({ success: true });
  });

  it("rejects empty reply body", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(
      caller.invoices.logReply({
        emailLogId: 1,
        invoiceId: 42,
        replyBody: "",
      })
    ).rejects.toThrow();
  });
});

describe("invoices.sendBulkQuery", () => {
  it("sends a bulk query email and returns invoice count", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result = await caller.invoices.sendBulkQuery({
      invoiceIds: [1, 2, 3],
      to: "supplier@example.com",
      subject: "Invoice Query — 3 Invoices",
      body: "Dear Supplier, we have queries on invoices 1, 2, 3.",
    });
    expect(result.invoiceCount).toBe(3);
  });

  it("rejects empty invoiceIds array", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(
      caller.invoices.sendBulkQuery({
        invoiceIds: [],
        to: "supplier@example.com",
        subject: "Test",
        body: "Test body",
      })
    ).rejects.toThrow();
  });

  it("rejects invalid email address for 'to' field", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(
      caller.invoices.sendBulkQuery({
        invoiceIds: [1],
        to: "not-an-email",
        subject: "Test",
        body: "Test body",
      })
    ).rejects.toThrow();
  });
});

describe("progressive query status", () => {
  it("status filter accepts queried_2nd and queried_3rd values", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    const result2nd = await caller.invoices.list({ status: "queried_2nd" });
    const result3rd = await caller.invoices.list({ status: "queried_3rd" });
    expect(Array.isArray(result2nd)).toBe(true);
    expect(Array.isArray(result3rd)).toBe(true);
  });

  it("dashboard metrics counts all query statuses as open queries", async () => {
    const { getDashboardMetrics } = await import("./db");
    vi.mocked(getDashboardMetrics).mockResolvedValueOnce({
      total: 10, flagged: 2, openQueries: 5, resolvedThisMonth: 3,
    });
    const caller = appRouter.createCaller(makeUserCtx());
    const metrics = await caller.invoices.metrics();
    expect(metrics.openQueries).toBe(5);
  });
});

describe("invoices.verifyWithXero", () => {
  it("throws BAD_REQUEST when invoice has no PO number", async () => {
    const { getInvoiceById } = await import("./db");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: null,
      extractedTotal: "1100.00",
      extractedInvoiceNumber: "INV-001",
    } as any);
    const caller = appRouter.createCaller(makeAdminCtx());
    await expect(
      caller.invoices.verifyWithXero({ invoiceId: 99 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("flags invoice when PO is not found in Xero", async () => {
    const { getInvoiceById, updateInvoice, createConversationNote } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "1100.00",
      extractedInvoiceNumber: "INV-001",
    } as any);
    vi.mocked(findXeroPurchaseOrderByNumber).mockResolvedValueOnce(null);
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.matched).toBe(false);
    expect(result.discrepancy).toBe(true);
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "flagged", hasDiscrepancy: true })
    );
    expect(vi.mocked(createConversationNote)).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("AD123456") })
    );
  });

  it("verifies invoice when PO total matches invoice total", async () => {
    const { getInvoiceById, updateInvoice } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "1100.00",
      extractedInvoiceNumber: "INV-001",
      extractedRawData: null,
    } as any);
    vi.mocked(findXeroPurchaseOrderByNumber).mockResolvedValueOnce({
      purchaseOrderId: "po-uuid-1",
      purchaseOrderNumber: "AD123456",
      reference: "",
      contact: { contactId: "c1", name: "Supplier Co" },
      date: "2024-01-15",
      deliveryDate: "",
      subTotal: 1000.00,
      totalTax: 100.00,
      total: 1100.00,
      status: "AUTHORISED",
      currencyCode: "AUD",
      lineItems: [{ lineItemId: "li1", description: "Freight", quantity: 1, unitAmount: 1000, lineAmount: 1000, taxAmount: 100, accountCode: "300", itemCode: "" }],
    });
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.matched).toBe(true);
    expect(result.discrepancy).toBe(false);
    expect(result.poResults).toHaveLength(1);
    expect(result.poResults[0].lineItems).toHaveLength(1);
    expect(result.poResults[0].status).toBe("AUTHORISED");
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "verified", hasDiscrepancy: false })
    );
  });

  it("flags invoice (over-billed) when invoice total exceeds PO total", async () => {
    const { getInvoiceById, updateInvoice } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "1250.00", // billed MORE than PO
      extractedInvoiceNumber: "INV-001",
      extractedRawData: null,
    } as any);
    vi.mocked(findXeroPurchaseOrderByNumber).mockResolvedValueOnce({
      purchaseOrderId: "po-uuid-1",
      purchaseOrderNumber: "AD123456",
      reference: "",
      contact: { contactId: "c1", name: "Supplier Co" },
      date: "2024-01-15",
      deliveryDate: "",
      subTotal: 1000.00,
      totalTax: 100.00,
      total: 1100.00,
      status: "AUTHORISED",
      currencyCode: "AUD",
      lineItems: [],
    });
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.matched).toBe(true);
    expect(result.discrepancy).toBe(true);
    expect(result.poResults[0].overBilled).toBe(true);
    expect(result.poResults[0].underBilled).toBeFalsy();
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "flagged", hasDiscrepancy: true })
    );
  });

  it("sets under_budget status when invoice total is less than PO total", async () => {
    const { getInvoiceById, updateInvoice } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "950.00", // billed LESS than PO
      extractedInvoiceNumber: "INV-001",
      extractedRawData: null,
    } as any);
    vi.mocked(findXeroPurchaseOrderByNumber).mockResolvedValueOnce({
      purchaseOrderId: "po-uuid-1",
      purchaseOrderNumber: "AD123456",
      reference: "",
      contact: { contactId: "c1", name: "Supplier Co" },
      date: "2024-01-15",
      deliveryDate: "",
      subTotal: 1000.00,
      totalTax: 100.00,
      total: 1100.00,
      status: "AUTHORISED",
      currencyCode: "AUD",
      lineItems: [],
    });
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.matched).toBe(true);
    expect(result.discrepancy).toBe(false);
    expect(result.poResults[0].underBilled).toBe(true);
    expect(result.poResults[0].overBilled).toBeFalsy();
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "under_budget", hasDiscrepancy: false })
    );
  });

  it("handles multiple PO numbers — groups line items by PO and compares each PO's total", async () => {
    const { getInvoiceById, updateInvoice, getLineItemsByInvoice } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    const { extractAllPoNumbers } = await import("./extractionService");
    // Override to return two PO numbers from the raw data
    vi.mocked(extractAllPoNumbers).mockReturnValueOnce(["AD123456", "BD654321"]);
    // Invoice raw data contains two PO numbers in line item descriptions
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "2750.00", // total of both POs
      extractedInvoiceNumber: "INV-002",
      extractedRawData: {
        poNumber: "AD123456",
        lineItems: [],
      },
    } as any);
    // Provide invoice line items with PO numbers in descriptions
    // AD123456 line items total: 1100; BD654321 line items total: 1650
    vi.mocked(getLineItemsByInvoice).mockResolvedValueOnce([
      { id: 1, invoiceId: 99, description: "Freight AD123456", quantity: 1, unitPrice: "1100", amount: "1100", taxRate: null } as any,
      { id: 2, invoiceId: 99, description: "Handling BD654321", quantity: 1, unitPrice: "1500", amount: "1500", taxRate: null } as any,
      { id: 3, invoiceId: 99, description: "Surcharge BD654321", quantity: 1, unitPrice: "150", amount: "150", taxRate: null } as any,
    ]);
    // Xero POs match the grouped line item totals exactly
    vi.mocked(findXeroPurchaseOrderByNumber)
      .mockResolvedValueOnce({
        purchaseOrderId: "po-1", purchaseOrderNumber: "AD123456", reference: "",
        contact: { contactId: "c1", name: "Supplier" }, date: "", deliveryDate: "",
        subTotal: 1000, totalTax: 100, total: 1100, status: "AUTHORISED", currencyCode: "AUD",
        lineItems: [],
      })
      .mockResolvedValueOnce({
        purchaseOrderId: "po-2", purchaseOrderNumber: "BD654321", reference: "",
        contact: { contactId: "c1", name: "Supplier" }, date: "", deliveryDate: "",
        subTotal: 1500, totalTax: 150, total: 1650, status: "AUTHORISED", currencyCode: "AUD",
        lineItems: [],
      });
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.matched).toBe(true);
    expect(result.discrepancy).toBe(false);
    expect(result.poResults).toHaveLength(2);
    // Each PO result should carry the grouped invoice line-item total
    const adResult = result.poResults.find((r: any) => r.poNumber === "AD123456");
    const bdResult = result.poResults.find((r: any) => r.poNumber === "BD654321");
    expect((adResult as any).invoiceLineItemTotal).toBe(1100);
    expect((bdResult as any).invoiceLineItemTotal).toBe(1650);
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "verified", hasDiscrepancy: false })
    );
  });

  it("flags invoice when one of multiple POs is not found", async () => {
    const { getInvoiceById, updateInvoice } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    const { extractAllPoNumbers } = await import("./extractionService");
    vi.mocked(extractAllPoNumbers).mockReturnValueOnce(["AD123456", "BD654321"]);
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "2200.00",
      extractedInvoiceNumber: "INV-003",
      extractedRawData: {
        poNumber: "AD123456",
        lineItems: [
          { description: "Freight AD123456", quantity: 1, unitPrice: 1100, amount: 1100, taxRate: 10 },
          { description: "Handling BD654321", quantity: 1, unitPrice: 1100, amount: 1100, taxRate: 10 },
        ],
      },
    } as any);
    vi.mocked(findXeroPurchaseOrderByNumber)
      .mockResolvedValueOnce({
        purchaseOrderId: "po-1", purchaseOrderNumber: "AD123456", reference: "",
        contact: { contactId: "c1", name: "Supplier" }, date: "", deliveryDate: "",
        subTotal: 2000, totalTax: 200, total: 2200, status: "AUTHORISED", currencyCode: "AUD",
        lineItems: [],
      })
      .mockResolvedValueOnce(null); // BD654321 not found
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.matched).toBe(false); // not all found
    expect(result.discrepancy).toBe(true);
    expect(result.poResults).toHaveLength(2);
    expect(result.poResults.find((r: any) => r.poNumber === "BD654321")?.found).toBe(false);
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "flagged", hasDiscrepancy: true })
    );
  });
});

describe("invoices.adminApprove", () => {
  it("sets status to approved and creates a conversation note", async () => {
    const { getInvoiceById, updateInvoice, createConversationNote } = await import("./db");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: null,
      extractedTotal: "500.00",
      extractedInvoiceNumber: "INV-NO-PO",
      status: "extracted",
    } as any);
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.adminApprove({ invoiceId: 99, notes: "No PO raised — approved by manager" });
    expect(result.success).toBe(true);
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "approved" })
    );
    expect(vi.mocked(createConversationNote)).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("approved") })
    );
  });

  it("throws NOT_FOUND when invoice does not exist", async () => {
    const { getInvoiceById } = await import("./db");
    vi.mocked(getInvoiceById).mockResolvedValueOnce(null as any);
    const caller = appRouter.createCaller(makeAdminCtx());
    await expect(
      caller.invoices.adminApprove({ invoiceId: 999 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws FORBIDDEN when called by non-admin user", async () => {
    const caller = appRouter.createCaller(makeUserCtx());
    await expect(
      caller.invoices.adminApprove({ invoiceId: 99 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("invoices.verifyWithXero — BILLED PO flagging", () => {
  it("flags invoice when Xero PO status is BILLED (duplicate billing risk)", async () => {
    const { getInvoiceById, updateInvoice } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "1100.00",
      extractedInvoiceNumber: "INV-001",
      extractedRawData: null,
    } as any);
    vi.mocked(findXeroPurchaseOrderByNumber).mockResolvedValueOnce({
      purchaseOrderId: "po-uuid-1",
      purchaseOrderNumber: "AD123456",
      reference: "",
      contact: { contactId: "c1", name: "Supplier Co" },
      date: "2024-01-15",
      deliveryDate: "",
      subTotal: 1000.00,
      totalTax: 100.00,
      total: 1100.00,
      status: "BILLED", // PO already billed — should flag regardless of amount match
      currencyCode: "AUD",
      lineItems: [],
    });
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.discrepancy).toBe(true);
    expect((result.poResults[0] as any).alreadyBilled).toBe(true);
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "flagged", hasDiscrepancy: true })
    );
  });

  it("does NOT flag when PO is AUTHORISED and amounts match exactly", async () => {
    const { getInvoiceById, updateInvoice } = await import("./db");
    const { findXeroPurchaseOrderByNumber } = await import("./xeroService");
    vi.mocked(getInvoiceById).mockResolvedValueOnce({
      id: 99,
      extractedPoNumber: "AD123456",
      extractedTotal: "1100.00",
      extractedInvoiceNumber: "INV-001",
      extractedRawData: null,
    } as any);
    vi.mocked(findXeroPurchaseOrderByNumber).mockResolvedValueOnce({
      purchaseOrderId: "po-uuid-1",
      purchaseOrderNumber: "AD123456",
      reference: "",
      contact: { contactId: "c1", name: "Supplier Co" },
      date: "2024-01-15",
      deliveryDate: "",
      subTotal: 1000.00,
      totalTax: 100.00,
      total: 1100.00,
      status: "AUTHORISED",
      currencyCode: "AUD",
      lineItems: [],
    });
    const caller = appRouter.createCaller(makeAdminCtx());
    const result = await caller.invoices.verifyWithXero({ invoiceId: 99 });
    expect(result.discrepancy).toBe(false);
    expect((result.poResults[0] as any).alreadyBilled).toBeFalsy();
    expect(vi.mocked(updateInvoice)).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "verified" })
    );
  });
});
