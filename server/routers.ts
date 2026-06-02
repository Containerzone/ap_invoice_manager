import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import {
  getAllUsers,
  updateUserRole,
  getAllSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  findMatchingSupplier,
  createInvoice,
  getInvoiceById,
  getAllInvoices,
  updateInvoice,
  deleteInvoice,
  getDashboardMetrics,
  createLineItems,
  getLineItemsByInvoice,
  updateLineItem,
  deleteLineItemsByInvoice,
  getEmailLogsByInvoice,
  createConversationNote,
  getNotesByInvoice,
  getXeroToken,
  upsertXeroToken,
  deleteXeroToken,
} from "./db";
import { storagePut } from "./storage";
import { extractInvoiceData } from "./extractionService";
import {
  getXeroAuthUrl,
  exchangeXeroCode,
  getXeroTenants,
  findXeroBillByInvoiceNumber,
  createXeroDraftBill,
  findOrCreateXeroContact,
} from "./xeroService";
import { sendDisputeEmail, generateDisputeEmailTemplate } from "./emailService";
import { ENV } from "./_core/env";

// ─── Admin guard ──────────────────────────────────────────────────────────────

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// ─── App Router ───────────────────────────────────────────────────────────────

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ─── Users ──────────────────────────────────────────────────────────────────

  users: router({
    list: adminProcedure.query(() => getAllUsers()),
    updateRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(({ input }) => updateUserRole(input.userId, input.role)),
  }),

  // ─── Suppliers ──────────────────────────────────────────────────────────────

  suppliers: router({
    list: protectedProcedure.query(() => getAllSuppliers()),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(({ input }) =>
      getSupplierById(input.id)
    ),
    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(1),
          abn: z.string().optional().nullable(),
          email: z.string().optional().nullable(),
          phone: z.string().optional().nullable(),
          address: z.string().optional().nullable(),
          contactName: z.string().optional().nullable(),
          notes: z.string().optional().nullable(),
        })
      )
      .mutation(({ input, ctx }) =>
        createSupplier({ ...input, createdBy: ctx.user.id })
      ),
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().min(1).optional(),
          abn: z.string().optional().nullable(),
          email: z.string().optional().nullable(),
          phone: z.string().optional().nullable(),
          address: z.string().optional().nullable(),
          contactName: z.string().optional().nullable(),
          notes: z.string().optional().nullable(),
        })
      )
      .mutation(({ input }) => {
        const { id, ...data } = input;
        return updateSupplier(id, data);
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => deleteSupplier(input.id)),
  }),

  // ─── Invoices ────────────────────────────────────────────────────────────────

  invoices: router({
    list: protectedProcedure
      .input(
        z.object({
          status: z.string().optional(),
          supplierId: z.number().optional(),
          search: z.string().optional(),
        }).optional()
      )
      .query(({ input }) => getAllInvoices(input)),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const invoice = await getInvoiceById(input.id);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
        const lineItems = await getLineItemsByInvoice(input.id);
        const notes = await getNotesByInvoice(input.id);
        const emails = await getEmailLogsByInvoice(input.id);
        const supplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;
        return { invoice, lineItems, notes, emails, supplier };
      }),

    // Upload PDF and trigger extraction
    upload: protectedProcedure
      .input(
        z.object({
          fileName: z.string(),
          fileBase64: z.string(),
          mimeType: z.string().default("application/pdf"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Decode base64 and upload to S3
        const buffer = Buffer.from(input.fileBase64, "base64");
        const fileKey = `invoices/${Date.now()}-${input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const { url } = await storagePut(fileKey, buffer, input.mimeType);

        // Create invoice record
        const invoiceId = await createInvoice({
          fileKey,
          fileUrl: url,
          originalFileName: input.fileName,
          status: "extracting",
          uploadedBy: ctx.user.id,
        });

        // Add system note
        await createConversationNote({
          invoiceId,
          authorId: ctx.user.id,
          type: "system",
          content: `Invoice uploaded: ${input.fileName}`,
        });

        return { invoiceId, fileUrl: url };
      }),

    // Run LLM extraction on an uploaded invoice
    extract: protectedProcedure
      .input(z.object({ invoiceId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });

        // Use the storage URL directly for LLM extraction
        const extracted = await extractInvoiceData(invoice.fileUrl);

        // Try to match existing supplier
        let matchedSupplier = await findMatchingSupplier(
          extracted.supplierName ?? undefined,
          extracted.supplierAbn ?? undefined,
          extracted.supplierEmail ?? undefined
        );

        let supplierCreated = false;
        // Auto-create supplier profile if no match found and we have a name
        if (!matchedSupplier && extracted.supplierName) {
          const newSupplierId = await createSupplier({
            name: extracted.supplierName,
            abn: extracted.supplierAbn ?? undefined,
            email: extracted.supplierEmail ?? undefined,
            phone: extracted.supplierPhone ?? undefined,
            address: extracted.supplierAddress ?? undefined,
            contactName: (extracted as any).supplierContactName ?? undefined,
            createdBy: ctx.user.id,
          });
          matchedSupplier = await getSupplierById(newSupplierId);
          supplierCreated = true;
        }

        // Update invoice with extracted data
        await updateInvoice(input.invoiceId, {
          status: "extracted",
          extractedInvoiceNumber: extracted.invoiceNumber ?? undefined,
          extractedPoNumber: extracted.poNumber ?? undefined,
          extractedContainerNumbers: extracted.containerNumbers.length > 0
            ? JSON.stringify(extracted.containerNumbers)
            : undefined,
          extractedSupplierName: extracted.supplierName ?? undefined,
          extractedSupplierAbn: extracted.supplierAbn ?? undefined,
          extractedSupplierEmail: extracted.supplierEmail ?? undefined,
          extractedInvoiceDate: extracted.invoiceDate ?? undefined,
          extractedDueDate: extracted.dueDate ?? undefined,
          extractedSubtotal: extracted.subtotal?.toString() ?? undefined,
          extractedTax: extracted.tax?.toString() ?? undefined,
          extractedTotal: extracted.total?.toString() ?? undefined,
          extractedCurrency: extracted.currency,
          extractedRawData: extracted as any,
          supplierId: matchedSupplier?.id ?? undefined,
        });

        // Save line items
        if (extracted.lineItems.length > 0) {
          await deleteLineItemsByInvoice(input.invoiceId);
          await createLineItems(
            extracted.lineItems.map((li) => ({
              invoiceId: input.invoiceId,
              description: li.description,
              quantity: li.quantity?.toString() ?? undefined,
              unitPrice: li.unitPrice?.toString() ?? undefined,
              amount: li.amount?.toString() ?? undefined,
              taxRate: li.taxRate?.toString() ?? undefined,
            }))
          );
        }

        const supplierMsg = supplierCreated
          ? `New supplier profile created: "${matchedSupplier?.name}".`
          : matchedSupplier
            ? `Matched to existing supplier: "${matchedSupplier.name}".`
            : "Supplier not identified — review required.";

        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "system",
          content: `Data extracted (confidence: ${extracted.confidence}). ${supplierMsg}${extracted.poNumber ? ` PO: ${extracted.poNumber}.` : ""}`,
        });

        return { extracted, matchedSupplier, supplierCreated };
      }),

    // Update extracted fields manually
    updateExtracted: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          extractedInvoiceNumber: z.string().optional().nullable(),
          extractedPoNumber: z.string().optional().nullable(),
          extractedContainerNumbers: z.array(z.string()).optional(),
          extractedSupplierName: z.string().optional().nullable(),
          extractedSupplierAbn: z.string().optional().nullable(),
          extractedSupplierEmail: z.string().optional().nullable(),
          extractedCurrency: z.string().optional().nullable(),
          extractedInvoiceDate: z.string().optional().nullable(),
          extractedDueDate: z.string().optional().nullable(),
          extractedSubtotal: z.string().optional().nullable(),
          extractedTax: z.string().optional().nullable(),
          extractedTotal: z.string().optional().nullable(),
          supplierId: z.number().optional().nullable(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, extractedContainerNumbers, ...rest } = input;
        await updateInvoice(id, {
          ...rest,
          extractedContainerNumbers: extractedContainerNumbers
            ? JSON.stringify(extractedContainerNumbers)
            : undefined,
        });
        return { success: true };
      }),

    // Verify against Xero
    verifyWithXero: protectedProcedure
      .input(z.object({ invoiceId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });

        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Xero not configured" });
        }

        if (!invoice.extractedInvoiceNumber) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "No invoice number to verify" });
        }

        const xeroBill = await findXeroBillByInvoiceNumber(
          invoice.extractedInvoiceNumber,
          clientId,
          clientSecret
        );

        if (!xeroBill) {
          await updateInvoice(input.invoiceId, {
            status: "verified",
            xeroVerifiedAt: new Date(),
          });
          await createConversationNote({
            invoiceId: input.invoiceId,
            authorId: ctx.user.id,
            type: "system",
            content: `Xero verification: No matching bill found in Xero for invoice ${invoice.extractedInvoiceNumber}. Marked as verified (new invoice).`,
          });
          return { matched: false, discrepancy: false };
        }

        const extractedTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");
        const xeroTotal = xeroBill.total;
        const diff = Math.abs(extractedTotal - xeroTotal);
        const hasDiscrepancy = diff > 0.01;

        await updateInvoice(input.invoiceId, {
          xeroInvoiceId: xeroBill.invoiceId,
          xeroInvoiceNumber: xeroBill.invoiceNumber,
          xeroTotal: xeroTotal.toString(),
          xeroSubtotal: xeroBill.subTotal.toString(),
          xeroTax: xeroBill.totalTax.toString(),
          xeroStatus: xeroBill.status,
          xeroVerifiedAt: new Date(),
          hasDiscrepancy,
          discrepancyAmount: hasDiscrepancy ? diff.toString() : undefined,
          status: hasDiscrepancy ? "flagged" : "verified",
        });

        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: hasDiscrepancy
            ? `Discrepancy detected: Extracted total $${extractedTotal.toFixed(2)} vs Xero total $${xeroTotal.toFixed(2)} (diff: $${diff.toFixed(2)}). Invoice flagged.`
            : `Xero verification passed. Amounts match ($${xeroTotal.toFixed(2)}). Invoice verified.`,
          metadata: { xeroTotal, extractedTotal, diff, hasDiscrepancy },
        });

        return { matched: true, discrepancy: hasDiscrepancy, xeroBill };
      }),

    // Send dispute email
    sendQuery: protectedProcedure
      .input(
        z.object({
          invoiceId: z.number(),
          to: z.string().email(),
          cc: z.string().optional(),
          subject: z.string().min(1),
          body: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const smtpHost = process.env.SMTP_HOST;
        const smtpPort = parseInt(process.env.SMTP_PORT ?? "587");
        const smtpUser = process.env.SMTP_USER ?? "";
        const smtpPass = process.env.SMTP_PASS ?? "";

        if (!smtpHost) {
          // Log the email without actually sending (demo mode)
          const { createEmailLog, updateEmailLogStatus, createConversationNote: addNote } = await import("./db");
          const emailLogId = await createEmailLog({
            invoiceId: input.invoiceId,
            sentBy: ctx.user.id,
            fromAddress: "admin@containerzone.com.au",
            toAddress: input.to,
            ccAddress: input.cc ?? null,
            subject: input.subject,
            body: input.body,
            status: "sent",
            sentAt: new Date(),
          });
          await addNote({
            invoiceId: input.invoiceId,
            authorId: ctx.user.id,
            type: "email_sent",
            content: `[Demo mode] Email logged to ${input.to}: "${input.subject}"`,
            emailLogId,
          });
          await updateInvoice(input.invoiceId, { status: "queried" });
          return { success: true, emailLogId, demo: true };
        }

        const result = await sendDisputeEmail({
          invoiceId: input.invoiceId,
          sentBy: ctx.user.id,
          to: input.to,
          cc: input.cc,
          subject: input.subject,
          body: input.body,
          smtpHost,
          smtpPort,
          smtpUser,
          smtpPass,
        });

        if (result.success) {
          await updateInvoice(input.invoiceId, { status: "queried" });
        }

        return result;
      }),

    // Generate email template
    generateEmailTemplate: protectedProcedure
      .input(z.object({ invoiceId: z.number() }))
      .query(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
        const supplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;

        const containerNumbers = invoice.extractedContainerNumbers
          ? JSON.parse(invoice.extractedContainerNumbers)
          : [];

        return generateDisputeEmailTemplate({
          supplierName: supplier?.name ?? invoice.extractedSupplierName ?? "Supplier",
          invoiceNumber: invoice.extractedInvoiceNumber ?? "N/A",
          invoiceDate: invoice.extractedInvoiceDate,
          extractedTotal: invoice.extractedTotal ? parseFloat(invoice.extractedTotal.toString()) : null,
          xeroTotal: invoice.xeroTotal ? parseFloat(invoice.xeroTotal.toString()) : null,
          discrepancyAmount: invoice.discrepancyAmount
            ? parseFloat(invoice.discrepancyAmount.toString())
            : null,
          containerNumbers,
          poNumber: invoice.extractedPoNumber,
          senderName: ctx.user.name ?? "Accounts Payable",
        });
      }),

    // Add manual note
    addNote: protectedProcedure
      .input(
        z.object({
          invoiceId: z.number(),
          content: z.string().min(1),
          type: z.enum(["note", "email_received"]).default("note"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const id = await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: input.type,
          content: input.content,
        });
        return { id };
      }),

    // Resolve invoice and push to Xero
    resolve: protectedProcedure
      .input(
        z.object({
          invoiceId: z.number(),
          resolutionNotes: z.string().optional(),
          pushToXero: z.boolean().default(true),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });

        let xeroResult: { invoiceId: string; invoiceNumber: string } | null = null;

        if (input.pushToXero) {
          const clientId = process.env.XERO_CLIENT_ID;
          const clientSecret = process.env.XERO_CLIENT_SECRET;

          if (clientId && clientSecret) {
            const supplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;
            const lineItems = await getLineItemsByInvoice(input.invoiceId);

            // Find or create Xero contact
            const xeroContactId = await findOrCreateXeroContact(
              supplier?.name ?? invoice.extractedSupplierName ?? "Unknown Supplier",
              supplier?.email ?? invoice.extractedSupplierEmail ?? null,
              supplier?.abn ?? invoice.extractedSupplierAbn ?? null,
              clientId,
              clientSecret
            );

            const xeroLineItems = lineItems.length > 0
              ? lineItems.map((li) => ({
                  description: li.description ?? "Service",
                  quantity: parseFloat(li.quantity?.toString() ?? "1"),
                  unitAmount: parseFloat(li.unitPrice?.toString() ?? li.amount?.toString() ?? "0"),
                  accountCode: li.accountCode ?? "200",
                }))
              : [{
                  description: `Invoice ${invoice.extractedInvoiceNumber ?? "N/A"}`,
                  quantity: 1,
                  unitAmount: parseFloat(invoice.extractedTotal?.toString() ?? "0"),
                  accountCode: "200",
                }];

            xeroResult = await createXeroDraftBill(
              {
                supplierXeroContactId: xeroContactId ?? undefined,
                supplierName: supplier?.name ?? invoice.extractedSupplierName ?? "Unknown Supplier",
                invoiceNumber: invoice.extractedInvoiceNumber ?? `AP-${input.invoiceId}`,
                invoiceDate: invoice.extractedInvoiceDate ?? new Date().toISOString().split("T")[0],
                dueDate: invoice.extractedDueDate ?? undefined,
                lineItems: xeroLineItems,
                reference: invoice.extractedPoNumber ?? undefined,
                currencyCode: invoice.extractedCurrency ?? "AUD",
              },
              clientId,
              clientSecret
            );
          }
        }

        await updateInvoice(input.invoiceId, {
          status: "resolved",
          resolvedAt: new Date(),
          resolvedBy: ctx.user.id,
          resolutionNotes: input.resolutionNotes ?? undefined,
          xeroFinalBillId: xeroResult?.invoiceId ?? undefined,
          xeroFinalBillNumber: xeroResult?.invoiceNumber ?? undefined,
        });

        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: xeroResult
            ? `Invoice resolved. Draft bill created in Xero: ${xeroResult.invoiceNumber}. ${input.resolutionNotes ?? ""}`
            : `Invoice resolved. ${input.resolutionNotes ?? ""}`,
          metadata: { xeroResult },
        });

        return { success: true, xeroResult };
      }),

    // Update a single line item
    updateLineItem: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          description: z.string().optional().nullable(),
          quantity: z.string().optional().nullable(),
          unitPrice: z.string().optional().nullable(),
          amount: z.string().optional().nullable(),
          taxRate: z.string().optional().nullable(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateLineItem(id, data as any);
        return { success: true };
      }),

    // Delete invoice (admin only)
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const invoice = await getInvoiceById(input.id);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
        await deleteInvoice(input.id);
        return { success: true };
      }),

    // Dashboard metrics
    metrics: protectedProcedure.query(() => getDashboardMetrics()),
  }),

  // ─── Xero ────────────────────────────────────────────────────────────────────

  xero: router({
    status: protectedProcedure.query(async () => {
      const token = await getXeroToken();
      return {
        connected: !!token,
        tenantName: token?.tenantName ?? null,
        expiresAt: token?.expiresAt ?? null,
      };
    }),

    getAuthUrl: adminProcedure
      .input(z.object({ redirectUri: z.string() }))
      .query(({ input }) => {
        const clientId = process.env.XERO_CLIENT_ID;
        if (!clientId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "XERO_CLIENT_ID not set" });
        const state = Buffer.from(JSON.stringify({ ts: Date.now() })).toString("base64");
        return { url: getXeroAuthUrl(clientId, input.redirectUri, state) };
      }),

    callback: adminProcedure
      .input(z.object({ code: z.string(), redirectUri: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Xero credentials not configured" });
        }

        const tokens = await exchangeXeroCode(input.code, clientId, clientSecret, input.redirectUri);
        const tenants = await getXeroTenants(tokens.accessToken);
        const tenant = tenants[0];
        if (!tenant) throw new TRPCError({ code: "BAD_REQUEST", message: "No Xero tenants found" });

        await upsertXeroToken({
          tenantId: tenant.tenantId,
          tenantName: tenant.tenantName,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope,
          connectedBy: ctx.user.id,
        });

        return { success: true, tenantName: tenant.tenantName };
      }),

    disconnect: adminProcedure.mutation(async () => {
      await deleteXeroToken();
      return { success: true };
    }),
  }),
});

export type AppRouter = typeof appRouter;
