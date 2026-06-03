import nodemailer from "nodemailer";
import { createEmailLog, createConversationNote, updateEmailLogStatus } from "./db";

export interface SendEmailOptions {
  invoiceId: number;
  sentBy: number;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromAddress?: string;
}

const FROM_ADDRESS = "admin@containerzone.com.au";

export async function sendDisputeEmail(opts: SendEmailOptions): Promise<{ success: boolean; emailLogId: number; error?: string }> {
  // Create log entry first (pending)
  const emailLogId = await createEmailLog({
    invoiceId: opts.invoiceId,
    sentBy: opts.sentBy,
    fromAddress: opts.fromAddress ?? FROM_ADDRESS,
    toAddress: opts.to,
    ccAddress: opts.cc ?? null,
    subject: opts.subject,
    body: opts.body,
    status: "pending",
  });

  try {
    const transporter = nodemailer.createTransport({
      host: opts.smtpHost,
      port: opts.smtpPort,
      secure: opts.smtpPort === 465,
      auth: {
        user: opts.smtpUser,
        pass: opts.smtpPass,
      },
    });

    await transporter.sendMail({
      from: `"ContainerZone AP" <${opts.fromAddress ?? FROM_ADDRESS}>`,
      to: opts.to,
      cc: opts.cc,
      subject: opts.subject,
      html: opts.body.replace(/\n/g, "<br>"),
      text: opts.body,
    });

    await updateEmailLogStatus(emailLogId, "sent");

    // Add conversation note
    await createConversationNote({
      invoiceId: opts.invoiceId,
      authorId: opts.sentBy,
      type: "email_sent",
      content: `Email sent to ${opts.to}: "${opts.subject}"`,
      emailLogId,
    });

    return { success: true, emailLogId };
  } catch (error: any) {
    const errMsg = error?.message ?? "Unknown error";
    await updateEmailLogStatus(emailLogId, "failed", errMsg);
    return { success: false, emailLogId, error: errMsg };
  }
}

export function generateDisputeEmailTemplate(params: {
  supplierName: string;
  invoiceNumber: string;
  invoiceDate?: string | null;
  extractedTotal?: number | null;
  xeroTotal?: number | null;
  discrepancyAmount?: number | null;
  containerNumbers?: string[];
  poNumber?: string | null;
  senderName: string;
  queryPoints?: string[];
}): { subject: string; body: string } {
  const subject = `Invoice Query — ${params.invoiceNumber} — ${params.supplierName}`;

  const containerLine =
    params.containerNumbers && params.containerNumbers.length > 0
      ? `\nContainer Number(s): ${params.containerNumbers.join(", ")}`
      : "";

  const poLine = params.poNumber ? `\nPO Number: ${params.poNumber}` : "";

  const discrepancyLine =
    params.extractedTotal != null && params.xeroTotal != null
      ? `\n\nUpon review, we have identified a discrepancy between the amount on your invoice (${formatCurrency(params.extractedTotal)}) and the amount recorded in our system (${formatCurrency(params.xeroTotal)}). The difference is ${formatCurrency(Math.abs(params.discrepancyAmount ?? params.extractedTotal - params.xeroTotal))}.`
      : "";

  const queryPointsSection =
    params.queryPoints && params.queryPoints.filter(Boolean).length > 0
      ? `\n\nWe have the following specific queries regarding this invoice:\n\n` +
        params.queryPoints
          .filter(Boolean)
          .map((point, i) => `${i + 1}. ${point}`)
          .join("\n")
      : "";

  const body = `Dear ${params.supplierName},

We are writing to query the following invoice:

Invoice Number: ${params.invoiceNumber}
Invoice Date: ${params.invoiceDate ?? "N/A"}${containerLine}${poLine}${discrepancyLine}${queryPointsSection}

Could you please review and provide clarification on the above at your earliest convenience? We would appreciate a response within 5 business days.

If you have any questions, please do not hesitate to contact us.

Kind regards,
${params.senderName}
ContainerZone
admin@containerzone.com.au`;

  return { subject, body };
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(amount);
}
