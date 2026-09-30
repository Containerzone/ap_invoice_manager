import { useMemo } from "react";
import { CheckCircle2, CircleAlert, Clock3, RefreshCw, Send, Webhook } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type WebhookEvent = {
  id: number;
  routeKey: string;
  workflowType: string;
  sourceRecordId: string;
  sourceRecordNumber: string | null;
  status: "received" | "proposed" | "held" | "paused" | "duplicate" | "rejected" | "failed";
  errorMessage: string | null;
  receivedAt: Date | string;
};

type WriterExecution = {
  id: number;
  workflowType: string;
  proposedDocumentNumber: string;
  status: "prepared" | "blocked" | "submitted" | "succeeded" | "failed" | "reconciliation_required";
  xeroDocumentStatus: string | null;
  errorMessage: string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
};

type AutomationSettings = {
  proposalWebhook?: { configured: boolean };
};

type TriggerGroup = {
  label: string;
  workflowType: string;
  routeKeys: string[];
};

/** The ten operational triggers requested by ContainerZone. */
const TRIGGERS: TriggerGroup[] = [
  { label: "Container Control acquisition", workflowType: "container_control_acquisition", routeKeys: ["container-control-acquisition"] },
  { label: "Recurring For Hire", workflowType: "recurring_for_hire", routeKeys: ["recurring-for-hire"] },
  { label: "Storage activation", workflowType: "storage_activation", routeKeys: ["storage-origin-activation", "storage-destination-activation"] },
  { label: "Recurring storage", workflowType: "recurring_storage", routeKeys: ["recurring-storage"] },
  { label: "Storage finalisation", workflowType: "storage_finalisation", routeKeys: ["storage-finalisation"] },
  { label: "Main customer invoice", workflowType: "main_customer_invoice", routeKeys: ["main-customer-invoice"] },
  { label: "Deposit invoice", workflowType: "deposit_invoice", routeKeys: ["deposit-invoice"] },
  { label: "Final weight adjustment", workflowType: "final_weight_adjustment", routeKeys: ["overweight-adjustment", "underweight-due-date"] },
  { label: "Extra Hire", workflowType: "extra_hire", routeKeys: ["extra-hire"] },
  { label: "Warranty reconciliation", workflowType: "warranty_reconciliation", routeKeys: ["warranty-reconciliation"] },
];

function dateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

function badgeClass(tone: "waiting" | "proposal" | "draft" | "hold" | "failure") {
  if (tone === "draft") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (tone === "proposal") return "border-sky-200 bg-sky-50 text-sky-800";
  if (tone === "hold" || tone === "waiting") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-red-200 bg-red-50 text-red-800";
}

function latest<T extends { id: number; createdAt?: Date | string; receivedAt?: Date | string }>(rows: T[]) {
  return [...rows].sort((left, right) => {
    const leftTime = new Date(left.createdAt ?? left.receivedAt ?? 0).getTime();
    const rightTime = new Date(right.createdAt ?? right.receivedAt ?? 0).getTime();
    return rightTime - leftTime || right.id - left.id;
  })[0] ?? null;
}

/**
 * Simple operational dashboard. All ten requested business triggers appear as
 * one row each, while the server keeps the route authentication, source/Xero
 * preflight, approval and Draft-only protections outside the browser.
 */
