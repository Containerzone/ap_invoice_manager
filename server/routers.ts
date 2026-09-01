import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import {
  getAllUsers,
  updateUserRole,
  updateUserStatus,
  getAllPendingInvites,
  createPendingInvite,
  deletePendingInvite,
  countActiveInvites,
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
  getPoVarianceReport,
  findDuplicateInvoice,
  findInvoicesMatchingPoNumbers,
  getMicrosoftGraphState,
  getLatestMicrosoftRenewalScheduleTaskUid,
  getRecentEmailInvoiceSubmissions,
  upsertMicrosoftGraphState,
} from "./db";
import { storagePut, storageGetSignedUrl } from "./storage";
import { extractInvoiceData, extractAllPoNumbers } from "./extractionService";
import {
  getXeroAuthUrl,
  exchangeXeroCode,
  getXeroTenants,
  findXeroBillByInvoiceNumber,
  findXeroPurchaseOrderByNumber,
  createXeroDraftBill,
  findOrCreateXeroContact,
  resolveXeroSupplierContact,
  createXeroSupplierContact,
  markXeroPOAsBilled,
  convertPOsToBill,
  updateXeroPODetails,
  getXeroPOPaymentStatus,
  checkXeroBillDuplicate,
  uploadXeroBillAttachment,
} from "./xeroService";
import { sendDisputeEmail, generateDisputeEmailTemplate, sendInviteEmail } from "./emailService";
import { ENV } from "./_core/env";
import { getMicrosoftGraphConfig } from "./microsoftGraphConfig";
import { createGraphMessageSubscription, deleteGraphMessageSubscription } from "./microsoftGraphService";
import { createHeartbeatJob } from "./_core/heartbeat";
import { getGstExclusiveUnitAmount } from "./invoiceLineAmounts";
import { selectMicrosoftRenewalTaskUid } from "./microsoftGraphSchedule";
import { parse as parseCookie } from "cookie";
import { poRequests } from "../drizzle/schema";
import { desc, eq, inArray } from "drizzle-orm";

// ─── Admin guard ──────────────────────────────────────────────────────────────

const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// ─── Staff approval threshold logic ──────────────────────────────────────────
// Returns true if the staff member can approve the given discrepancy amount
// based on the invoice total.
function isWithinStaffThreshold(invoiceTotal: number, diffAmount: number): boolean {
  if (invoiceTotal <= 500) return diffAmount <= 30;
  if (invoiceTotal <= 1000) return diffAmount <= 50;
  if (invoiceTotal <= 1500) return diffAmount <= 100;
  if (invoiceTotal <= 2000) return diffAmount <= 150;
  return false; // > $2000 always requires admin
}

// ─── Refresh Xero PO results helper ─────────────────────────────────────────
// Re-runs the PO lookup after approve and saves fresh xeroPoResults to DB.
// Does NOT change the invoice status — preserves "approved" status.
async function refreshXeroPoResults(
  invoiceId: number,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  try {
    const invoice = await getInvoiceById(invoiceId);
    if (!invoice) return;

    // ── Fix #1: Build PO list from line items (source of truth) ──────────────
    // Line items are always correct — they come from what is physically printed
    // on the invoice. extractedPoNumbers (LLM header scan) can misread letters
    // (e.g. DD→BD), so we never use it as the primary PO list source.
    const lineItems = await getLineItemsByInvoice(invoiceId);
    const PO_PATTERN = /\b([A-Z]{1,2}\d{4,6})\b/g;
    const poFromLineItems = new Set<string>();
    for (const li of lineItems) {
      // Rule: poNumberEdited=true means the user manually corrected this PO number.
      // Always use the edited value and skip custRef/description scan for this line.
      if ((li as any).poNumberEdited && li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) {
        poFromLineItems.add(li.poNumber);
        continue; // do not also scan custRef/description — edited value is authoritative
      }
      if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) {
        poFromLineItems.add(li.poNumber);
      } else if ((li as any).custRef) {
        const m = ((li as any).custRef as string).match(PO_PATTERN);
        if (m) m.forEach((p: string) => poFromLineItems.add(p));
      } else if (li.description) {
        const m = li.description.match(PO_PATTERN);
        if (m) m.forEach((p: string) => poFromLineItems.add(p));
      }
    }
    // Fall back to extractedPoNumbers/extractedPoNumber only when invoice has no line items at all
    const extractedPoNumbersJson = (invoice as any).extractedPoNumbers as string[] | null;
    const primaryPo = invoice.extractedPoNumber;
    let allPoNumbers: string[];
    if (poFromLineItems.size > 0) {
      allPoNumbers = Array.from(poFromLineItems);
    } else if (extractedPoNumbersJson && extractedPoNumbersJson.length > 0) {
      allPoNumbers = Array.from(new Set(extractedPoNumbersJson.map((p: string) => p.trim()).filter(Boolean)));
    } else if (primaryPo) {
      allPoNumbers = [primaryPo];
    } else {
      allPoNumbers = [];
    }

    if (allPoNumbers.length === 0) return;

    // ── Fix #2: Never fall back to invoice total for multi-PO invoices ────────
    // If no line item is tagged with a PO, return null — do not use the full
    // invoice total as a substitute (that would compare the wrong amount).
    const getGroupedTotal = (poNum: string): number | null => {
      const tagged = lineItems.filter((li) => {
        // If user edited this line's PO number, only match by the edited poNumber field
        if ((li as any).poNumberEdited) {
          return !!(li.poNumber && li.poNumber.trim().toUpperCase() === poNum.toUpperCase());
        }
        if (li.poNumber && li.poNumber.trim().toUpperCase() === poNum.toUpperCase()) return true;
        if ((li as any).custRef) {
          const custRefMatches = ((li as any).custRef as string).match(/\b([A-Z]{1,2}\d{4,6})\b/g) ?? [];
          if (custRefMatches.map((m: string) => m.toUpperCase()).includes(poNum.toUpperCase())) return true;
        }
        const descMatches = (li.description?.match(/\b([A-Z]{1,2}\d{4,6})\b/g) ?? []).map((m: string) => m.toUpperCase());
        return descMatches.includes(poNum.toUpperCase());
      });
      if (tagged.length === 0) return null; // No fallback to invoice total
      // Use GST-inclusive total — amount in DB is excl. GST, taxRate defaults to 10%
      const total = tagged.reduce((sum, li) => {
        const excl = parseFloat(li.amount?.toString() ?? "0");
        const rate = li.taxRate != null ? parseFloat(li.taxRate.toString()) : 10;
        const incl = excl * (1 + rate / 100);
        return sum + incl;
      }, 0);
      return Math.round(total * 100) / 100;
    };

    const COMPARABLE = new Set(["DRAFT", "SUBMITTED", "AUTHORISED"]);

    // ── Fix #3: Throttle Xero API calls — max 3 concurrent, 200ms between batches
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 200;
    const allResults: any[] = [];
    for (let i = 0; i < allPoNumbers.length; i += BATCH_SIZE) {
      if (i > 0) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      const batch = allPoNumbers.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (poNum) => {
          const po = await findXeroPurchaseOrderByNumber(poNum, clientId, clientSecret);
          const groupedTotal = getGroupedTotal(poNum);
          const safeTotal = groupedTotal ?? 0; // for NOT_FOUND diff display only

          if (!po) {
            return {
              poNumber: poNum, found: false, status: "NOT_FOUND",
              poTotal: 0, poSubtotal: 0, poTax: 0,
              discrepancy: true, alreadyBilled: false,
              diff: safeTotal,
              invoiceLineItemTotal: groupedTotal ?? undefined,
              lineItems: [],
            };
          }
          if (po.status === "BILLED") {
            const paymentStatus = await getXeroPOPaymentStatus(poNum, clientId, clientSecret);
            return {
              poNumber: poNum, found: true, status: po.status,
              poTotal: po.total, poSubtotal: po.subTotal, poTax: po.totalTax,
              discrepancy: true, alreadyBilled: true,
              isPaid: paymentStatus?.isPaid ?? false,
              paidAmount: paymentStatus?.paidAmount,
              paidDate: paymentStatus?.paidDate,
              overBilled: false, underBilled: false, diff: 0, rawDiff: 0,
              contact: po.contact, currencyCode: po.currencyCode, lineItems: po.lineItems,
            };
          }
          if (!COMPARABLE.has(po.status)) {
            return {
              poNumber: poNum, found: true, status: po.status,
              poTotal: po.total, poSubtotal: po.subTotal, poTax: po.totalTax,
              discrepancy: true, alreadyBilled: false,
              overBilled: false, underBilled: false, diff: 0, rawDiff: 0,
              contact: po.contact, currencyCode: po.currencyCode, lineItems: po.lineItems,
            };
          }
          if (groupedTotal === null) {
            // No line items tagged with this PO — cannot compare, show as unknown
            return {
              poNumber: poNum, found: true, status: po.status,
              poTotal: po.total, poSubtotal: po.subTotal, poTax: po.totalTax,
              invoiceLineItemTotal: null, discrepancy: false, alreadyBilled: false,
              overBilled: false, underBilled: false, diff: 0, rawDiff: 0,
              noLineItemMatch: true,
              contact: po.contact, currencyCode: po.currencyCode, lineItems: po.lineItems,
            };
          }
          const rawDiff = groupedTotal - po.total;
          const absDiff = Math.abs(rawDiff);
          return {
            poNumber: poNum, found: true, status: po.status,
            poTotal: po.total, poSubtotal: po.subTotal, poTax: po.totalTax,
            invoiceLineItemTotal: groupedTotal,
            discrepancy: absDiff > 0.01, alreadyBilled: false,
            overBilled: rawDiff > 0.01, underBilled: rawDiff < -0.01,
            diff: absDiff, rawDiff,
            contact: po.contact, currencyCode: po.currencyCode, lineItems: po.lineItems,
          };
        }),
      );
      allResults.push(...batchResults);
    }
    const poLookups = allResults;

    const firstFound = poLookups.find((r) => r.found);
    const foundPOsRefresh = poLookups.filter((r) => r.found);
    // Sum across all found POs so the Amount Comparison card shows the correct aggregate total
    const refreshSumSubtotal = foundPOsRefresh.length > 0
      ? Math.round(foundPOsRefresh.reduce((s, r) => s + (r.poSubtotal ?? 0), 0) * 100) / 100
      : null;
    const refreshSumTax = foundPOsRefresh.length > 0
      ? Math.round(foundPOsRefresh.reduce((s, r) => s + (r.poTax ?? 0), 0) * 100) / 100
      : null;
    const refreshSumTotal = foundPOsRefresh.length > 0
      ? Math.round(foundPOsRefresh.reduce((s, r) => s + (r.poTotal ?? 0), 0) * 100) / 100
      : null;
    await updateInvoice(invoiceId, {
      xeroTotal: refreshSumTotal !== null ? refreshSumTotal.toString() : null,
      xeroSubtotal: refreshSumSubtotal !== null ? refreshSumSubtotal.toString() : null,
      xeroTax: refreshSumTax !== null ? refreshSumTax.toString() : null,
      xeroStatus: firstFound ? firstFound.status : "NOT_FOUND",
      xeroVerifiedAt: new Date(),
      xeroPoResults: poLookups as any,
    });
    console.log(`[refreshXeroPoResults] Updated xeroPoResults for invoice ${invoiceId}`);
  } catch (err: any) {
    // Non-fatal — log and continue
    console.error(`[refreshXeroPoResults] Failed for invoice ${invoiceId}:`, err?.message);
  }
}

