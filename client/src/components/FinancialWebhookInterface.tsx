import { useMemo } from "react";
import { Activity, CheckCircle2, CircleAlert, Clock3, FileCheck2, LockKeyhole, RefreshCw, Send, Webhook } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type WebhookEvent = {
  id: number;
  eventId: string;
  routeKey: string;
  workflowType: string;
  sourceEntityType: string;
  sourceRecordId: string;
  sourceRecordNumber: string | null;
  status: "received" | "proposed" | "held" | "paused" | "duplicate" | "rejected" | "failed";
  workflowRunId: number | null;
  errorMessage: string | null;
  receivedAt: Date | string;
};

type WriterExecution = {
  id: number;
  workflowType: string;
  proposedDocumentNumber: string;
  documentFamily: "purchase_order" | "customer_invoice";
  status: "prepared" | "blocked" | "submitted" | "succeeded" | "failed" | "reconciliation_required";
  xeroDocumentId: string | null;
  xeroDocumentStatus: string | null;
  errorMessage: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
};

type AutomationSettings = {
  proposalWebhook?: { configured: boolean; financialWritePermitted: boolean; schedulesRegistered: boolean };
  writer?: { environmentLock: string; globalShadowMode: boolean; invocationRouteRegistered: boolean };
};

function dateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

function titleize(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function badgeClass(tone: "ready" | "waiting" | "success" | "hold" | "failure") {
  if (tone === "success") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (tone === "hold" || tone === "waiting") return "border-amber-200 bg-amber-50 text-amber-800";
  if (tone === "failure") return "border-red-200 bg-red-50 text-red-800";
  return "border-sky-200 bg-sky-50 text-sky-800";
}

function eventTone(status: WebhookEvent["status"]): "ready" | "waiting" | "success" | "hold" | "failure" {
  if (status === "proposed") return "success";
  if (["held", "paused", "duplicate"].includes(status)) return "hold";
  if (["rejected", "failed"].includes(status)) return "failure";
  return "waiting";
}

function executionTone(status: WriterExecution["status"]): "ready" | "waiting" | "success" | "hold" | "failure" {
  if (status === "succeeded") return "success";
  if (["prepared", "blocked", "reconciliation_required"].includes(status)) return "hold";
  if (status === "failed") return "failure";
  return "waiting";
}

/**
 * One-page operational tracker for the canonical AP financial event path.
 * It displays local event and execution audit evidence only; it cannot create
 * a Xero document, alter VTiger, register a schedule, or expose a webhook secret.
 */
export function FinancialWebhookInterface() {
  const utils = trpc.useUtils();
  const settings = trpc.financialOperations.automationSettings.useQuery();
  const events = trpc.financialOperations.webhookEvents.useQuery({ limit: 50 });
  const executions = trpc.financialOperations.writerExecutions.useQuery({ limit: 50 });

  const webhookEvents = (events.data ?? []) as WebhookEvent[];
  const writerExecutions = (executions.data ?? []) as WriterExecution[];
  const configuration = settings.data as AutomationSettings | undefined;
  const latestEvent = webhookEvents[0] ?? null;
  const latestExecution = writerExecutions[0] ?? null;
  const counters = useMemo(() => ({
    received: webhookEvents.length,
    proposed: webhookEvents.filter((event) => event.status === "proposed").length,
    held: webhookEvents.filter((event) => ["held", "paused", "rejected", "failed"].includes(event.status)).length,
    verifiedDrafts: writerExecutions.filter((execution) => execution.status === "succeeded" && execution.xeroDocumentStatus === "DRAFT").length,
  }), [webhookEvents, writerExecutions]);

  const refresh = () => {
    void Promise.all([
      settings.refetch(), events.refetch(), executions.refetch(),
      utils.financialOperations.documentIntents.invalidate(),
    ]);
  };

  return <div className="space-y-4">
    <Card className="border-sky-200 bg-sky-50/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sky-950"><Activity className="h-5 w-5" />Financial Pilot Tracker</CardTitle>
        <p className="mt-1 text-sm text-sky-900">One place to follow each VTiger event from receipt through proposal, approval and verified Xero Draft read-back.</p>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm md:grid-cols-4">
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">1. VTiger event</p><p className="mt-1 text-xs text-muted-foreground">Authenticated route receives the exact source event.</p><Badge className={`mt-2 ${badgeClass(webhookEvents.length ? "success" : "waiting")}`}>{webhookEvents.length ? `${counters.received} received` : "Waiting for pilot"}</Badge></div>
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">2. AP proposal</p><p className="mt-1 text-xs text-muted-foreground">AP validates the source and exact Xero state.</p><Badge className={`mt-2 ${badgeClass(counters.proposed ? "success" : "waiting")}`}>{counters.proposed ? `${counters.proposed} proposed` : "No proposal yet"}</Badge></div>
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">3. Named approval</p><p className="mt-1 text-xs text-muted-foreground">One source, reference, counterparty, amount and GST must be approved.</p><Badge className={`mt-2 ${badgeClass("hold")}`}>Required before Draft</Badge></div>
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">4. Xero Draft</p><p className="mt-1 text-xs text-muted-foreground">Only the server executes; success means exact Xero Draft read-back.</p><Badge className={`mt-2 ${badgeClass(counters.verifiedDrafts ? "success" : "waiting")}`}>{counters.verifiedDrafts ? `${counters.verifiedDrafts} verified Draft${counters.verifiedDrafts === 1 ? "" : "s"}` : "Locked for pilot details"}</Badge></div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><CardTitle className="flex items-center gap-2"><Webhook className="h-4 w-4" />Pilot status</CardTitle><p className="mt-1 text-sm text-muted-foreground">The event routes and Draft-only execution path are installed. Nothing is connected or sent until the first exact pilot document is approved.</p></div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={events.isFetching || executions.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${events.isFetching || executions.isFetching ? "animate-spin" : ""}`} />Refresh</Button>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border p-4"><p className="font-medium">Connection</p><p className="mt-1 text-sm">{configuration?.proposalWebhook?.configured ? "AP event authentication is configured privately." : "AP event authentication is not configured yet."}</p><Badge className={`mt-3 ${badgeClass(configuration?.proposalWebhook?.configured ? "ready" : "waiting")}`}>{configuration?.proposalWebhook?.configured ? "Route ready" : "Route not connected"}</Badge></div>
        <div className="rounded-lg border p-4"><p className="font-medium">Latest VTiger event</p>{latestEvent ? <><p className="mt-1 font-mono text-sm">{latestEvent.sourceRecordNumber ?? latestEvent.sourceRecordId}</p><p className="mt-1 text-xs text-muted-foreground">{titleize(latestEvent.routeKey)} · {dateTime(latestEvent.receivedAt)}</p><Badge className={`mt-3 ${badgeClass(eventTone(latestEvent.status))}`}>{titleize(latestEvent.status)}</Badge></> : <p className="mt-1 text-sm text-muted-foreground">No pilot event received.</p>}</div>
        <div className="rounded-lg border p-4"><p className="font-medium">Latest Xero Draft</p>{latestExecution ? <><p className="mt-1 font-mono text-sm">{latestExecution.proposedDocumentNumber}</p><p className="mt-1 text-xs text-muted-foreground">{latestExecution.xeroDocumentStatus ?? "No Xero read-back"} · {dateTime(latestExecution.completedAt ?? latestExecution.createdAt)}</p><Badge className={`mt-3 ${badgeClass(executionTone(latestExecution.status))}`}>{titleize(latestExecution.status)}</Badge></> : <p className="mt-1 text-sm text-muted-foreground">No Xero Draft has been sent.</p>}</div>
      </CardContent>
    </Card>

    <Card className="border-amber-200 bg-amber-50/30">
      <CardHeader><CardTitle className="flex items-center gap-2 text-amber-950"><LockKeyhole className="h-4 w-4" />First pilot — information required</CardTitle><p className="mt-1 text-sm text-amber-900">Send one exact document only. The app will then show its event, proposal, approval status and Xero Draft outcome here.</p></CardHeader>
      <CardContent className="grid gap-2 text-sm md:grid-cols-2"><p className="rounded-md border border-amber-200 bg-white/70 p-3"><strong>1. Source:</strong> family and VTiger record ID / business number.</p><p className="rounded-md border border-amber-200 bg-white/70 p-3"><strong>2. Draft:</strong> expected Xero reference and whether it is a PO or customer invoice.</p><p className="rounded-md border border-amber-200 bg-white/70 p-3"><strong>3. Financial facts:</strong> supplier/customer, total amount, GST treatment, issue/due date and line summary.</p><p className="rounded-md border border-amber-200 bg-white/70 p-3"><strong>4. Approval:</strong> confirm this exact Draft may be created after the app presents its final payload and preflight.</p></CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Clock3 className="h-4 w-4" />Live event tracking</CardTitle><p className="mt-1 text-sm text-muted-foreground">A held item is safe: it means the event did not reach Xero. A Draft is counted only after exact Xero read-back confirms status <code className="rounded bg-muted px-1">DRAFT</code>.</p></CardHeader>
      <CardContent>{events.isLoading || executions.isLoading ? <Skeleton className="h-56" /> : webhookEvents.length === 0 && writerExecutions.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"><Send className="mx-auto mb-2 h-5 w-5" />No pilot activity yet. This is expected until the first approved VTiger event is connected.</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Time</th><th className="p-3">Source / document</th><th className="p-3">Stage</th><th className="p-3">Status</th><th className="p-3">Detail</th></tr></thead><tbody>
        {webhookEvents.map((event) => <tr key={`event-${event.id}`} className="border-b align-top last:border-0"><td className="p-3 text-xs">{dateTime(event.receivedAt)}</td><td className="p-3"><p className="font-mono text-xs">{event.sourceRecordNumber ?? event.sourceRecordId}</p><p className="text-xs text-muted-foreground">{titleize(event.routeKey)}</p></td><td className="p-3">VTiger event → AP proposal</td><td className="p-3"><Badge className={badgeClass(eventTone(event.status))}>{titleize(event.status)}</Badge></td><td className="p-3 text-xs text-muted-foreground">{event.errorMessage ?? (event.status === "proposed" ? `Proposal run #${event.workflowRunId ?? "—"}` : "No Xero write")}</td></tr>)}
        {writerExecutions.map((execution) => <tr key={`execution-${execution.id}`} className="border-b align-top last:border-0"><td className="p-3 text-xs">{dateTime(execution.completedAt ?? execution.createdAt)}</td><td className="p-3"><p className="font-mono text-xs">{execution.proposedDocumentNumber}</p><p className="text-xs text-muted-foreground">{titleize(execution.workflowType)}</p></td><td className="p-3">AP approval → Xero Draft read-back</td><td className="p-3"><Badge className={badgeClass(executionTone(execution.status))}>{titleize(execution.status)}</Badge></td><td className="p-3 text-xs text-muted-foreground">{execution.status === "succeeded" ? <span className="text-emerald-700"><CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />{execution.xeroDocumentStatus ?? "Verified"} {execution.xeroDocumentId ? "• Xero ID recorded" : ""}</span> : execution.errorMessage ?? "No Xero write"}</td></tr>)}
      </tbody></table></div>}</CardContent>
    </Card>

    <details className="rounded-lg border bg-muted/20 p-4 text-sm"><summary className="cursor-pointer font-medium"><CircleAlert className="mr-2 inline h-4 w-4" />Safety and route details</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>VTiger sends events to AP; AP does not poll a VTiger webhook. Each event is authenticated and deterministically deduplicated.</p><p>The tracker never exposes the secret. It also cannot create a Draft from the browser, change VTiger, register a schedule, or activate a family.</p><p>Current writer state: {configuration?.writer?.globalShadowMode ? "global shadow protection is active" : "release gates still control execution"}. Any actual Draft remains subject to current source evidence, exact Xero preflight, a single-use approval and the deployment/release gates.</p></div></details>
  </div>;
}
