import { ENV } from "./_core/env";
import {
  createConversationNote,
  createEmailInvoiceSubmission,
  createInvoice,
  createLineItems,
  createSupplier,
  deleteLineItemsByInvoice,
  findMatchingSupplier,
  getFirstActiveAdmin,
  getEmailInvoiceSubmission,
  getInvoiceById,
  getUserByOpenId,
  updateEmailInvoiceSubmission,
  updateInvoice,
} from "./db";
import { extractAllPoNumbers, extractInvoiceData } from "./extractionService";
import { storagePut } from "./storage";
import type { GraphFileAttachment, GraphMessage } from "./microsoftGraphService";
import { reportWorkflowFailureSafely } from "./workflowAlertService";

const PO_PATTERN = /\b([A-Z]{1,2}\d{4,6})\b/g;

export function selectInboundInvoiceOwner<T extends { id: number }>(configuredOwner?: T, activeAdmin?: T): T | undefined {
  return configuredOwner ?? activeAdmin;
}

function invoicePoNumbers(extracted: Awaited<ReturnType<typeof extractInvoiceData>>): string[] {
  const matches = new Set(extractAllPoNumbers(extracted as any));
  for (const item of extracted.lineItems) {
    if (item.poNumber && /^[A-Z]{1,2}\d{4,6}$/.test(item.poNumber)) matches.add(item.poNumber);
    for (const text of [item.custRef, item.description]) {
      text?.match(PO_PATTERN)?.forEach((value) => matches.add(value));
    }
  }
  [extracted.invoiceNumber, extracted.notes].filter(Boolean).join(" ").match(PO_PATTERN)?.forEach((value) => matches.add(value));
  return Array.from(matches);
}

async function extractEmailInvoice(invoiceId: number, uploaderId: number) {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) throw new Error("Created invoice could not be read");
  const extracted = await extractInvoiceData(invoice.fileUrl);
  let supplier = await findMatchingSupplier(extracted.supplierName ?? undefined, extracted.supplierAbn ?? undefined, extracted.supplierEmail ?? undefined);
  if (!supplier && extracted.supplierName) {
    const supplierId = await createSupplier({
      name: extracted.supplierName,
      abn: extracted.supplierAbn ?? undefined,
      email: extracted.supplierEmail ?? undefined,
      phone: extracted.supplierPhone ?? undefined,
      address: extracted.supplierAddress ?? undefined,
      contactName: (extracted as any).supplierContactName ?? undefined,
      createdBy: uploaderId,
    });
    supplier = await findMatchingSupplier(extracted.supplierName, extracted.supplierAbn ?? undefined, extracted.supplierEmail ?? undefined);
    if (!supplier) throw new Error(`Created supplier ${supplierId} could not be retrieved`);
  }
  const poNumbers = invoicePoNumbers(extracted);
  await updateInvoice(invoiceId, {
    status: "extracted",
    extractedInvoiceNumber: extracted.invoiceNumber ?? undefined,
    extractedPoNumber: extracted.poNumber ?? poNumbers[0] ?? undefined,
    extractedPoNumbers: poNumbers.length ? poNumbers : undefined,
    extractedContainerNumbers: extracted.containerNumbers.length ? JSON.stringify(extracted.containerNumbers) : undefined,
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
    supplierId: supplier?.id,
  });
  if (extracted.lineItems.length) {
    await deleteLineItemsByInvoice(invoiceId);
    await createLineItems(extracted.lineItems.map((item) => ({
      invoiceId,
      description: item.description,
      quantity: item.quantity?.toString(),
      unitPrice: item.unitPrice?.toString(),
      amount: item.amount?.toString(),
      taxRate: item.taxRate?.toString(),
      poNumber: item.poNumber,
      custRef: item.custRef,
    })));
  }
}

export async function processMicrosoftEmailPdf(message: GraphMessage, attachment: GraphFileAttachment): Promise<{ invoiceId?: number; status: "processed" | "duplicate" | "ignored" }> {
  if (!message.id || !attachment.id || !attachment.name || !attachment.contentBytes) throw new Error("Microsoft Graph notification is missing attachment data");
  const existing = await getEmailInvoiceSubmission(message.id, attachment.id);
  if (existing) return { invoiceId: existing.invoiceId ?? undefined, status: "duplicate" };
  const owner = selectInboundInvoiceOwner(
    await getUserByOpenId(ENV.ownerOpenId),
    await getFirstActiveAdmin()
  );
  if (!owner) throw new Error("No active administrator is available for inbound invoice attribution");
  const submissionId = await createEmailInvoiceSubmission({
    graphMessageId: message.id,
    graphAttachmentId: attachment.id,
    internetMessageId: message.internetMessageId,
    senderName: message.from?.emailAddress?.name,
    senderAddress: message.from?.emailAddress?.address,
    recipientAddress: process.env.MICROSOFT_INVOICE_ALIAS ?? "",
    subject: message.subject,
    receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : undefined,
    attachmentName: attachment.name,
    attachmentMimeType: attachment.contentType,
    attachmentSize: attachment.size,
    status: "processing",
    metadata: { source: "microsoft-graph" },
  });
  try {
    const bytes = Buffer.from(attachment.contentBytes, "base64");
    const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const { key, url } = await storagePut(`invoices/email/${Date.now()}-${safeName}`, bytes, "application/pdf");
    const invoiceId = await createInvoice({ fileKey: key, fileUrl: url, originalFileName: attachment.name, status: "extracting", uploadedBy: owner.id });
    await createConversationNote({ invoiceId, authorId: owner.id, type: "system", content: `Invoice received by email from ${message.from?.emailAddress?.address ?? "unknown sender"}: ${attachment.name}` });
    await extractEmailInvoice(invoiceId, owner.id);
    await updateEmailInvoiceSubmission(submissionId, { status: "processed", invoiceId, processedAt: new Date() });
    return { invoiceId, status: "processed" };
  } catch (error: any) {
    await updateEmailInvoiceSubmission(submissionId, { status: "failed", errorMessage: error.message, processedAt: new Date() });
    reportWorkflowFailureSafely({
      workflowType: "microsoft-invoice-ingestion",
      recordKey: `email-submission:${submissionId}`,
      title: `Invoice email processing failed: ${attachment.name}`,
      errorMessage: error.message ?? "Inbound invoice PDF processing failed",
      details: { submissionId, messageId: message.id, attachmentName: attachment.name, subject: message.subject },
      severity: "error",
    });
    throw error;
  }
}
