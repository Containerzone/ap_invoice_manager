import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle2, Clock3, Mail, RefreshCw, Siren } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type WorkflowFailure = {
  id: number;
  workflowType: string;
  recordKey: string;
  title: string;
  errorMessage: string;
  details: unknown;
  severity: "warning" | "error";
  status: "open" | "resolved";
  occurrenceCount: number;
  firstOccurredAt: Date;
  lastOccurredAt: Date;
  lastAlertedAt: Date | null;
  alertError: string | null;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
};

function formatTimestamp(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-AU");
}

function failureBadge(failure: WorkflowFailure) {
  if (failure.status === "resolved") return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">Resolved</Badge>;
  if (failure.severity === "warning") return <Badge className="bg-amber-100 text-amber-800 border-amber-200">Open warning</Badge>;
  return <Badge className="bg-red-100 text-red-800 border-red-200">Open error</Badge>;
}

export default function OperationalFailures() {
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<WorkflowFailure | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const { data: status, isLoading: statusLoading } = trpc.workflowMonitoring.status.useQuery(undefined, { refetchInterval: 30_000 });
  const { data: failures, isLoading } = trpc.workflowMonitoring.list.useQuery({ limit: 100 }, { refetchInterval: 30_000 });
  const resolveMutation = trpc.workflowMonitoring.resolve.useMutation({
    onSuccess: () => {
      toast.success("Operational failure marked as resolved");
      setSelected(null);
      setResolutionNotes("");
      utils.workflowMonitoring.list.invalidate();
      utils.workflowMonitoring.status.invalidate();
    },
    onError: (error) => toast.error(`Could not resolve failure: ${error.message}`),
  });
  const enableSummaryMutation = trpc.workflowMonitoring.enableDailySummary.useMutation({
    onSuccess: (result) => {
      toast.success(result.alreadyEnabled ? "Daily reconciliation is already enabled" : "Daily reconciliation has been enabled");
      utils.workflowMonitoring.status.invalidate();
    },
    onError: (error) => toast.error(`Could not enable daily reconciliation: ${error.message}`),
  });

  const rows = (failures ?? []) as WorkflowFailure[];
  const openRows = rows.filter((row) => row.status === "open");

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Operational Failures</h1>
          <p className="text-sm text-muted-foreground mt-1">Central review register for failed webhooks, Xero operations, inbound invoice processing and scheduled workflows.</p>
        </div>
        <Button variant="outline" onClick={() => { utils.workflowMonitoring.list.invalidate(); utils.workflowMonitoring.status.invalidate(); }}>
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <Siren className="h-8 w-8 text-red-600" />
            <div><p className="text-2xl font-bold">{statusLoading ? "—" : status?.openFailureCount ?? 0}</p><p className="text-xs text-muted-foreground">Open failures</p></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <Mail className="h-8 w-8 text-blue-600" />
            <div><p className="text-2xl font-bold">{statusLoading ? "—" : status?.alertRecipientCount ?? 0}</p><p className="text-xs text-muted-foreground">Immediate alert recipients</p></div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3"><Clock3 className="h-8 w-8 text-amber-600" /><div><p className="font-semibold">{status?.dailySummaryEnabled ? "Daily summary enabled" : "Daily summary not enabled"}</p><p className="text-xs text-muted-foreground">{status?.lastDailySummaryAt ? `Last sent ${formatTimestamp(status.lastDailySummaryAt)}` : "Runs at 7:00 AM AEST / 8:00 AM AEDT after activation"}</p></div></div>
            {!status?.dailySummaryEnabled && <Button size="sm" onClick={() => enableSummaryMutation.mutate()} disabled={enableSummaryMutation.isPending}>Enable</Button>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Failure register</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="space-y-3">{Array.from({ length: 5 }).map((_, index) => <Skeleton className="h-14 w-full" key={index} />)}</div> : rows.length === 0 ? (
            <div className="py-14 text-center"><CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-3" /><p className="font-medium">No failures recorded</p><p className="text-sm text-muted-foreground mt-1">New workflow failures will appear here and trigger immediate alerts.</p></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="text-left p-3">Workflow</th><th className="text-left p-3">Failure</th><th className="text-left p-3">Status</th><th className="text-left p-3">Last occurrence</th><th className="text-left p-3">Action</th></tr></thead>
                <tbody>{rows.map((failure) => <tr className="border-b last:border-0" key={failure.id}>
                  <td className="p-3 align-top"><p className="font-medium">{failure.workflowType}</p><p className="text-xs text-muted-foreground mt-1">{failure.recordKey}</p></td>
                  <td className="p-3 align-top max-w-xl"><p className="font-medium">{failure.title}</p><p className="text-xs text-destructive mt-1 line-clamp-2">{failure.errorMessage}</p>{failure.occurrenceCount > 1 && <p className="text-xs text-muted-foreground mt-1">Occurred {failure.occurrenceCount} times</p>}</td>
                  <td className="p-3 align-top">{failureBadge(failure)}</td>
                  <td className="p-3 align-top whitespace-nowrap text-xs text-muted-foreground">{formatTimestamp(failure.lastOccurredAt)}</td>
                  <td className="p-3 align-top"><Button size="sm" variant="outline" onClick={() => { setSelected(failure); setResolutionNotes(failure.resolutionNotes ?? ""); }}>{failure.status === "open" ? "Review" : "View"}</Button></td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
          {!isLoading && rows.length > 0 && openRows.length === 0 && <p className="mt-4 text-sm text-emerald-700">All recorded failures have been resolved.</p>}
        </CardContent>
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{selected?.title}</DialogTitle></DialogHeader>
          {selected && <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">{failureBadge(selected)}<span className="text-muted-foreground">{selected.workflowType} · {selected.recordKey}</span></div>
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-900 whitespace-pre-wrap">{selected.errorMessage}</div>
            <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground"><span>First occurred: {formatTimestamp(selected.firstOccurredAt)}</span><span>Last occurred: {formatTimestamp(selected.lastOccurredAt)}</span><span>Occurrences: {selected.occurrenceCount}</span><span>Last alert: {formatTimestamp(selected.lastAlertedAt)}</span></div>
            {selected.alertError && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900"><AlertTriangle className="h-4 w-4 inline mr-1" />Alert delivery issue: {selected.alertError}</div>}
            {Boolean(selected.details) && <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(selected.details, null, 2)}</pre>}
            {selected.status === "open" && <div className="space-y-2"><label className="text-sm font-medium">Resolution notes (optional)</label><Textarea value={resolutionNotes} onChange={(event) => setResolutionNotes(event.target.value)} placeholder="What was checked or corrected?" /></div>}
            {selected.status === "resolved" && selected.resolutionNotes && <div className="rounded-md bg-emerald-50 p-3 text-emerald-900">Resolution notes: {selected.resolutionNotes}</div>}
          </div>}
          <DialogFooter>{selected?.status === "open" && <Button onClick={() => selected && resolveMutation.mutate({ id: selected.id, resolutionNotes: resolutionNotes || undefined })} disabled={resolveMutation.isPending}><CheckCircle2 className="h-4 w-4 mr-2" />Mark resolved</Button>}</DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