// ─── App Router ───────────────────────────────────────────────────────────────
export const appRouter = router({
  system: systemRouter,

  microsoft: router({
    status: adminProcedure.query(async () => {
      const config = getMicrosoftGraphConfig();
      const [state, submissions] = await Promise.all([
        getMicrosoftGraphState(config.mailbox),
        getRecentEmailInvoiceSubmissions(50),
      ]);
      return {
        mailbox: config.mailbox,
        invoiceAlias: config.invoiceAlias,
        subscriptionId: state?.subscriptionId ?? null,
        subscriptionExpiresAt: state?.subscriptionExpiresAt ?? null,
        lastSubscriptionError: state?.lastSubscriptionError ?? null,
        lastNotificationAt: state?.lastNotificationAt ?? null,
        submissions,
      };
    }),
    enableInboxProcessing: adminProcedure
      .input(z.object({ origin: z.string().url() }))
      .mutation(async ({ input, ctx }) => {
        const origin = new URL(input.origin);
        if (origin.protocol !== "https:") throw new TRPCError({ code: "BAD_REQUEST", message: "Microsoft Graph requires a secure HTTPS notification URL." });
        const config = getMicrosoftGraphConfig();
        const current = await getMicrosoftGraphState(config.mailbox);
        if (current?.subscriptionId) {
          try {
            await deleteGraphMessageSubscription(current.subscriptionId);
          } catch (error: any) {
            console.warn("[microsoft-graph] Could not remove the previous subscription before replacement:", error.message);
          }
        }
        const subscription = await createGraphMessageSubscription(`${origin.origin}/api/microsoft/notifications`);
        const priorMailboxTaskUid = await getLatestMicrosoftRenewalScheduleTaskUid();
        let taskUid = selectMicrosoftRenewalTaskUid(current?.scheduleCronTaskUid, priorMailboxTaskUid);
        if (!taskUid) {
          const sessionToken = parseCookie(ctx.req.headers.cookie ?? "")[COOKIE_NAME];
          if (!sessionToken) throw new TRPCError({ code: "UNAUTHORIZED", message: "A valid session is required to schedule Microsoft subscription renewal." });
          const job = await createHeartbeatJob({
            name: "microsoft-graph-subscription-renewal",
            cron: "0 0 */12 * * *",
            path: "/api/scheduled/microsoft-subscription-renewal",
            description: "Renews the Microsoft Graph inbound invoice mailbox subscription every 12 hours.",
          }, decodeURIComponent(sessionToken));
          taskUid = job.taskUid;
        }
        await upsertMicrosoftGraphState({
          mailbox: config.mailbox,
          invoiceAlias: config.invoiceAlias,
          subscriptionId: subscription.id,
          subscriptionExpiresAt: new Date(subscription.expirationDateTime),
          scheduleCronTaskUid: taskUid,
          lastSubscriptionError: null,
          lastRenewedAt: new Date(),
        });
        return { subscriptionExpiresAt: subscription.expirationDateTime };
      }),
  }),

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

    disable: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        if (input.userId === ctx.user.id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot disable your own account." });
        }
        await updateUserStatus(input.userId, "disabled");
        return { success: true };
      }),

    enable: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(({ input }) => updateUserStatus(input.userId, "active").then(() => ({ success: true }))),

    // Pending invites — admin pre-registers email + role (max 3 active invites)
    listInvites: adminProcedure.query(() => getAllPendingInvites()),
    createInvite: adminProcedure
      .input(z.object({
        email: z.string().email(),
        role: z.enum(["user", "admin"]).default("user"),
        name: z.string().optional(),
        appUrl: z.string().optional(), // passed from frontend so email contains correct login URL
      }))
      .mutation(async ({ input, ctx }) => {
        const activeCount = await countActiveInvites();
        if (activeCount >= 3) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Maximum of 3 pending invites allowed at a time." });
        }
        const id = await createPendingInvite({
          email: input.email.toLowerCase().trim(),
          role: input.role,
          name: input.name ?? null,
          createdBy: ctx.user.id,
        });

        // Send invite email (non-blocking — failure doesn't prevent invite creation)
        const smtpHost = process.env.SMTP_HOST;
        if (smtpHost) {
          const smtpPort = parseInt(process.env.SMTP_PORT ?? "587");
          const smtpUser = process.env.SMTP_USER ?? "";
          const smtpPass = process.env.SMTP_PASS ?? "";
          const appUrl = input.appUrl ?? "https://manus.space";
          sendInviteEmail({
            to: input.email.toLowerCase().trim(),
            name: input.name ?? null,
            role: input.role,
            appUrl,
            smtpHost,
            smtpPort,
            smtpUser,
            smtpPass,
          }).catch((err) => console.error("[Invite Email] Async send error:", err?.message));
        } else {
          console.warn("[Invite Email] SMTP_HOST not configured — invite email not sent for", input.email);
        }

        return { id };
      }),
    deleteInvite: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => deletePendingInvite(input.id)),
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
          includeArchived: z.boolean().optional(),
        }).optional()
      )
      .query(async ({ input }) => {
        const allInvoices = await getAllInvoices(input);
        if (allInvoices.length === 0) return [];

        // Batch-fetch note counts per invoice (query notes = email_sent/email_received, internal = note/status_change/system)
        const db = await (await import("./db")).getDb();
        if (!db) return allInvoices.map((inv) => ({ ...inv, queryNoteCount: 0, internalNoteCount: 0 }));

        const { conversationNotes } = await import("../drizzle/schema");
        const invoiceIds = allInvoices.map((inv) => inv.id);
        const allNotes = await db
          .select({ invoiceId: conversationNotes.invoiceId, type: conversationNotes.type })
          .from(conversationNotes)
          .where(inArray(conversationNotes.invoiceId, invoiceIds));

        // Build counts per invoice
        const queryNoteCounts = new Map<number, number>();
        const internalNoteCounts = new Map<number, number>();
        for (const n of allNotes) {
          if (n.type === "email_sent" || n.type === "email_received") {
            queryNoteCounts.set(n.invoiceId, (queryNoteCounts.get(n.invoiceId) ?? 0) + 1);
          } else if (n.type === "note" || n.type === "status_change" || n.type === "system") {
            internalNoteCounts.set(n.invoiceId, (internalNoteCounts.get(n.invoiceId) ?? 0) + 1);
          }
        }

        return allInvoices.map((inv) => ({
          ...inv,
          queryNoteCount: queryNoteCounts.get(inv.id) ?? 0,
          internalNoteCount: internalNoteCounts.get(inv.id) ?? 0,
        }));
      }),

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
                const fileKeyInput = `invoices/${Date.now()}-${input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const { key: actualFileKey, url } = await storagePut(fileKeyInput, buffer, input.mimeType);
        // Create invoice record
        const invoiceId = await createInvoice({
          fileKey: actualFileKey,
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

        // Collect all PO numbers found across the invoice text (from LLM-extracted data)
        const allPoNumbersFromExtraction = extractAllPoNumbers(extracted as any);

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
              // Store per-line-item PO number and custRef (e.g. from Cust Ref column on Pacific National invoices)
              poNumber: li.poNumber ?? undefined,
              custRef: li.custRef ?? undefined,
            }))
          );
        }

        // After saving line items, scan ALL sources for PO numbers:
        // 1. Per-line-item poNumber field (most reliable — structured from LLM)
        // 2. Per-line-item custRef field (e.g. "CBHU4279322 P702739")
        // 3. Description text scan
        // 4. Notes and invoice number fields
        const PO_SCAN_PATTERN = /\b([A-Z]{1,2}\d{4,6})\b/g;
        const poFromLineItems = new Set<string>();
        for (const li of extracted.lineItems) {
          // Structured per-line PO number (highest priority)
          if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) {
            poFromLineItems.add(li.poNumber);
          }
          // custRef scan (e.g. "CBHU4279322 P702739" — extract the PO token)
          if (li.custRef) {
            const custRefMatches = li.custRef.match(PO_SCAN_PATTERN);
            if (custRefMatches) custRefMatches.forEach((m) => poFromLineItems.add(m));
          }
          // Description text scan
          if (li.description) {
            const descMatches = li.description.match(PO_SCAN_PATTERN);
            if (descMatches) descMatches.forEach((m) => poFromLineItems.add(m));
          }
        }
        // Also scan notes and invoice number fields
        const scanText = [extracted.invoiceNumber, extracted.notes].filter(Boolean).join(" ");
        if (scanText) {
          const matches = scanText.match(PO_SCAN_PATTERN);
          if (matches) matches.forEach((m) => poFromLineItems.add(m));
        }
        // Merge with LLM-found PO numbers (from top-level poNumber field)
        const allPoNumbers = Array.from(new Set([...allPoNumbersFromExtraction, ...Array.from(poFromLineItems)]));

        // Save the full list of PO numbers to the DB
        if (allPoNumbers.length > 0) {
          await updateInvoice(input.invoiceId, {
            extractedPoNumbers: allPoNumbers,
            // Also set the primary PO to the first found if not already set
            extractedPoNumber: extracted.poNumber ?? allPoNumbers[0] ?? undefined,
          });
        }

        // ── Local duplicate invoice detection ─────────────────────────────────
        // Check if another invoice with the same supplier name + invoice number already exists locally.
        let duplicateWarning: string | undefined;
        if (extracted.supplierName && extracted.invoiceNumber) {
          const duplicate = await findDuplicateInvoice(
            extracted.supplierName,
            extracted.invoiceNumber,
            input.invoiceId
          );
          if (duplicate) {
            duplicateWarning = `Duplicate detected: Invoice ${duplicate.invoiceNumber} from ${duplicate.supplierName} already exists in the system (Invoice ID #${duplicate.id}, status: ${duplicate.status}).`;
            // Mark this invoice as a duplicate
            await updateInvoice(input.invoiceId, { status: "duplicate" as any });
          }
        }

        // ── Xero bill duplicate check ─────────────────────────────────────────
        // Check if a bill with this invoice number already exists in Xero (regardless of status).
        // Uses fuzzy supplier name matching to catch manually-created records with name variations.
        let xeroBillDuplicateWarning: string | undefined;
        if (extracted.invoiceNumber && extracted.supplierName && !duplicateWarning) {
          const xeroClientId = process.env.XERO_CLIENT_ID;
          const xeroClientSecret = process.env.XERO_CLIENT_SECRET;
          if (xeroClientId && xeroClientSecret) {
            try {
              const xeroDup = await checkXeroBillDuplicate(
                extracted.invoiceNumber,
                extracted.supplierName,
                xeroClientId,
                xeroClientSecret
              );
              if (xeroDup) {
                const xeroStatusLabel = {
                  DRAFT: "Draft",
                  SUBMITTED: "Awaiting Approval",
                  AUTHORISED: "Awaiting Payment",
                  PAID: "Paid",
                  VOIDED: "Voided",
                  DELETED: "Deleted",
                }[xeroDup.bill.status] ?? xeroDup.bill.status;
                const amountStr = `$${xeroDup.bill.total.toFixed(2)} ${xeroDup.bill.currencyCode}`;
                if (xeroDup.supplierNameMatch) {
                  xeroBillDuplicateWarning = `A bill for invoice ${extracted.invoiceNumber} from "${xeroDup.nameInXero}" already exists in Xero (Amount: ${amountStr}, Stage: ${xeroStatusLabel}).`;
                } else {
                  // Invoice number matches but supplier name doesn't — flag as possible duplicate
                  xeroBillDuplicateWarning = `A bill for invoice number ${extracted.invoiceNumber} exists in Xero under a different supplier name "${xeroDup.nameInXero}" (Amount: ${amountStr}, Stage: ${xeroStatusLabel}). Verify this is not a duplicate.`;
                }
                console.log(`[Extract] Xero bill duplicate found: ${xeroBillDuplicateWarning}`);
              }
            } catch (xeroErr: any) {
              console.warn(`[Extract] Xero bill duplicate check failed: ${xeroErr.message}`);
            }
          }
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
          content: `Data extracted (confidence: ${extracted.confidence}). ${supplierMsg}${extracted.poNumber ? ` PO: ${extracted.poNumber}.` : ""}${duplicateWarning ? ` ⚠️ ${duplicateWarning}` : ""}${xeroBillDuplicateWarning ? ` ⚠️ Xero: ${xeroBillDuplicateWarning}` : ""}`,
        });

        return { extracted, matchedSupplier, supplierCreated, duplicateWarning, xeroBillDuplicateWarning };
      }),

    // Update extracted fields manually
    updateExtracted: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          extractedInvoiceNumber: z.string().optional().nullable(),
          extractedPoNumber: z.string().optional().nullable(),
          extractedPoNumbers: z.array(z.string()).optional().nullable(),
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
        const { id, extractedContainerNumbers, extractedPoNumbers, ...rest } = input;
        // `null` is an intentional manual clear. Do not coalesce it to `undefined`,
        // because undefined omits the database update and leaves the previous PO list in place.
        const hasPoNumberListUpdate = Object.prototype.hasOwnProperty.call(input, "extractedPoNumbers");
        await updateInvoice(id, {
          ...rest,
          extractedContainerNumbers: extractedContainerNumbers
            ? JSON.stringify(extractedContainerNumbers)
            : undefined,
          extractedPoNumbers: hasPoNumberListUpdate ? extractedPoNumbers : undefined,
        } as any);
        return { success: true };
      }),

    // Verify against Xero — looks up ALL Purchase Orders found on the invoice by PO number.
    // For MULTIPLE POs: groups invoice line items by PO number (matched from description),
    // then compares each PO's grouped line-item total against the corresponding Xero PO total.
    // For a SINGLE PO: falls back to comparing the invoice total against the Xero PO total.
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

        // PO pattern: 1-2 uppercase letters + exactly 6 digits
        // Known supplier prefixes: P (Pacific National), SL (Straitlink), AZ (Aurizon), TR (Tasmanian Railways)
        // Plus any other 1-2 letter prefix (AD, BD, DD, ED, A, B, D, E, etc.)
        const PO_PATTERN = /\b([A-Z]{1,2}\d{4,6})\b/g;

        const extractedTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");

        // Fetch invoice line items FIRST — they are the definitive source for PO numbers
        const invoiceLineItems = await getLineItemsByInvoice(input.invoiceId);

        // Scan DB line items for PO numbers — check all fields (most reliable source)
        const poFromDbLineItems = new Set<string>();
        for (const li of invoiceLineItems) {
          // Rule: poNumberEdited=true means the user manually corrected this PO number.
          // Always use the edited value and skip custRef/description scan for this line.
          if ((li as any).poNumberEdited) {
            if ((li as any).poNumber && /^[A-Z]{1,2}\d{4,6}$/.test((li as any).poNumber)) {
              poFromDbLineItems.add((li as any).poNumber);
            }
            continue; // edited value is authoritative — do not also scan custRef/description
          }
          // Priority 1: structured per-line poNumber field (e.g. from Cust Ref column)
          if ((li as any).poNumber && /^[A-Z]{1,2}\d{4,6}$/.test((li as any).poNumber)) {
            poFromDbLineItems.add((li as any).poNumber);
          }
          // Priority 2: custRef field scan (e.g. "CBHU4279322 P702739")
          if ((li as any).custRef) {
            const custRefMatches = ((li as any).custRef as string).match(PO_PATTERN);
            if (custRefMatches) custRefMatches.forEach((m) => poFromDbLineItems.add(m));
          }
          // Priority 3: description text scan
          const desc = li.description ?? "";
          const descMatches = desc.match(PO_PATTERN);
          if (descMatches) descMatches.forEach((m) => poFromDbLineItems.add(m));
        }

        // ── Fix #1: PO list from line items (source of truth) ──────────────────────
        // Line items are always correct — they come from what is physically printed on the invoice.
        // extractedPoNumbers (LLM header scan) can misread letters (e.g. DD→BD).
        // We use line items as the definitive source; fall back to extractedPoNumbers only when
        // the invoice has no line items at all.
        const extractedPoNumbersJson = (invoice as any).extractedPoNumbers as string[] | null;
        const primaryPo = invoice.extractedPoNumber;
        let allPoNumbers: string[];
        if (poFromDbLineItems.size > 0) {
          // Line items found — use them as the authoritative PO list
          allPoNumbers = Array.from(poFromDbLineItems);
        } else if (extractedPoNumbersJson && extractedPoNumbersJson.length > 0) {
          // No line items — fall back to extractedPoNumbers (LLM-extracted or manually set)
          allPoNumbers = Array.from(new Set(extractedPoNumbersJson.map(p => p.trim()).filter(Boolean)));
        } else if (primaryPo) {
          // Single PO from primary field
          allPoNumbers = [primaryPo];
        } else {
          // Last resort: scan raw data
          const rawData = invoice.extractedRawData as any;
          allPoNumbers = extractAllPoNumbers(rawData ?? {});
        }

        console.log(`[verifyWithXero] Invoice ${input.invoiceId}: found ${allPoNumbers.length} PO(s): ${allPoNumbers.join(", ")} | DB line items: ${invoiceLineItems.length}`);

        if (allPoNumbers.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "No PO number found on this invoice. Cannot verify against Xero.",
          });
        }

        /**
         * For a given PO number, sum the amounts of invoice line items associated with that PO.
         * Checks (in priority order):
         * 1. li.poNumber field (structured, most reliable — e.g. from Cust Ref column)
         * 2. li.custRef field (raw ref text, e.g. "CBHU4279322 P702739")
         * 3. li.description text scan (fallback for invoices where PO is embedded in description)
         * Returns null if no line items match (caller falls back to invoice total).
         */
        function getGroupedLineItemTotal(poNum: string): number | null {
          if (invoiceLineItems.length === 0) return null;
          const matched = invoiceLineItems.filter((li) => {
            // If user edited this line's PO number, only match by the edited poNumber field
            if ((li as any).poNumberEdited) {
              return !!(li.poNumber && li.poNumber.trim().toUpperCase() === poNum.toUpperCase());
            }
            // Priority 1: structured per-line poNumber field
            if (li.poNumber && li.poNumber === poNum) return true;
            // Priority 2: custRef text scan (e.g. "CBHU4279322 P702739")
            if (li.custRef) {
              const custRefMatches = li.custRef.match(PO_PATTERN);
              if (custRefMatches && custRefMatches.includes(poNum)) return true;
            }
            // Priority 3: description text scan
            const desc = li.description ?? "";
            const descMatches = desc.match(PO_PATTERN);
            return descMatches ? descMatches.includes(poNum) : false;
          });
          if (matched.length === 0) return null;
          // Use GST-inclusive amount: amount * (1 + taxRate/100)
          // Default to 10% GST (Australian standard) when taxRate is null/undefined
          const total = matched.reduce((sum, li) => {
            const excl = parseFloat(li.amount?.toString() ?? "0");
            const rate = li.taxRate != null ? parseFloat(li.taxRate.toString()) : 10;
            const incl = excl * (1 + rate / 100);
            return sum + incl;
          }, 0);
          // Round to 2 decimal places to avoid floating point drift
          const rounded = Math.round(total * 100) / 100;
          console.log(`[verifyWithXero] PO ${poNum}: matched ${matched.length} line item(s), GST-inclusive total = ${rounded}`);
          return rounded;
        }

        // Xero PO statuses that allow amount comparison
        const COMPARABLE_STATUSES = new Set(["DRAFT", "SUBMITTED", "AUTHORISED"]);

        // ── Fix #3: Throttle Xero API calls — max 3 concurrent, 200ms between batches ──
        const VERIFY_BATCH_SIZE = 3;
        const VERIFY_BATCH_DELAY_MS = 200;
        const verifyAllResults: any[] = [];
        for (let _bi = 0; _bi < allPoNumbers.length; _bi += VERIFY_BATCH_SIZE) {
          if (_bi > 0) await new Promise((r) => setTimeout(r, VERIFY_BATCH_DELAY_MS));
          const _batch = allPoNumbers.slice(_bi, _bi + VERIFY_BATCH_SIZE);
          let _batchResults: any[];
          try {
            _batchResults = await Promise.all(_batch.map(async (poNum) => {
            const po = await findXeroPurchaseOrderByNumber(poNum, clientId, clientSecret);

            // Determine the comparison amount for this PO.
            // Returns null when no line items are tagged with this PO — do NOT fall back to
            // invoice total (that would compare the wrong amount for multi-PO invoices).
            const groupedTotal = getGroupedLineItemTotal(poNum);
            const safeTotal = groupedTotal ?? 0; // used only for NOT_FOUND diff display

            if (!po) {
              return { poNumber: poNum, found: false, status: "NOT_FOUND", poTotal: 0, poSubtotal: 0, poTax: 0, discrepancy: true, alreadyBilled: false, diff: safeTotal, invoiceLineItemTotal: groupedTotal ?? undefined, lineItems: [] };
            }
            // Rule 2: If PO is already BILLED, flag immediately — also check payment status
            if (po.status === "BILLED") {
              // Check if the linked bill has been paid
              const paymentStatus = await getXeroPOPaymentStatus(poNum, clientId, clientSecret);
              const isPaid = paymentStatus?.isPaid ?? false;
              const paidAmount = paymentStatus?.paidAmount;
              const paidDate = paymentStatus?.paidDate;
              return {
                poNumber: poNum,
                found: true,
                status: po.status,
                poTotal: po.total,
                poSubtotal: po.subTotal,
                poTax: po.totalTax,
                discrepancy: true,
                alreadyBilled: true,
                isPaid,
                paidAmount,
                paidDate,
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
            // If no line items match this PO, we cannot compare — show as unknown
            if (groupedTotal === null) {
              return {
                poNumber: poNum, found: true, status: po.status,
                poTotal: po.total, poSubtotal: po.subTotal, poTax: po.totalTax,
                invoiceLineItemTotal: null, discrepancy: false, alreadyBilled: false,
                overBilled: false, underBilled: false, diff: 0, rawDiff: 0,
                noLineItemMatch: true,
                contact: po.contact, currencyCode: po.currencyCode, lineItems: po.lineItems,
              };
            }
            // Use grouped line-item total for this PO (multi-PO) or invoice total (single PO)
            const rawDiff = groupedTotal - po.total; // positive = billed more than PO, negative = billed less
            const absDiff = Math.abs(rawDiff);
            return {
              poNumber: poNum,
              found: true,
              status: po.status,
              poTotal: po.total,
              poSubtotal: po.subTotal,
              poTax: po.totalTax,
              invoiceLineItemTotal: groupedTotal, // the invoice-side amount used for comparison
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
            }));
          } catch (xeroError: any) {
            console.error(`[verifyWithXero] Xero PO lookup failed for invoice ${input.invoiceId}:`, xeroError?.message ?? xeroError);
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: xeroError?.message ?? "Xero could not retrieve the purchase order. Please retry shortly.",
            });
          }
          verifyAllResults.push(..._batchResults);
        }
        const poLookups = verifyAllResults;

        const anyAlreadyBilled = poLookups.some((r) => (r as any).alreadyBilled);
        const anyOverBilled = poLookups.some((r) => (r as any).overBilled);   // ANY single PO over-billed → flag
        const anyNotFound = poLookups.some((r) => !r.found);
        const anyDiscrepancy = anyAlreadyBilled || anyOverBilled || anyNotFound;
        const allUnderBilled = !anyAlreadyBilled && poLookups.every((r) => r.found && (r as any).underBilled);
        const allFound = poLookups.every((r) => r.found);

        // Total net difference across all POs: positive = net over-billed, negative = net under-billed
        const totalNetDiff = poLookups
          .filter((r) => r.found && !(r as any).alreadyBilled && r.rawDiff !== undefined)
          .reduce((sum, r) => sum + (r.rawDiff ?? 0), 0);
        const totalNetDiffRounded = Math.round(totalNetDiff * 100) / 100;

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

        // Use the first found PO for legacy single-value fields; sum ALL found POs for totals
        const firstFound = poLookups.find((r) => r.found);
        const foundPOs = poLookups.filter((r) => r.found);
        // Sum subtotal, tax, and total across all found POs so the Amount Comparison card
        // shows the correct aggregate Xero figure for multi-PO invoices.
        const sumXeroSubtotal = foundPOs.length > 0
          ? Math.round(foundPOs.reduce((s, r) => s + ((r as any).poSubtotal ?? 0), 0) * 100) / 100
          : null;
        const sumXeroTax = foundPOs.length > 0
          ? Math.round(foundPOs.reduce((s, r) => s + ((r as any).poTax ?? 0), 0) * 100) / 100
          : null;
        const sumXeroTotal = foundPOs.length > 0
          ? Math.round(foundPOs.reduce((s, r) => s + ((r as any).poTotal ?? 0), 0) * 100) / 100
          : null;

        // Build originalPoAmounts map: { [poNumber]: poTotal } from this verification run
        // Only store on first verification (when originalPoAmounts is not yet set) to preserve the baseline
        const existingOriginalPoAmounts = (invoice as any).originalPoAmounts as Record<string, number> | null;
        const newOriginalPoAmounts: Record<string, number> = existingOriginalPoAmounts ?? {};
        if (!existingOriginalPoAmounts) {
          // First verification — capture all found PO totals as the baseline
          for (const r of poLookups) {
            if (r.found && !r.alreadyBilled) {
              newOriginalPoAmounts[r.poNumber] = r.poTotal;
            }
          }
        }

        await updateInvoice(input.invoiceId, {
          xeroInvoiceId: firstFound ? (firstFound as any).poNumber : null,
          xeroInvoiceNumber: firstFound ? firstFound.poNumber : null,
          xeroTotal: sumXeroTotal !== null ? sumXeroTotal.toString() : null,
          xeroSubtotal: sumXeroSubtotal !== null ? sumXeroSubtotal.toString() : null,
          xeroTax: sumXeroTax !== null ? sumXeroTax.toString() : null,
          xeroStatus: firstFound ? firstFound.status : "NOT_FOUND",
          xeroVerifiedAt: new Date(),
          hasDiscrepancy: anyDiscrepancy,
          discrepancyAmount: anyDiscrepancy && firstFound ? firstFound.diff.toString() : null,
          totalNetDiff: totalNetDiffRounded.toString(),
          status: newStatus as any,
          xeroPoResults: poLookups as any,
          ...(!existingOriginalPoAmounts && Object.keys(newOriginalPoAmounts).length > 0
            ? { originalPoAmounts: newOriginalPoAmounts as any }
            : {}),
        });

        // Build a human-readable summary for the conversation note
        const summaryLines = poLookups.map((r) => {
          if (!r.found) return `PO ${r.poNumber}: NOT FOUND in Xero`;
          if ((r as any).alreadyBilled) {
            const paid = (r as any).isPaid;
            const paidAmt = (r as any).paidAmount;
            const paidDate = (r as any).paidDate;
            const paidMsg = paid
              ? ` — PAID${paidAmt ? ` $${paidAmt.toFixed(2)}` : ""}${paidDate ? ` on ${paidDate}` : ""}`
              : " — NOT YET PAID";
            return `PO ${r.poNumber}: BILLED — already billed in Xero (duplicate billing risk)${paidMsg}`;
          }
          const invoiceAmt = (r as any).invoiceLineItemTotal ?? extractedTotal;
          return `PO ${r.poNumber}: ${r.status} — PO total $${r.poTotal.toFixed(2)} vs invoice line items $${invoiceAmt.toFixed(2)}${r.discrepancy ? ` (DIFF $${r.diff.toFixed(2)})` : " (match)"}`;
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

        return { matched: allFound, discrepancy: anyDiscrepancy, underBudget: allUnderBilled, poResults: poLookups, totalNetDiff: totalNetDiffRounded };
      }),

    // Staff approve — for invoices within staff approval thresholds
    // Staff can approve: ≤$30 diff for invoices ≤$500, ≤$50 for $501-$1000, ≤$100 for $1001-$2000
    // Anything outside these thresholds sets requiresAdminApproval=true
    staffApprove: protectedProcedure
      .input(z.object({ invoiceId: z.number(), notes: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });

        // ── Workflow guard: must be verified before approval ──────────────────────
        const verifiedStatuses = ["verified", "flagged", "under_budget", "queried", "queried_2nd", "queried_3rd", "queried_4th", "queried_5th"];
        if (!verifiedStatuses.includes(invoice.status as string)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invoice must be verified with Xero before it can be approved.",
          });
        }

        const invoiceTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");
        const discrepancyAmount = parseFloat(invoice.discrepancyAmount?.toString() ?? "0");

        // Check if within staff threshold
        const withinThreshold = isWithinStaffThreshold(invoiceTotal, discrepancyAmount);

        if (!withinThreshold) {
          // Mark as requiring admin approval instead
          await updateInvoice(input.invoiceId, {
            requiresAdminApproval: true,
          } as any);
          await createConversationNote({
            invoiceId: input.invoiceId,
            authorId: ctx.user.id,
            type: "status_change",
            content: `Staff approval attempted by ${ctx.user.name ?? "staff"} — discrepancy $${discrepancyAmount.toFixed(2)} on invoice total $${invoiceTotal.toFixed(2)} exceeds staff threshold. Admin approval required.`,
            metadata: { invoiceTotal, discrepancyAmount, attemptedBy: ctx.user.id },
          });
          return { success: false, requiresAdminApproval: true, invoiceTotal, discrepancyAmount };
        }

        // Within threshold — check for PO conflicts before approving
        // Build PO list from line items (source of truth), fall back to extractedPoNumbers
        const staffLineItemsPre = await getLineItemsByInvoice(input.invoiceId);
        const staffPoPatternPre = /\b([A-Z]{1,2}\d{4,6})\b/g;
        const staffPoFromLineItemsPre = new Set<string>();
        for (const li of staffLineItemsPre) {
          if ((li as any).poNumberEdited) {
            if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) staffPoFromLineItemsPre.add(li.poNumber);
            continue; // edited value is authoritative
          }
          if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) staffPoFromLineItemsPre.add(li.poNumber);
          else if (li.custRef) { const m = li.custRef.match(staffPoPatternPre); if (m) m.forEach((p) => staffPoFromLineItemsPre.add(p)); }
          else if (li.description) { const m = li.description.match(staffPoPatternPre); if (m) m.forEach((p) => staffPoFromLineItemsPre.add(p)); }
        }
        const staffPoNumbersJsonPre = (invoice as any).extractedPoNumbers as string[] | null;
        const staffPrimaryPoPre = invoice.extractedPoNumber;
        const staffPoNumbersPre: string[] = staffPoFromLineItemsPre.size > 0
          ? Array.from(staffPoFromLineItemsPre)
          : staffPoNumbersJsonPre && staffPoNumbersJsonPre.length > 0
            ? Array.from(new Set(staffPoNumbersJsonPre.map((p: string) => p.trim()).filter(Boolean)))
            : staffPrimaryPoPre ? [staffPrimaryPoPre] : [];

        if (staffPoNumbersPre.length > 0) {
          const conflicts = await findInvoicesMatchingPoNumbers(staffPoNumbersPre, input.invoiceId);
          if (conflicts.length > 0) {
            const c = conflicts[0];
            throw new TRPCError({
              code: "CONFLICT",
              message: `This PO has already been matched and approved to Invoice Number ${c.invoiceNumber ?? c.id} from Supplier ${c.supplierName ?? "Unknown"}. Delete that invoice to reassign this PO.`,
            });
          }
        }

        // Within threshold — approve
        await updateInvoice(input.invoiceId, {
          status: "approved" as any,
          staffApproved: true,
          staffApprovedBy: ctx.user.id,
          staffApprovedAt: new Date(),
          approvalNotes: input.notes ?? null,
          requiresAdminApproval: false,
        } as any);

        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: `Invoice approved by staff (${ctx.user.name ?? "staff"}). Discrepancy $${discrepancyAmount.toFixed(2)} within staff threshold for invoice total $${invoiceTotal.toFixed(2)}.${input.notes ? ` Notes: ${input.notes}` : ""}`,
          metadata: { approvedBy: ctx.user.id, approvedAt: new Date().toISOString(), invoiceTotal, discrepancyAmount },
        });

        // ── Sync PO details in Xero ─────────────────────────────────────────────────
        const xeroStaffResults: Array<{ poNumber: string; status: string; error?: string }> = [];
        const staffClientId = process.env.XERO_CLIENT_ID;
        const staffClientSecret = process.env.XERO_CLIENT_SECRET;

        // Build PO list from line items (source of truth), fall back to extractedPoNumbers
        const staffPoPatternXero = /\b([A-Z]{1,2}\d{4,6})\b/g;
        const staffPoFromLineItemsXero = new Set<string>();
        for (const li of staffLineItemsPre) {
          if ((li as any).poNumberEdited) {
            if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) staffPoFromLineItemsXero.add(li.poNumber);
            continue; // edited value is authoritative
          }
          if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) staffPoFromLineItemsXero.add(li.poNumber);
          else if (li.custRef) { const m = li.custRef.match(staffPoPatternXero); if (m) m.forEach((p) => staffPoFromLineItemsXero.add(p)); }
          else if (li.description) { const m = li.description.match(staffPoPatternXero); if (m) m.forEach((p) => staffPoFromLineItemsXero.add(p)); }
        }
        const staffPoNumbersJson = (invoice as any).extractedPoNumbers as string[] | null;
        const staffPrimaryPo = invoice.extractedPoNumber;
        const staffPoNumbers: string[] = staffPoFromLineItemsXero.size > 0
          ? Array.from(staffPoFromLineItemsXero)
          : staffPoNumbersJson && staffPoNumbersJson.length > 0
            ? Array.from(new Set(staffPoNumbersJson.map((p: string) => p.trim()).filter(Boolean)))
            : staffPrimaryPo ? [staffPrimaryPo] : [];

        if (staffClientId && staffClientSecret && staffPoNumbers.length > 0) {
          const staffSupplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;
          const staffSupplierName = staffSupplier?.name ?? invoice.extractedSupplierName ?? undefined;
          const staffLineItems = staffLineItemsPre; // already fetched above
          const PO_REGEX_STAFF = /\b([A-Z]{1,2}\d{4,6})\b/g;
          console.log(`[StaffApproval] Updating ${staffPoNumbers.length} PO(s) in Xero:`, staffPoNumbers);
          for (const poNum of staffPoNumbers) {
            // Filter line items to only those belonging to this PO
            const poLineItems = staffLineItems.filter((li) => {
              if (li.poNumber && li.poNumber.trim().toUpperCase() === poNum.toUpperCase()) return true;
              if (li.custRef) {
                const matches = (li.custRef.match(/\b([A-Z]{1,2}\d{4,6})\b/g) ?? []).map(m => m.toUpperCase());
                if (matches.includes(poNum.toUpperCase())) return true;
              }
              if (li.description) {
                const matches = (li.description.match(/\b([A-Z]{1,2}\d{4,6})\b/g) ?? []).map(m => m.toUpperCase());
                if (matches.includes(poNum.toUpperCase())) return true;
              }
              return false;
            });
            // Fall back to all line items only when there is a single PO (no ambiguity)
            const itemsForPo = poLineItems.length > 0
              ? poLineItems
              : staffPoNumbers.length === 1 ? staffLineItems : [];
// Build line items: pass only description/quantity/unitAmount (GST-exclusive).
            // updateXeroPODetails inherits AccountCode and TaxType from the existing Xero PO line items.
            const staffXeroLineItems = itemsForPo.length > 0
              ? itemsForPo.map((li) => {
                  const qty = parseFloat(li.quantity?.toString() ?? "1") || 1;
                  // `amount` is always GST-exclusive per extraction prompt (line total excl. GST).
                  // `unitPrice` may be GST-inclusive on some invoices, so we derive the
                  // per-unit exclusive amount from amount/qty to guarantee correctness.
                  const unitAmountExcl = getGstExclusiveUnitAmount(li.amount, qty);
                  return {
                    description: li.description ?? "Service",
                    quantity: qty,
                    unitAmount: unitAmountExcl,
                  };
                })
              : undefined;
            try {
              const result = await updateXeroPODetails(
                poNum,
                {
                  invoiceNumber: invoice.extractedInvoiceNumber ?? undefined,
                  supplierName: staffSupplierName,
                  supplierEmail: staffSupplier?.email ?? invoice.extractedSupplierEmail ?? null,
                  supplierXeroContactId: staffSupplier?.xeroContactId ?? undefined,
                  status: "AUTHORISED",
                  lineItems: staffXeroLineItems,
                },
                staffClientId,
                staffClientSecret
              );
              xeroStaffResults.push({ poNumber: poNum, status: result.finalStatus });
            } catch (err: any) {
              xeroStaffResults.push({ poNumber: poNum, status: "ERROR", error: err?.message ?? "Unknown error" });
              console.error(`[StaffApproval] Failed to update PO ${poNum}:`, err?.message);
            }
          }
        }

        // Refresh xeroPoResults in DB so UI shows updated match amounts immediately after approve
        if (staffClientId && staffClientSecret && staffPoNumbers.length > 0) {
          await refreshXeroPoResults(input.invoiceId, staffClientId, staffClientSecret);
        }
        // Re-fetch the invoice to get the fresh xeroPoResults that refreshXeroPoResults just wrote
        const updatedInvoiceStaff = await getInvoiceById(input.invoiceId);
        const xeroStaffErrors = xeroStaffResults.filter(r => r.status === "ERROR");
        return {
          success: true,
          requiresAdminApproval: false,
          xeroUpdateResults: xeroStaffResults,
          xeroPoResults: (updatedInvoiceStaff as any)?.xeroPoResults ?? null,
          xeroWarning: xeroStaffErrors.length > 0
            ? xeroStaffErrors.map(r => r.error ?? `PO ${r.poNumber} update failed`).join("; ")
            : undefined,
        };
      }),

    // Admin approve — for invoices without PO numbers OR outside staff thresholds
    // Also syncs PO details in Xero if PO numbers are present
    adminApprove: adminProcedure
      .input(z.object({ invoiceId: z.number(), notes: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });

        // ── Workflow guard: must be verified before admin approval ───────────────
        const verifiedStatusesAdmin = ["verified", "flagged", "under_budget", "approved", "queried", "queried_2nd", "queried_3rd", "queried_4th", "queried_5th"];
        if (!verifiedStatusesAdmin.includes(invoice.status as string)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invoice must be verified with Xero before it can be approved.",
          });
        }

        // ── 1. Resolve PO numbers from line items (source of truth) ────────────────
        // Build from line items first; fall back to extractedPoNumbers only when no line items exist
        const adminLineItemsForPo = await getLineItemsByInvoice(input.invoiceId);
        const adminPoPattern = /\b([A-Z]{1,2}\d{4,6})\b/g;
        const adminPoFromLineItems = new Set<string>();
        for (const li of adminLineItemsForPo) {
          if ((li as any).poNumberEdited) {
            if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) adminPoFromLineItems.add(li.poNumber);
            continue; // edited value is authoritative
          }
          if (li.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(li.poNumber)) adminPoFromLineItems.add(li.poNumber);
          else if (li.custRef) { const m = li.custRef.match(adminPoPattern); if (m) m.forEach((p) => adminPoFromLineItems.add(p)); }
          else if (li.description) { const m = li.description.match(adminPoPattern); if (m) m.forEach((p) => adminPoFromLineItems.add(p)); }
        }
        const extractedPoNumbersJson = (invoice as any).extractedPoNumbers as string[] | null;
        const primaryPo = invoice.extractedPoNumber;
        const allPoNumbers: string[] = adminPoFromLineItems.size > 0
          ? Array.from(adminPoFromLineItems)
          : extractedPoNumbersJson && extractedPoNumbersJson.length > 0
            ? Array.from(new Set(extractedPoNumbersJson.map((p: string) => p.trim()).filter(Boolean)))
            : primaryPo ? [primaryPo] : [];

        // ── 1b. Check for PO conflicts before marking approved ─────────────────
        if (allPoNumbers.length > 0) {
          const conflicts = await findInvoicesMatchingPoNumbers(allPoNumbers, input.invoiceId);
          if (conflicts.length > 0) {
            const c = conflicts[0];
            throw new TRPCError({
              code: "CONFLICT",
              message: `This PO has already been matched and approved to Invoice Number ${c.invoiceNumber ?? c.id} from Supplier ${c.supplierName ?? "Unknown"}. Delete that invoice to reassign this PO.`,
            });
          }
        }

        // ── 2. Mark approved in DB ──────────────────────────────────────────────
        await updateInvoice(input.invoiceId, {
          status: "approved" as any,
          adminApproved: true,
          adminApprovedBy: ctx.user.id,
          adminApprovedAt: new Date(),
          approvalNotes: input.notes ?? null,
          requiresAdminApproval: false,
        } as any);

        // ── 3. Sync each PO in Xero ───────────────────────────────────────────
        const xeroUpdateResults: Array<{ poNumber: string; status: string; error?: string }> = [];
        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;

        if (clientId && clientSecret && allPoNumbers.length > 0) {
          const supplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;
          const supplierName = supplier?.name ?? invoice.extractedSupplierName ?? undefined;
          const lineItems = adminLineItemsForPo; // already fetched above

          console.log(`[Approval] Updating ${allPoNumbers.length} PO(s) in Xero for invoice ${invoice.extractedInvoiceNumber}:`, allPoNumbers);

          for (const poNum of allPoNumbers) {
            // Filter line items to only those belonging to this PO
            const poLineItems = lineItems.filter((li) => {
              if (li.poNumber && li.poNumber.trim().toUpperCase() === poNum.toUpperCase()) return true;
              if (li.custRef) {
                const matches = (li.custRef.match(/\b([A-Z]{1,2}\d{4,6})\b/g) ?? []).map(m => m.toUpperCase());
                if (matches.includes(poNum.toUpperCase())) return true;
              }
              if (li.description) {
                const matches = (li.description.match(/\b([A-Z]{1,2}\d{4,6})\b/g) ?? []).map(m => m.toUpperCase());
                if (matches.includes(poNum.toUpperCase())) return true;
              }
              return false;
            });
            // Fall back to all line items only when there is a single PO (no ambiguity)
            const itemsForPo = poLineItems.length > 0
              ? poLineItems
              : allPoNumbers.length === 1 ? lineItems : [];
            // Build line items: pass only description/quantity/unitAmount (GST-exclusive).
            // updateXeroPODetails inherits AccountCode and TaxType from the existing Xero PO line items.
            const xeroLineItems = itemsForPo.length > 0
              ? itemsForPo.map((li) => {
                  const qty = parseFloat(li.quantity?.toString() ?? "1") || 1;
                  // `amount` is always GST-exclusive per extraction prompt (line total excl. GST).
                  // Derive per-unit exclusive amount from amount/qty to avoid using unitPrice
                  // which may be GST-inclusive on some invoices.
                  const unitAmountExcl = getGstExclusiveUnitAmount(li.amount, qty);
                  return {
                    description: li.description ?? "Service",
                    quantity: qty,
                    unitAmount: unitAmountExcl,
                  };
                })
              : undefined;
            try {
              const result = await updateXeroPODetails(
                poNum,
                {
                  invoiceNumber: invoice.extractedInvoiceNumber ?? undefined,
                  supplierName,
                  supplierEmail: supplier?.email ?? invoice.extractedSupplierEmail ?? null,
                  supplierXeroContactId: supplier?.xeroContactId ?? undefined,
                  status: "AUTHORISED",
                  lineItems: xeroLineItems,
                },
                clientId,
                clientSecret
              );
              xeroUpdateResults.push({ poNumber: poNum, status: result.finalStatus });
              console.log(`[Approval] PO ${poNum} updated successfully. Final status: ${result.finalStatus}`);
            } catch (err: any) {
              const msg = err?.message ?? "Unknown error";
              xeroUpdateResults.push({ poNumber: poNum, status: "ERROR", error: msg });
              console.error(`[Approval] Failed to update PO ${poNum} in Xero:`, msg);
            }
          }
                } else if (allPoNumbers.length === 0) {
          console.log(`[Approval] No PO numbers found on invoice ${input.invoiceId} — skipping Xero PO update`);
        } else {
          console.warn(`[Approval] XERO_CLIENT_ID or XERO_CLIENT_SECRET not set — skipping Xero PO update`);
        }

                // Refresh xeroPoResults in DB so UI shows updated match amounts immediately after approve
        if (clientId && clientSecret && allPoNumbers.length > 0) {
          await refreshXeroPoResults(input.invoiceId, clientId, clientSecret);
        }
        // Re-fetch the invoice to get the fresh xeroPoResults that refreshXeroPoResults just wrote
        const updatedInvoiceAdmin = await getInvoiceById(input.invoiceId);
        // ── 4. Log the result ─────────────────────────────────────────────────
        const xeroSummary = xeroUpdateResults.length > 0
          ? ` Xero PO updates: ${xeroUpdateResults.map(r => `${r.poNumber}=${r.status}${r.error ? ` (${r.error})` : ""}`).join(", ")}`
          : "";

        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: `Invoice approved by admin (${ctx.user.name ?? "admin"}).${input.notes ? ` Notes: ${input.notes}` : ""}${xeroSummary}`,
          metadata: { approvedBy: ctx.user.id, approvedAt: new Date().toISOString(), xeroUpdateResults },
        });

        const xeroErrors = xeroUpdateResults.filter(r => r.status === "ERROR");
        return {
                    success: true,
          xeroUpdateResults,
          xeroPoResults: (updatedInvoiceAdmin as any)?.xeroPoResults ?? null,
          xeroWarning: xeroErrors.length > 0
            ? xeroErrors.map(r => r.error ?? `PO ${r.poNumber} update failed`).join("; ")
            : undefined,
        };
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
        if (newQueryCount > 5) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Maximum of 5 queries per invoice has been reached." });
        }
        const newStatus =
          newQueryCount === 1 ? "queried" :
          newQueryCount === 2 ? "queried_2nd" :
          newQueryCount === 3 ? "queried_3rd" :
          newQueryCount === 4 ? "queried_4th" :
          "queried_5th";

        // Build thread history from previous emails for this invoice
        const previousEmails = await getEmailLogsByInvoice(input.invoiceId);
        // previousEmails is newest-first; reverse for chronological order
        const threadHistory = [...previousEmails].reverse();
        let bodyWithHistory = input.body;
        if (threadHistory.length > 0) {
          const historyLines: string[] = [
            "",
            "---",
            "Previous correspondence:",
            "",
          ];
          for (const email of threadHistory) {
            const sentDate = email.sentAt ? new Date(email.sentAt).toLocaleString() : "unknown date";
            historyLines.push(`On ${sentDate}, we wrote:`);
            historyLines.push(email.body);
            if (email.replyBody) {
              const replyDate = email.repliedAt ? new Date(email.repliedAt).toLocaleString() : "unknown date";
              historyLines.push(`On ${replyDate}, supplier replied:`);
              historyLines.push(email.replyBody);
            }
            historyLines.push("");
          }
          bodyWithHistory = input.body + "\n" + historyLines.join("\n");
        }

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
            body: bodyWithHistory,
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
          body: bodyWithHistory,
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
          if (newQueryCount > 5) continue; // Skip invoices that have reached the 5-query limit
          const newStatus =
            newQueryCount === 1 ? "queried" :
            newQueryCount === 2 ? "queried_2nd" :
            newQueryCount === 3 ? "queried_3rd" :
            newQueryCount === 4 ? "queried_4th" :
            "queried_5th";
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
    // If PO numbers exist: use convertPOsToBill to create bill from PO line items
    // Otherwise: use createXeroDraftBill to create from scratch
    resolve: protectedProcedure
      .input(
        z.object({
          invoiceId: z.number(),
          resolutionNotes: z.string().optional(),
          pushToXero: z.boolean().default(true),
          forceCreateNew: z.boolean().default(false),
          selectedXeroContactId: z.string().optional(),
          contactSelectionApproved: z.boolean().default(false),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });

        // ── Workflow guard ───────────────────────────────────────────────────────
        // Normal path: must be approved before resolving/pushing
        // Exception: Admin can push no-PO invoices under $500 (GST-inclusive) directly
        const approvedStatuses = ["approved", "resolved"];
        const extractedPoNumbersJson = (invoice as any).extractedPoNumbers as string[] | null;
        const primaryPo = invoice.extractedPoNumber;
        const hasPoNumbers = (extractedPoNumbersJson && extractedPoNumbersJson.length > 0) || !!primaryPo;
        const invoiceTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");
        const isAdminNoPo = ctx.user.role === "admin" && !hasPoNumbers && invoiceTotal < 500;

        if (!approvedStatuses.includes(invoice.status as string) && !isAdminNoPo) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invoice must be approved before it can be resolved and pushed to Xero.",
          });
        }

        let xeroResult: { invoiceId: string; invoiceNumber: string } | null = null;
        let xeroStatus: "DRAFT" | "SUBMITTED" | "AUTHORISED" = "SUBMITTED";
        // Collect all PO numbers up front (used for reference field and marking as Billed)
        // Manual PO list takes priority — do not merge raw data scan
        const rawData = invoice.extractedRawData as any;
        const allPoNumbers: string[] = extractedPoNumbersJson && extractedPoNumbersJson.length > 0
          ? Array.from(new Set(extractedPoNumbersJson.map(p => p.trim()).filter(Boolean)))
          : primaryPo
            ? [primaryPo]
            : Array.from(new Set(extractAllPoNumbers(rawData ?? {}))).filter(Boolean);

        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;

        if (input.pushToXero) {
          console.log(`[Resolve] pushToXero=true, clientId=${clientId ? clientId.slice(0,8)+"..." : "MISSING"}, clientSecret=${clientSecret ? "set" : "MISSING"}`);

          if (clientId && clientSecret) {
            const supplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;
            const lineItems = await getLineItemsByInvoice(input.invoiceId);

            // Determine the Xero bill status based on invoice approval state and paid detection:
            // Rule 3: verified or under_budget → AUTHORISED (= AWAITING PAYMENT in Xero UI)
            // Rule 4: admin-approved (no PO / manually approved) → SUBMITTED (= AWAITING APPROVAL in Xero UI)
            // Rule 5: invoice appears paid (paid date present, zero balance, or status=paid) → AUTHORISED
            const invoiceStatus = invoice.status as string;
            const extractedTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");
            const hasPaidDate = !!(invoice as any).extractedPaymentDate;
            const hasZeroBalance = extractedTotal === 0;
            const isPaidStatus = invoiceStatus === "paid";
            const isPaid = hasPaidDate || hasZeroBalance || isPaidStatus;

            if (isPaid || invoiceStatus === "verified" || invoiceStatus === "under_budget") {
              xeroStatus = "AUTHORISED";
            } else {
              xeroStatus = "SUBMITTED";
            }

            // Resolve the Xero contact safely. Ambiguous results must be selected and
            // explicitly approved by the user before a bill can be sent to Xero.
            const supplierName = supplier?.name ?? invoice.extractedSupplierName ?? "Unknown Supplier";
            const supplierEmail = supplier?.email ?? invoice.extractedSupplierEmail ?? null;
            const contactResolution = await resolveXeroSupplierContact({
              supplierName,
              supplierEmail,
              savedContactId: supplier?.xeroContactId ?? null,
              clientId,
              clientSecret,
            });

            let xeroContactId: string | null = null;
            if (contactResolution.status === "matched") {
              xeroContactId = contactResolution.contact.contactId;
            } else if (contactResolution.status === "create_new") {
              xeroContactId = await createXeroSupplierContact({
                supplierName,
                supplierEmail,
                supplierAbn: supplier?.abn ?? invoice.extractedSupplierAbn ?? null,
                clientId,
                clientSecret,
              });
              if (!xeroContactId) {
                throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Xero could not create the supplier contact." });
              }
            } else if (contactResolution.status === "needs_selection") {
              const selected = contactResolution.candidates.find(
                (candidate) => candidate.contactId === input.selectedXeroContactId
              );
              if (!selected || !input.contactSelectionApproved) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: `Supplier contact approval is required: ${contactResolution.message}`,
                });
              }
              xeroContactId = selected.contactId;
            } else {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "Xero contact search is unavailable. No new supplier contact was created.",
              });
            }

            // Persist the approved/resolved Xero Contact ID for future invoices from this supplier.
            if (supplier?.id && xeroContactId && supplier.xeroContactId !== xeroContactId) {
              await updateSupplier(supplier.id, { xeroContactId });
            }

            console.log(`[Resolve] PO numbers: ${allPoNumbers.join(", ") || "none"}, xeroStatus=${xeroStatus}`);

            try {
              if (allPoNumbers.length > 0) {
                // Convert existing POs into a bill (preferred path)
                console.log(`[Resolve] Using convertPOsToBill for ${allPoNumbers.length} PO(s)`);
                xeroResult = await convertPOsToBill(
                  {
                    poNumbers: allPoNumbers,
                    supplierName: supplier?.name ?? invoice.extractedSupplierName ?? "Unknown Supplier",
                    supplierXeroContactId: xeroContactId ?? undefined,
                    invoiceNumber: invoice.extractedInvoiceNumber ?? `AP-${input.invoiceId}`,
                    invoiceDate: invoice.extractedInvoiceDate ?? new Date().toISOString().split("T")[0],
                    dueDate: invoice.extractedDueDate ?? undefined,
                    currencyCode: "AUD",
                    xeroStatus,
                    forceCreateNew: input.forceCreateNew,
                  },
                  clientId,
                  clientSecret
                );
              } else {
                // No POs — create bill from scratch
                const xeroLineItems = lineItems.length > 0
                  ? lineItems.map((li) => ({
                      description: li.description ?? "Service",
                      quantity: parseFloat(li.quantity?.toString() ?? "1"),
                      unitAmount: parseFloat(li.unitPrice?.toString() ?? li.amount?.toString() ?? "0"),
                      accountCode: li.accountCode ?? "429",
                    }))
                  : [{
                      description: `Invoice ${invoice.extractedInvoiceNumber ?? "N/A"}`,
                      quantity: 1,
                      unitAmount: extractedTotal,
                      accountCode: "429",
                    }];

                console.log(`[Resolve] Using createXeroDraftBill (no POs), lineItems=${xeroLineItems.length}`);
                xeroResult = await createXeroDraftBill(
                  {
                    supplierXeroContactId: xeroContactId ?? undefined,
                    supplierName: supplier?.name ?? invoice.extractedSupplierName ?? "Unknown Supplier",
                    invoiceNumber: invoice.extractedInvoiceNumber ?? `AP-${input.invoiceId}`,
                    invoiceDate: invoice.extractedInvoiceDate ?? new Date().toISOString().split("T")[0],
                    dueDate: invoice.extractedDueDate ?? undefined,
                    lineItems: xeroLineItems,
                    currencyCode: "AUD",
                    xeroStatus,
                    forceCreateNew: input.forceCreateNew,
                  },
                  clientId,
                  clientSecret
                );
              }
              console.log(`[Resolve] Xero bill result: ${xeroResult ? JSON.stringify(xeroResult) : "null"}`);
            } catch (xeroErr: any) {
              console.error(`[Resolve] Xero push failed:`, xeroErr.message);
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `Failed to push bill to Xero: ${xeroErr.message}`,
              });
            }

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
          pdfAttachedToXero: false, // will be updated after attachment attempt
        });

        // ── Upload original invoice PDF as attachment to the Xero bill ────────────
        let attachmentUploaded = false;
        let attachmentError: string | undefined;
        // Derive the actual storage key: fileKey is the correct key for new invoices.
        // For invoices uploaded before the hash-suffix fix, fall back to stripping /manus-storage/ from fileUrl.
        const resolvedAttachKey = invoice.fileKey && !invoice.fileKey.startsWith("/manus-storage/")
          ? invoice.fileKey
          : invoice.fileUrl?.replace(/^\/manus-storage\//, "") ?? "";
        if (xeroResult?.invoiceId && resolvedAttachKey && clientId && clientSecret) {
          try {
            const signedUrl = await storageGetSignedUrl(resolvedAttachKey);
            const fileName = (invoice as any).originalFileName ?? `invoice-${invoice.id}.pdf`;
            const attachResult = await uploadXeroBillAttachment({
              clientId,
              clientSecret,
              xeroInvoiceId: xeroResult.invoiceId,
              fileName,
              fileUrl: signedUrl,
              mimeType: "application/pdf",
            });
            attachmentUploaded = attachResult.success;
            if (attachResult.success) {
              // Persist successful attachment flag
              await updateInvoice(input.invoiceId, { pdfAttachedToXero: true } as any);
            } else {
              attachmentError = attachResult.error;
              console.error(`[Resolve] PDF attachment upload failed:`, attachResult.error);
            }
          } catch (attachErr: any) {
            attachmentError = attachErr?.message;
            console.error(`[Resolve] PDF attachment upload exception:`, attachErr?.message);
          }
        }

        const xeroStatusLabel = xeroStatus === "AUTHORISED" ? "AWAITING PAYMENT" : "AWAITING APPROVAL";
        const attachmentNote = xeroResult?.invoiceId
          ? (attachmentUploaded ? " PDF invoice attached to Xero bill." : attachmentError ? ` PDF attachment failed: ${attachmentError}` : "")
          : "";

        await createConversationNote({
          invoiceId: input.invoiceId,
          authorId: ctx.user.id,
          type: "status_change",
          content: xeroResult
            ? `Invoice resolved. Bill created in Xero as ${xeroStatusLabel}: ${xeroResult.invoiceNumber}${allPoNumbers.length > 0 ? `. POs marked as Billed: ${allPoNumbers.join(", ")}` : ""}.${attachmentNote} ${input.resolutionNotes ?? ""}`
            : `Invoice resolved. ${input.resolutionNotes ?? ""}`,
          metadata: { xeroResult, poNumbers: allPoNumbers, xeroStatus, attachmentUploaded, attachmentError },
        });

        // Archive the invoice immediately (will be auto-deleted after 90 days)
        await updateInvoice(input.invoiceId, { archivedAt: new Date() } as any);

        return { success: true, xeroResult, attachmentUploaded, attachmentError };
      }),

    // Re-attach invoice PDF to an already-resolved Xero bill (retry for failed attachments)
    reattachPdf: protectedProcedure
      .input(z.object({ invoiceId: z.number() }))
      .mutation(async ({ input }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
        if (invoice.status !== "resolved") throw new TRPCError({ code: "BAD_REQUEST", message: "Invoice is not resolved" });
        const xeroInvoiceId = (invoice as any).xeroFinalBillId;
        if (!xeroInvoiceId) throw new TRPCError({ code: "BAD_REQUEST", message: "No Xero bill ID on this invoice" });

        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;
        if (!clientId || !clientSecret) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Xero credentials not configured" });

        const resolvedAttachKey = (invoice as any).fileKey && !(invoice as any).fileKey.startsWith("/manus-storage/")
          ? (invoice as any).fileKey
          : (invoice as any).fileUrl?.replace(/^\/manus-storage\//, "") ?? "";
        if (!resolvedAttachKey) throw new TRPCError({ code: "BAD_REQUEST", message: "No file key for this invoice" });

        const signedUrl = await storageGetSignedUrl(resolvedAttachKey);
        const fileName = (invoice as any).originalFileName ?? `invoice-${invoice.id}.pdf`;
        const attachResult = await uploadXeroBillAttachment({
          clientId,
          clientSecret,
          xeroInvoiceId,
          fileName,
          fileUrl: signedUrl,
          mimeType: "application/pdf",
        });

        if (attachResult.success) {
          await updateInvoice(input.invoiceId, { pdfAttachedToXero: true } as any);
        }

        return { success: attachResult.success, error: attachResult.error };
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
          poNumber: z.string().optional().nullable(),
          // Set to true when the user manually edits the PO number field
          poNumberEdited: z.boolean().optional(),
          custRef: z.string().optional().nullable(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateLineItem(id, data as any);
        return { success: true };
      }),

    // Delete invoice (any authenticated active user). Disabled users are rejected
    // by protectedProcedure before this irreversible operation can run.
    delete: protectedProcedure
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
      const scope = token?.scope ?? null;
      const hasAttachmentsScope = scope ? scope.includes("accounting.attachments") : false;
      const rateLimitPausedUntil = token?.rateLimitPausedUntil ?? null;
      const rateLimitActive = !!rateLimitPausedUntil && rateLimitPausedUntil.getTime() > Date.now();
      return {
        connected: !!token,
        tenantName: token?.tenantName ?? null,
        expiresAt: token?.expiresAt ?? null,
        scope,
        hasAttachmentsScope,
        rateLimit: {
          active: rateLimitActive,
          problem: token?.rateLimitProblem ?? null,
          pausedUntil: rateLimitPausedUntil,
          retryAfterSeconds: token?.rateLimitRetryAfterSeconds ?? null,
          minuteRemaining: token?.rateLimitMinuteRemaining ?? null,
          dayRemaining: token?.rateLimitDayRemaining ?? null,
          updatedAt: token?.rateLimitUpdatedAt ?? null,
        },
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

    resolveSupplierContact: protectedProcedure
      .input(z.object({
        supplierName: z.string().trim().min(1),
        supplierEmail: z.string().email().nullable().optional(),
        savedContactId: z.string().nullable().optional(),
      }))
      .query(async ({ input }) => {
        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return { status: "unavailable" as const, candidates: [], message: "Xero credentials are not configured." };
        }
        return resolveXeroSupplierContact({
          supplierName: input.supplierName,
          supplierEmail: input.supplierEmail ?? null,
          savedContactId: input.savedContactId ?? null,
          clientId,
          clientSecret,
        });
      }),

    createSupplierContact: protectedProcedure
      .input(z.object({ invoiceId: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const invoice = await getInvoiceById(input.invoiceId);
        if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });

        const supplier = invoice.supplierId ? await getSupplierById(invoice.supplierId) : null;
        const supplierName = supplier?.name ?? invoice.extractedSupplierName ?? "";
        const supplierEmail = supplier?.email ?? invoice.extractedSupplierEmail ?? null;
        const supplierAbn = supplier?.abn ?? invoice.extractedSupplierAbn ?? null;
        if (!supplierName.trim()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "A supplier name is required before creating a Xero contact." });
        }

        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Xero credentials are not configured." });
        }

        // Always re-resolve inside the mutation so a stale UI result cannot create
        // a duplicate contact after someone has added one directly in Xero.
        const resolution = await resolveXeroSupplierContact({
          supplierName,
          supplierEmail,
          savedContactId: supplier?.xeroContactId ?? null,
          clientId,
          clientSecret,
        });
        if (resolution.status === "unavailable") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: resolution.message });
        }
        if (resolution.status === "needs_selection") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Xero now has possible supplier contacts. Select and approve the correct contact instead of creating another one.",
          });
        }

        const contactId = resolution.status === "matched"
          ? resolution.contact.contactId
          : await createXeroSupplierContact({ supplierName, supplierEmail, supplierAbn, clientId, clientSecret });
        if (!contactId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Xero could not create the supplier contact." });
        }
        if (supplier?.id && supplier.xeroContactId !== contactId) {
          await updateSupplier(supplier.id, { xeroContactId: contactId });
        }
        return {
          success: true,
          contactId,
          created: resolution.status === "create_new",
          contactName: supplierName,
        };
      }),

    /**
     * Check if a bill with the given invoice number already exists in Xero
     * under a DIFFERENT supplier. Used to warn before pushing to Xero.
     * Returns null if no conflict, or the conflicting bill details.
     */
    checkInvoiceNumberConflict: protectedProcedure
      .input(z.object({
        invoiceNumber: z.string(),
        supplierName: z.string(),
      }))
      .query(async ({ input }) => {
        const clientId = process.env.XERO_CLIENT_ID;
        const clientSecret = process.env.XERO_CLIENT_SECRET;
        if (!clientId || !clientSecret) return null;
        try {
          const result = await checkXeroBillDuplicate(
            input.invoiceNumber,
            input.supplierName,
            clientId,
            clientSecret
          );
          if (!result) return null;
          // Only flag as a conflict if the supplier name does NOT match
          if (result.supplierNameMatch) return null;
          const statusLabel: Record<string, string> = {
            DRAFT: "Draft",
            SUBMITTED: "Awaiting Approval",
            AUTHORISED: "Awaiting Payment",
            PAID: "Paid",
            VOIDED: "Voided",
          };
          return {
            conflictingSupplier: result.nameInXero,
            amount: result.bill.total,
            status: statusLabel[result.bill.status] ?? result.bill.status,
            invoiceNumber: input.invoiceNumber,
          };
        } catch {
          return null;
        }
      }),
  }),

  // ─── Reports ─────────────────────────────────────────────────────────────────
  reports: router({
    poVariance: protectedProcedure.query(async () => {
      const allRows = await getPoVarianceReport();
      // Only show invoices that have been explicitly approved or resolved
      const rows = allRows.filter((r) =>
        ["approved", "resolved"].includes(r.status ?? "")
      );
      return rows.map((r) => {
        const poResults: any[] = Array.isArray(r.xeroPoResults) ? r.xeroPoResults : [];
        // originalPoAmounts: { [poNumber]: originalPOAmount } stored at first verification
        const origAmounts = (r.originalPoAmounts as Record<string, number> | null) ?? {};
        const poBreakdown = poResults
          .filter((p) => p.found && !p.alreadyBilled)
          .map((p) => {
            // Use original PO amount as the baseline for variance (if available)
            const originalPoAmount = origAmounts[p.poNumber as string] ?? (p.poTotal as number);
            const finalBilled = (p.invoiceLineItemTotal ?? p.poTotal) as number;
            const varianceDiff = Math.round((finalBilled - originalPoAmount) * 100) / 100;
            return {
              poNumber: p.poNumber as string,
              originalPoAmount,
              poTotal: p.poTotal as number, // current PO total in Xero (may have changed)
              invoiceLineItemTotal: (p.invoiceLineItemTotal ?? null) as number | null,
              rawDiff: (p.rawDiff ?? 0) as number,
              varianceDiff, // finalBilled - originalPoAmount (the key variance figure)
              overBilled: varianceDiff > 0,
              underBilled: varianceDiff < 0,
            };
          });
        // Compute original PO total baseline from stored originalPoAmounts
        const originalPoTotal = Object.keys(origAmounts).length > 0
          ? Object.values(origAmounts).reduce((s, v) => s + v, 0)
          : poBreakdown.length > 0
            ? poBreakdown.reduce((s, p) => s + p.originalPoAmount, 0)
            : r.xeroTotal != null ? parseFloat(r.xeroTotal.toString()) : null;
        const finalBilledTotal = r.extractedTotal != null ? parseFloat(r.extractedTotal.toString()) : null;
        const totalVariance = originalPoTotal != null && finalBilledTotal != null
          ? Math.round((finalBilledTotal - originalPoTotal) * 100) / 100
          : r.totalNetDiff != null ? parseFloat(r.totalNetDiff.toString()) : 0;
        return {
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber,
          supplierName: r.supplierName,
          invoiceDate: r.invoiceDate,
          status: r.status,
          extractedTotal: finalBilledTotal,
          originalPoTotal: originalPoTotal != null ? Math.round(originalPoTotal * 100) / 100 : null,
          xeroTotal: poBreakdown.length > 0
            ? Math.round(poBreakdown.reduce((s, p) => s + p.poTotal, 0) * 100) / 100
            : r.xeroTotal != null ? Math.round(parseFloat(r.xeroTotal.toString()) * 100) / 100 : null,
          totalVariance, // final billed - original PO amount (the key variance figure)
          totalNetDiff: r.totalNetDiff != null ? Math.round(parseFloat(r.totalNetDiff.toString()) * 100) / 100 : 0,
          poBreakdown,
          staffApproved: r.staffApproved,
          adminApproved: r.adminApproved,
          approvedAt: r.adminApprovedAt ?? r.staffApprovedAt,
        };
      });
    }),
  }),

  // ─── PO Requests (Vtiger → Xero) ─────────────────────────────────────────────
  poRequests: router({
    list: protectedProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
      )
      .query(async ({ input }) => {
        const db = await (await import("./db")).getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const rows = await db
          .select()
          .from(poRequests)
          .orderBy(desc(poRequests.createdAt))
          .limit(input.limit)
          .offset(input.offset);
        return rows;
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const db = await (await import("./db")).getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const rows = await db.select().from(poRequests).where(eq(poRequests.id, input.id)).limit(1);
        if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "PO request not found" });
        return rows[0];
      }),

    retry: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await (await import("./db")).getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const rows = await db.select().from(poRequests).where(eq(poRequests.id, input.id)).limit(1);
        if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "PO request not found" });
        const row = rows[0];
        if (!row.rawPayload) throw new TRPCError({ code: "BAD_REQUEST", message: "No payload to retry" });

        await db.update(poRequests).set({ status: "processing", errorMessage: null }).where(eq(poRequests.id, input.id));

        setImmediate(async () => {
          try {
            const { processVtigerWebhook } = await import("./vtigerPoService");
            const result = await processVtigerWebhook(row.rawPayload as Record<string, any>);
            await db!.update(poRequests).set({
              status: result.overallStatus,
              vtigerDealNumber: result.dealNumber,
              poResults: result.poResults as any,
              processedAt: new Date(),
            }).where(eq(poRequests.id, input.id));
          } catch (err: any) {
            await db!.update(poRequests).set({
              status: "failed",
              errorMessage: err.message,
              processedAt: new Date(),
            }).where(eq(poRequests.id, input.id));
          }
        });

        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
