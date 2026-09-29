import { useMemo } from "react";
import { Activity, Ban, CheckCircle2, Clock3, Copy, PauseCircle, PlayCircle, ShieldCheck, Webhook } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type RouteControl = {
  key: string;
  displayName: string;
  workflowType: string;
  schedule: "event" | "future_schedule";
  paused: boolean;
};

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
  safeSummary: unknown;
};

type AutomationSettings = {
  proposalWebhook?: {
    configured: boolean;
    headerName: string;
    mode: string;
    financialWritePermitted: boolean;
    schedulesRegistered: boolean;
  };
  sourceMapping?: unknown;
};

function dateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

function statusTone(status: WebhookEvent["status"] | "ready" | "not_configured") {
  if (["proposed", "ready"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (["held", "paused", "duplicate", "not_configured"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-red-200 bg-red-50 text-red-800";
}

function titleize(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function copyExample() {
  const example = {
    apiVersion: "2026-09-29",
    dryRun: true,
    eventId: "vtiger-event-unique-id",
    eventType: "container_control.updated",
    sourceSystem: "VTiger",
    sourceEntityType: "container_control",
    sourceRecordId: "12x345",
    sourceRecordNumber: "CC1860",
    sourceChangedAt: new Date().toISOString(),
    data: { containerControlNumber: "CC1860", status: "REQUEST" },
  };
  void navigator.clipboard?.writeText(JSON.stringify(example, null, 2));
  toast.success("Dry-run event example copied. Do not configure VTiger until the relevant family is externally approved.");
}

/**
 * AP-only readiness view for the fixed financial webhook contract. Browser
 * controls only pause/resume event receipt; they cannot approve or execute a
 * Xero Draft, register a scheduler task, or change VTiger.
 */
export function FinancialWebhookInterface() {
  const utils = trpc.useUtils();
  const settings = trpc.financialOperations.automationSettings.useQuery();
  const controls = trpc.financialOperations.webhookControls.useQuery();
  const events = trpc.financialOperations.webhookEvents.useQuery({ limit: 50 });
  const setPaused = trpc.financialOperations.setWebhookPause.useMutation({
    onSuccess: () => {
      toast.success("AP webhook proposal control updated. No Xero, VTiger or schedule change was made.");
      utils.financialOperations.webhookControls.invalidate();
      utils.financialOperations.automationSettings.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const webhook = (settings.data as AutomationSettings | undefined)?.proposalWebhook;
  const routeRows = (controls.data?.routes ?? []) as RouteControl[];
  const eventRows = (events.data ?? []) as WebhookEvent[];
  const sourceMappingState = useMemo(() => {
    const mapping = (settings.data as AutomationSettings | undefined)?.sourceMapping;
    return mapping && typeof mapping === "object" && Object.keys(mapping as Record<string, unknown>).length > 0
      ? "Mapped fields configured"
      : "Canonical event fields only";
  }, [settings.data]);

  return <div className="space-y-4">
    <Card className="border-sky-200 bg-sky-50/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sky-950"><Webhook className="h-5 w-5" />AP Financial Webhook Interface</CardTitle>
        <p className="mt-1 text-sm text-sky-900">Fixed AP-owned routes authenticate every event, map current source data into a local proposal, and create audit evidence. A non-dry event is held unless it names one exact, current, document-bound approval and every server gate passes.</p>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm md:grid-cols-4">
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">Authentication</p><p className="mt-1 text-xs text-muted-foreground">{webhook?.configured ? "Secret configured privately" : "Secret not configured"}</p><Badge className={`mt-2 ${statusTone(webhook?.configured ? "ready" : "not_configured")}`}>{webhook?.configured ? "Configured" : "Not configured"}</Badge></div>
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">Xero boundary</p><p className="mt-1 text-xs text-muted-foreground">Only a non-dry event with its exact single-use approval can reach the server-only Draft transport.</p><Badge className="mt-2 border-red-200 bg-red-50 text-red-800">Gate enforced</Badge></div>
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">Schedule boundary</p><p className="mt-1 text-xs text-muted-foreground">Recurring routes are definitions only.</p><Badge className="mt-2 border-amber-200 bg-amber-50 text-amber-800">No tasks registered</Badge></div>
        <div className="rounded-lg border border-sky-200 bg-white/80 p-3"><p className="font-medium">Source mapping</p><p className="mt-1 text-xs text-muted-foreground">{sourceMappingState}</p><Badge variant="outline" className="mt-2">AP configuration</Badge></div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />Event contract and global pause</CardTitle><p className="mt-1 text-sm text-muted-foreground">Each external request must send <code className="rounded bg-muted px-1">X-Financial-Webhook-Secret</code> and the versioned event envelope. A global pause stops future proposals and execution attempts without touching a source workflow.</p></CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><Badge variant="outline">apiVersion: 2026-09-29</Badge><Badge variant="outline">dryRun: true | executionApprovalId</Badge><Badge variant="outline">sourceSystem: VTiger</Badge><Badge variant="outline">no credentials returned</Badge></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={copyExample}><Copy className="mr-1 h-3.5 w-3.5" />Copy sample payload</Button><Button size="sm" variant={controls.data?.controls.globalPaused ? "default" : "destructive"} onClick={() => setPaused.mutate({ routeKey: "global", paused: !Boolean(controls.data?.controls.globalPaused) })} disabled={setPaused.isPending}>{controls.data?.controls.globalPaused ? <><PlayCircle className="mr-1 h-3.5 w-3.5" />Resume all proposals</> : <><PauseCircle className="mr-1 h-3.5 w-3.5" />Pause all proposals</>}</Button></div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Fixed AP proposal routes</CardTitle><p className="mt-1 text-sm text-muted-foreground">These route paths are visible for AP implementation review only. Do not add them to VTiger or configure recurrence until the individual family’s legacy-writer handoff and final approval are complete.</p></CardHeader>
      <CardContent>{controls.isLoading ? <Skeleton className="h-72" /> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Family</th><th className="p-3">Workflow</th><th className="p-3">Trigger</th><th className="p-3">Proposal status</th><th className="p-3">AP control</th></tr></thead><tbody>{routeRows.map((route) => <tr key={route.key} className="border-b last:border-0 align-top"><td className="p-3"><p className="font-medium">{route.displayName}</p><p className="mt-1 font-mono text-xs text-muted-foreground">/api/financial-workflows/events/{route.key}</p></td><td className="p-3 font-mono text-xs">{route.workflowType}</td><td className="p-3"><Badge variant="outline">{route.schedule === "event" ? "Event-driven" : "Future schedule only"}</Badge></td><td className="p-3"><Badge className={statusTone(route.paused ? "paused" : "ready")}>{route.paused ? "Paused" : "Proposal ready"}</Badge><p className="mt-1 text-xs text-muted-foreground">Financial write disabled</p></td><td className="p-3"><Button size="sm" variant={route.paused ? "default" : "outline"} onClick={() => setPaused.mutate({ routeKey: route.key, paused: !route.paused })} disabled={setPaused.isPending}>{route.paused ? "Resume proposal" : "Pause proposal"}</Button></td></tr>)}</tbody></table></div>}</CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" />AP webhook proposal audit</CardTitle><p className="mt-1 text-sm text-muted-foreground">Local event receipt and proposal outcome only. Payload secrets and raw credentials are never stored or displayed.</p></CardHeader>
      <CardContent>{events.isLoading ? <Skeleton className="h-48" /> : eventRows.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"><Clock3 className="mx-auto mb-2 h-5 w-5" />No authenticated AP webhook proposal has been received. This is expected until a family is externally configured after approval.</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Received</th><th className="p-3">Route / source</th><th className="p-3">Outcome</th><th className="p-3">Proposal</th></tr></thead><tbody>{eventRows.map((event) => <tr key={event.id} className="border-b last:border-0 align-top"><td className="p-3 text-xs">{dateTime(event.receivedAt)}<br /><span className="font-mono text-muted-foreground">{event.eventId}</span></td><td className="p-3"><p className="font-medium">{titleize(event.routeKey)}</p><p className="text-xs text-muted-foreground">{event.sourceEntityType} · {event.sourceRecordNumber ?? event.sourceRecordId}</p></td><td className="p-3"><Badge className={statusTone(event.status)}>{titleize(event.status)}</Badge>{event.errorMessage ? <p className="mt-1 max-w-sm text-xs text-red-700">{event.errorMessage}</p> : null}</td><td className="p-3 text-xs">Run #{event.workflowRunId ?? "—"}<br />{event.status === "proposed" ? <span className="text-emerald-700"><CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />Local proposal recorded</span> : <span className="text-muted-foreground"><Ban className="mr-1 inline h-3.5 w-3.5" />No Xero write</span>}</td></tr>)}</tbody></table></div>}</CardContent>
    </Card>
  </div>;
}
