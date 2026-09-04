import { ENV } from "./_core/env";
import {
  recordWorkflowFailure,
  type WorkflowFailureInput,
  updateWorkflowFailureAlertAttempt,
} from "./db";
import { sendOperationalAlertEmail } from "./emailService";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Parses the private comma-separated recipient configuration without exposing it to clients. */
export function getWorkflowAlertRecipients(rawRecipients = ENV.workflowAlertRecipients): string[] {
  return Array.from(new Set(
    rawRecipients
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => EMAIL_PATTERN.test(value)),
  ));
}

export function getWorkflowAlertRecipientCount(): number {
  return getWorkflowAlertRecipients().length;
}

function formatDetails(details?: Record<string, unknown>): string {
  if (!details || Object.keys(details).length === 0) return "";
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return entries.length ? `\n\nDetails:\n${entries.join("\n")}` : "";
}

/**
 * Persists the failure first, then sends one immediate alert per active failure
 * window. Alert delivery failures are retained on the same failure record.
 */
export async function reportWorkflowFailure(input: WorkflowFailureInput): Promise<void> {
  const { failure, shouldAlert } = await recordWorkflowFailure(input);
  if (!shouldAlert) return;

  const recipients = getWorkflowAlertRecipients();
  const body = [
    "ContainerZone AP Invoice Manager has recorded an operational workflow failure.",
    "",
    `Workflow: ${failure.workflowType}`,
    `Record: ${failure.recordKey}`,
    `Occurred: ${failure.lastOccurredAt.toISOString()}`,
    `Error: ${failure.errorMessage}`,
    formatDetails((failure.details ?? undefined) as Record<string, unknown> | undefined),
    "",
    "Open the Operational Failures page in the AP Invoice Manager to review and resolve this alert.",
  ].filter(Boolean).join("\n");
  const delivery = await sendOperationalAlertEmail({
    recipients,
    subject: `AP workflow failure: ${failure.title}`,
    body,
  });
  await updateWorkflowFailureAlertAttempt(failure.id, delivery.success ? undefined : delivery.error);
}

/** Failure reporting must never mask or interrupt the workflow error it records. */
export function reportWorkflowFailureSafely(input: WorkflowFailureInput): void {
  void reportWorkflowFailure(input).catch((error: any) => {
    console.error("[Workflow Alert] Could not record a workflow failure:", error?.message ?? error);
  });
}