export function FinancialWebhookInterface() {
  const settings = trpc.financialOperations.automationSettings.useQuery();
  const events = trpc.financialOperations.webhookEvents.useQuery({ limit: 100 });
  const executions = trpc.financialOperations.writerExecutions.useQuery({ limit: 100 });
  const webhookEvents = (events.data ?? []) as WebhookEvent[];
  const writerExecutions = (executions.data ?? []) as WriterExecution[];
  const routeConnected = Boolean((settings.data as AutomationSettings | undefined)?.proposalWebhook?.configured);

  const rows = useMemo(() => TRIGGERS.map((trigger) => {
    const event = latest(webhookEvents.filter((candidate) => trigger.routeKeys.includes(candidate.routeKey)));
    const execution = latest(writerExecutions.filter((candidate) => candidate.workflowType === trigger.workflowType));
    const draftVerified = execution?.status === "succeeded" && execution.xeroDocumentStatus === "DRAFT";
    if (draftVerified) return { trigger, event, execution, label: "Draft created", tone: "draft" as const, detail: execution.proposedDocumentNumber };
    if (execution?.status === "failed" || execution?.status === "reconciliation_required") return { trigger, event, execution, label: "Xero check required", tone: "failure" as const, detail: execution.errorMessage ?? execution.proposedDocumentNumber };
    if (event && ["held", "paused", "rejected", "failed"].includes(event.status)) return { trigger, event, execution, label: "Held for review", tone: "hold" as const, detail: event.errorMessage ?? "No Xero Draft was sent" };
    if (event?.status === "proposed") return { trigger, event, execution, label: "Proposal ready", tone: "proposal" as const, detail: "Awaiting named Draft approval" };
    if (event) return { trigger, event, execution, label: "Event received", tone: "proposal" as const, detail: "AP is processing the event" };
    return { trigger, event, execution, label: routeConnected ? "Waiting for VTiger" : "Webhook not connected", tone: "waiting" as const, detail: routeConnected ? "No event received" : "No authenticated event route is configured" };
  }), [routeConnected, webhookEvents, writerExecutions]);

  const refresh = () => void Promise.all([settings.refetch(), events.refetch(), executions.refetch()]);

  return <div className="space-y-4">
    <Card className="border-sky-200 bg-sky-50/60">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><CardTitle className="flex items-center gap-2 text-sky-950"><Webhook className="h-5 w-5" />Financial Trigger Dashboard</CardTitle><p className="mt-1 text-sm text-sky-900">Each VTiger trigger follows the same path: <strong>VTiger event → AP validation → Xero Draft → tracked below</strong>.</p></div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={events.isFetching || executions.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${events.isFetching || executions.isFetching ? "animate-spin" : ""}`} />Refresh</Button>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 text-xs"><Badge className={badgeClass(routeConnected ? "proposal" : "waiting")}>{routeConnected ? "Webhook connection ready" : "Webhook connection not configured"}</Badge><Badge variant="outline">Xero creates Drafts only</Badge><Badge variant="outline">No financial schedules enabled</Badge><Badge variant="outline">Events are tracked automatically</Badge></CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle className="text-base">Trigger status</CardTitle><p className="mt-1 text-sm text-muted-foreground">Green means Xero read-back confirmed a Draft. Blue means a proposal is ready. Amber means waiting or safely held. Red needs attention.</p></CardHeader>
      <CardContent>{events.isLoading || executions.isLoading ? <Skeleton className="h-96" /> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">VTiger trigger</th><th className="p-3">Latest source event</th><th className="p-3">Xero Draft</th><th className="p-3">Current status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.trigger.workflowType} className="border-b align-top last:border-0"><td className="p-3 font-medium">{row.trigger.label}</td><td className="p-3 text-xs">{row.event ? <><span className="font-mono">{row.event.sourceRecordNumber ?? row.event.sourceRecordId}</span><br /><span className="text-muted-foreground">{dateTime(row.event.receivedAt)}</span></> : <span className="text-muted-foreground">No event yet</span>}</td><td className="p-3 text-xs">{row.execution ? <><span className="font-mono">{row.execution.proposedDocumentNumber}</span><br /><span className="text-muted-foreground">{row.execution.xeroDocumentStatus ?? row.execution.status}</span></> : <span className="text-muted-foreground">No Draft yet</span>}</td><td className="p-3"><Badge className={badgeClass(row.tone)}>{row.label}</Badge><p className="mt-1 max-w-sm text-xs text-muted-foreground">{row.detail}</p></td></tr>)}</tbody></table></div>}</CardContent>
    </Card>

    <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground"><Clock3 className="mr-2 inline h-4 w-4" />When a trigger arrives, this page updates with the source reference and then the Xero Draft number. A held trigger has not created a Xero document.</div>
    <details className="rounded-lg border bg-muted/20 p-4 text-sm"><summary className="cursor-pointer font-medium"><CircleAlert className="mr-2 inline h-4 w-4" />How Draft creation stays safe</summary><p className="mt-3 text-muted-foreground">The server validates the current source and Xero state, requires a named document approval, creates only a Draft, and then reads the exact Xero document back before showing it as created. The browser cannot write to Xero or change VTiger.</p></details>
  </div>;
}
