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
  logEmailReply,
} from "./db";
import { storagePut } from "./storage";
import { extractInvoiceData, extractAllPoNumbers } from "./extractionService";
import {
  getXeroAuthUrl,
  exchangeXeroCode,
  getXeroTenants,
  findXeroBillByInvoiceNumber,
  findXeroPurchaseOrderByNumber,
  createXeroDraftBill,
  findOrCreateXeroContact,
  markXeroPOAsBilled,
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

        // Collect all PO numbers found across the invoice text
        const allPoNumbers = extractAllPoNumbers(extracted as any);

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

    // Verify against Xero — looks up ALL Purchase Orders found on the invoice by PO number,
    // compares each PO total against the invoice total, and stores per-PO results with line items.
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

        // Collect all PO numbers: primary field + any extras found in raw data
        const primaryPo = invoice.extractedPoNumber;
        const rawData = invoice.extractedRawData as any;
        const allPoNumbers: string[] = primaryPo
          ? Array.from(new Set([
              primaryPo,
              ...extractAllPoNumbers(rawData ?? {}),
            ]))
          : extractAllPoNumbers(rawData ?? {});

        if (allPoNumbers.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No PO number found on this invoice. Cannot verify against Xero.",
          });
        }

        const extractedTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");

        // Xero PO statuses that allow amount comparison
        const COMPARABLE_STATUSES = new Set(["DRAFT", "SUBMITTED", "AUTHORISED"]);

        // Look up each PO in Xero in parallel
        const poLookups = await Promise.all(
          allPoNumbers.map(async (poNum) => {
            const po = await findXeroPurchaseOrderByNumber(poNum, clientId, clientSecret);
            if (!po) {
              return { poNumber: poNum, found: false, status: "NOT_FOUND", poTotal: 0, poSubtotal: 0, poTax: 0, discrepancy: true, alreadyBilled: false, diff: extractedTotal, lineItems: [] };
            }
            // Rule 2: If PO is already BILLED, flag immediately — do not compare amounts
            if (po.status === "BILLED") {
              return {
                poNumber: poNum,
                found: true,
                status: po.status,
                poTotal: po.total,
                poSubtotal: po.subTotal,
                poTax: po.totalTax,
                discrepancy: true,
                alreadyBilled: true,
                overBilled: false,
                underBilled: false,
                diff: 0,
                rawDiff: 0,
                contact: po.contact,
                currencyCode: po.currencyCode,
                lineItems: po.lineItems,
              };
            }
            // Rule 1: Only compare amounts for DRAFT / SUBMITTED / AUTHORISED
            if (!COMPARABLE_STATUSES.has(po.status)) {
              // Unknown/unsupported status — treat as not comparable, flag for safety
              return {
                poNumber: poNum,
                found: true,
                status: po.status,
                poTotal: po.total,
                poSubtotal: po.subTotal,
                poTax: po.totalTax,
                discrepancy: true,
                alreadyBilled: false,
                overBilled: false,
                underBilled: false,
                diff: 0,
                rawDiff: 0,
                contact: po.contact,
                currencyCode: po.currencyCode,
                lineItems: po.lineItems,
              };
            }
            const rawDiff = extractedTotal - po.total; // positive = billed more than PO, negative = billed less
            const absDiff = Math.abs(rawDiff);
            return {
              poNumber: poNum,
              found: true,
              status: po.status,
              poTotal: po.total,
              poSubtotal: po.subTotal,
              poTax: po.totalTax,
              discrepancy: absDiff > 0.01,
              alreadyBilled: false,
              overBilled: rawDiff > 0.01,   // billed > PO → flag
              underBilled: rawDiff < -0.01, // billed < PO → under budget (ok)
              diff: absDiff,
              rawDiff,
              contact: po.contact,
              currencyCode: po.currencyCode,
              lineItems: po.lineItems,
            };
          })
        );

        const anyAlreadyBilled = poLookups.some((r) => (r as any).alreadyBilled);
        const anyOverBilled = poLookups.some((r) => (r as any).overBilled);
        const anyNotFound = poLookups.some((r) => !r.found);
        const anyDiscrepancy = anyAlreadyBilled || anyOverBilled || anyNotFound;
        const allUnderBilled = !anyAlreadyBilled && poLookups.every((r) => r.found && (r as any).underBilled);
        const allFound = poLookups.every((r) => r.found);

        // Determine invoice status:
        // - any PO already BILLED → flagged (duplicate billing risk)
        // - any PO not found OR billed > PO → flagged
        // - all POs found AND billed < PO → under_budget (safe to approve)
        // - all POs found AND amounts match → verified
        let newStatus: string;
        if (anyDiscrepancy) {
          newStatus = "flagged";
        } else if (allUnderBilled) {
          newStatus = "under_budget";
        } else {
          newStatus = "verified";
        }

        // Use the first found PO for the legacy single-PO summary fields (backwards compat)
        const firstFound = poLookups.find((r) => r.found);

        await updateInvoice(input.invoiceId, {
          xeroInvoiceId: firstFound ? (firstFound as any).poNumber : null,
          xeroInvoiceNumber: firstFound ? firstFound.poNumber : null,
          xeroTotal: firstFound ? firstFound.poTotal.toString() : null,
          xeroSubtotal: firstFound ? firstFound.poSubtotal.toString() : null,
          xeroTax: firstFound ? firstFound.poTax.toString() : null,
          xeroStatus: firstFound ? firstFound.status : "NOT_FOUND",
          xeroVerifiedAt: new Date(),
          hasDiscrepancy: anyDiscrepancy,
          discrepancyAmount: anyDiscrepancy && firstFound ? firstFound.diff.toString() : null,
          status: newStatus as any,
          xeroPoResults: poLookups as any,
        });

        // Build a human-readable summary for the conversation note
        const summaryLines = poLookups.map((r) => {
          if (!r.found) return `PO ${r.poNumber}: NOT FOUND in Xero`;
          if ((r as any).alreadyBilled) return `PO ${r.poNumber}: BILLED — already billed in Xero (duplicate billing risk)`;
          return `PO ${r.poNumber}: ${r.status} — PO total $${r.poTotal.toFixed(2)} vs invoice $${extractedTotal.toFixed(2)}${r.discrepancy ? ` (DIFF $${r.diff.toFixed(2)})` : " (match)"}`;
        });

        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: anyAlreadyBilled
            ? `Xero PO verification — PO already billed:\n${summaryLines.join("\n")}. Invoice flagged (duplicate billing risk).`
            : anyDiscrepancy
              ? `Xero PO verification — discrepancy detected:\n${summaryLines.join("\n")}. Invoice flagged.`
              : allUnderBilled
                ? `Xero PO verification — billed amount is under PO budget:\n${summaryLines.join("\n")}. Invoice marked as Under Budget (safe to approve).`
                : `Xero PO verification passed — all POs matched:\n${summaryLines.join("\n")}. Invoice verified.`,
          metadata: { poLookups, extractedTotal, anyDiscrepancy, anyAlreadyBilled, allFound, allUnderBilled },
        });

        return { matched: allFound, discrepancy: anyDiscrepancy, underBudget: allUnderBilled, poResults: poLookups };
      }),

    // Admin approve — for invoices without PO numbers that cannot be verified via Xero
    adminApprove: adminProcedure
      .input(z.object({ invoiceId: z.number(), notes: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
        await updateInvoice(input.invoiceId, { status: "approved" as any });
        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: `Invoice manually approved by admin.${input.notes ? ` Notes: ${input.notes}` : ""}`,
          metadata: { approvedBy: ctx.user.id, approvedAt: new Date().toISOString() },
        });
        return { success: true };
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

        // Determine progressive status based on current queryCount
        const currentInvoice = await getInvoiceById(input.invoiceId);
        if (!currentInvoice) throw new TRPCError({ code: "NOT_FOUND" });
        const newQueryCount = (currentInvoice.queryCount ?? 0) + 1;
        const newStatus =
          newQueryCount === 1 ? "queried" :
          newQueryCount === 2 ? "queried_2nd" :
          "queried_3rd";

        const { createEmailLog, createConversationNote: addNote } = await import("./db");

        if (!smtpHost) {
          // Log the email without actually sending (demo mode)
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
            content: `[Demo mode] Query #${newQueryCount} logged to ${input.to}: "${input.subject}"`,
            emailLogId,
          });
          await updateInvoice(input.invoiceId, { status: newStatus, queryCount: newQueryCount });
          return { success: true, emailLogId, demo: true, queryCount: newQueryCount };
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
          await updateInvoice(input.invoiceId, { status: newStatus, queryCount: newQueryCount });
        }

        return { ...result, queryCount: newQueryCount };
      }),

    // Log a reply received from supplier against an email log entry
    logReply: protectedProcedure
      .input(
        z.object({
          emailLogId: z.number(),
          invoiceId: z.number(),
          replyBody: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await logEmailReply(input.emailLogId, input.replyBody, ctx.user.id);
        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "email_received",
          content: `Supplier reply logged: ${input.replyBody.substring(0, 120)}${input.replyBody.length > 120 ? "..." : ""}`,
          emailLogId: input.emailLogId,
        });
        return { success: true };
      }),

    // Send a single consolidated query email covering multiple invoices from the same supplier
    sendBulkQuery: protectedProcedure
      .input(
        z.object({
          invoiceIds: z.array(z.number()).min(1),
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

        const { createEmailLog, createConversationNote: addNote } = await import("./db");

        let emailLogId: number | null = null;

        if (!smtpHost) {
          // Demo mode — log without sending
          emailLogId = await createEmailLog({
            invoiceId: input.invoiceIds[0]!,
            sentBy: ctx.user.id,
            fromAddress: "admin@containerzone.com.au",
            toAddress: input.to,
            ccAddress: input.cc ?? null,
            subject: input.subject,
            body: input.body,
            status: "sent",
            sentAt: new Date(),
          });
        } else {
          const result = await sendDisputeEmail({
            invoiceId: input.invoiceIds[0]!,
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
          if (!result.success) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: result.error ?? "Email send failed" });
          emailLogId = result.emailLogId ?? null;
        }

        // Update all selected invoices — increment queryCount and set progressive status
        for (const invoiceId of input.invoiceIds) {
          const inv = await getInvoiceById(invoiceId);
          if (!inv) continue;
          const newQueryCount = (inv.queryCount ?? 0) + 1;
          const newStatus =
            newQueryCount === 1 ? "queried" :
            newQueryCount === 2 ? "queried_2nd" :
            "queried_3rd";
          await updateInvoice(invoiceId, { status: newStatus, queryCount: newQueryCount });
          await addNote({
            invoiceId,
            authorId: ctx.user.id,
            type: "email_sent",
            content: `Bulk query #${newQueryCount} sent to ${input.to} covering ${input.invoiceIds.length} invoice(s): "${input.subject}"`,
            emailLogId: emailLogId ?? undefined,
          });
        }

        return { success: true, emailLogId, invoiceCount: input.invoiceIds.length };
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

        const queryPoints = Array.isArray((invoice as any).queryPoints)
          ? (invoice as any).queryPoints as string[]
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
          queryPoints,
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
        let xeroStatus: "DRAFT" | "SUBMITTED" | "AUTHORISED" = "SUBMITTED";
        // Collect all PO numbers up front (used for reference field and marking as Billed)
        const rawData = invoice.extractedRawData as any;
        const allPoNumbers: string[] = invoice.extractedPoNumber
          ? Array.from(new Set([invoice.extractedPoNumber, ...extractAllPoNumbers(rawData ?? {})]))
          : extractAllPoNumbers(rawData ?? {});

        if (input.pushToXero) {
          const clientId = process.env.XERO_CLIENT_ID;
          const clientSecret = process.env.XERO_CLIENT_SECRET;

          if (clientId && clientSecret) {
            const supplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;
            const lineItems = await getLineItemsByInvoice(input.invoiceId);

            // Determine the Xero bill status based on invoice approval state and paid detection:
            // Rule 3: verified or under_budget → AUTHORISED (= AWAITING PAYMENT in Xero UI)
            // Rule 4: admin-approved (no PO / manually approved) → SUBMITTED (= AWAITING APPROVAL in Xero UI)
            // Rule 5: invoice appears paid (paid date present, zero balance, or status=paid) → AUTHORISED (Xero marks as paid separately)
            //         If unsure → SUBMITTED (AWAITING APPROVAL)
            const invoiceStatus = invoice.status as string;
            const extractedTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");
            const hasPaidDate = !!(invoice as any).extractedPaymentDate;
            const hasZeroBalance = extractedTotal === 0;
            const isPaidStatus = invoiceStatus === "paid";
            const isPaid = hasPaidDate || hasZeroBalance || isPaidStatus;

            // Rule 5: paid invoice → AUTHORISED (AWAITING PAYMENT) so Xero can reconcile
            // Rule 3: verified/under_budget → AUTHORISED (AWAITING PAYMENT)
            // Rule 4: admin-approved (no PO) → SUBMITTED (AWAITING APPROVAL)
            // Default fallback → SUBMITTED (AWAITING APPROVAL) for safety
            if (isPaid || invoiceStatus === "verified" || invoiceStatus === "under_budget") {
              xeroStatus = "AUTHORISED";
            } else {
              xeroStatus = "SUBMITTED";
            }

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
                  unitAmount: extractedTotal,
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
                // Include all PO numbers in the reference field
                reference: allPoNumbers.length > 0 ? allPoNumbers.join(", ") : undefined,
                currencyCode: invoice.extractedCurrency ?? "AUD",
                xeroStatus,
              },
              clientId,
              clientSecret
            );

            // Mark each linked PO as BILLED in Xero (only for PO-backed invoices)
            if (xeroResult && allPoNumbers.length > 0) {
              await Promise.allSettled(
                allPoNumbers.map((poNum) => markXeroPOAsBilled(poNum, clientId, clientSecret))
              );
            }
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

        const xeroStatusLabel = xeroStatus === "AUTHORISED" ? "AWAITING PAYMENT" : "AWAITING APPROVAL";
        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: xeroResult
            ? `Invoice resolved. Bill created in Xero as ${xeroStatusLabel}: ${xeroResult.invoiceNumber}${allPoNumbers.length > 0 ? `. POs marked as Billed: ${allPoNumbers.join(", ")}` : ""}. ${input.resolutionNotes ?? ""}`
            : `Invoice resolved. ${input.resolutionNotes ?? ""}`,
          metadata: { xeroResult, poNumbers: allPoNumbers, xeroStatus },
        });

        return { success: true, xeroResult };
      }),

    // Save query points (numbered dispute reasons)
    saveQueryPoints: protectedProcedure
      .input(z.object({ id: z.number(), queryPoints: z.array(z.string()) }))
      .mutation(async ({ input }) => {
        await updateInvoice(input.id, { queryPoints: input.queryPoints } as any);
        return { success: true };
      }),

    // Add a new line item manually
    addLineItem: protectedProcedure
      .input(
        z.object({
          invoiceId: z.number(),
          description: z.string().optional().nullable(),
          quantity: z.string().optional().nullable(),
          unitPrice: z.string().optional().nullable(),
          amount: z.string().optional().nullable(),
        })
      )
      .mutation(async ({ input }) => {
        const { invoiceId, ...fields } = input;
        await createLineItems([{ invoiceId, ...fields } as any]);
        return { success: true };
      }),

    // Delete a single line item
    deleteLineItem: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await (await import("./db")).getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { invoiceLineItems } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        await db.delete(invoiceLineItems).where(eq(invoiceLineItems.id, input.id));
        return { success: true };
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
