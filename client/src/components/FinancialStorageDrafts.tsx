import { RefreshCw, Warehouse } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type StorageReceipt = { documentType?: string; number?: string; xeroId?: string; status?: string; readBackAt?: string };

function statusStyle(status: string): string {
  if (status === "drafts_created") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "writeback_pending") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "partial" || status === "failed") return "border-red-200 bg-red-50 text-red-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

/** Read-only storage receipts within the existing Financial Operations workspace. */
export function FinancialStorageDrafts() {
  const events = trpc.financialOperations.initialStorageEvents.useQuery({ limit: 100 });
  return <div className="space-y-4">
    <Card className="border-sky-200 bg-sky-50/50">
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><CardTitle className="flex items-center gap-2"><Warehouse className="h-5 w-5" />Loaded-container Storage Drafts</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">Origin and Destination stage events from VTiger. The three document references appear only after Xero Draft read-back; a held event has not been written.</p></div>
        <Button size="sm" variant="outline" onClick={() => void events.refetch()} disabled={events.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${events.isFetching ? "animate-spin" : ""}`} />Refresh</Button>
      </CardHeader>
      <CardContent>{events.isLoading ? <Skeleton className="h-36" /> : events.error ? <p className="text-sm text-red-700">Storage records could not be loaded. Please retry.</p> : !events.data?.length ?
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No loaded-container storage Deal event has been recorded by AP yet.</p>
        : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Deal / location</th><th className="p-3">Initial period</th><th className="p-3">Status</th><th className="p-3">Customer invoice</th><th className="p-3">Transport PO</th><th className="p-3">Storage PO</th></tr></thead><tbody>{events.data.map((event) => {
          const receipts = Array.isArray(event.documentResults) ? event.documentResults as StorageReceipt[] : [];
          const receipt = (kind: string) => receipts.find((item) => item.documentType === kind);
          return <tr key={event.id} className="border-b align-top last:border-0"><td className="p-3"><span className="font-mono font-medium">{event.dealNumber}</span><br /><span className="capitalize text-muted-foreground">{event.location}</span></td>
            <td className="whitespace-nowrap p-3 font-mono text-xs">{event.periodStart}<br />to {event.periodEnd}</td><td className="p-3"><Badge className={statusStyle(event.status)}>{event.status.replaceAll("_", " ")}</Badge>{event.errorMessage && <p className="mt-1 max-w-64 text-xs text-muted-foreground">{event.errorMessage}</p>}</td>
            {(["customer_invoice", "jd_transport", "gd_storage"] as const).map((kind) => <td key={kind} className="p-3"><span className="font-mono text-xs">{receipt(kind)?.number ?? "—"}</span><br /><span className="text-xs text-muted-foreground">{receipt(kind)?.status ?? "Not verified"}</span></td>)}
          </tr>;
        })}</tbody></table></div>}</CardContent>
    </Card>
    <p className="text-xs text-muted-foreground">This page is read-only. It cannot start a webhook, change a VTiger Deal, or create/authorise Xero documents.</p>
  </div>;
}
