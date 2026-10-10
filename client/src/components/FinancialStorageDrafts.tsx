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
  const executions = trpc.financialOperations.writerExecutions.useQuery({ limit: 100 });
  // A create-only PUT is a manually approved invoice test, never a VTiger stage
  // event and never proof that the three-document webhook has cut over.
  const invoiceOnlyTests = (executions.data ?? []).filter((row) => row.workflowType === "storage_activation"
    && row.documentFamily === "customer_invoice" && row.proposedAction === "create_draft"
    && row.method === "PUT" && row.endpoint === "/Invoices");
  return <div className="space-y-4">
    <Card className="border-sky-200 bg-sky-50/50">
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><CardTitle className="flex items-center gap-2"><Warehouse className="h-5 w-5" />Loaded-container Storage Drafts</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">Initial, monthly and final-period storage receipts. Document references appear only after exact Xero Draft read-back.</p></div>
        <Button size="sm" variant="outline" onClick={() => { void events.refetch(); void executions.refetch(); }} disabled={events.isFetching || executions.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${events.isFetching || executions.isFetching ? "animate-spin" : ""}`} />Refresh</Button>
      </CardHeader>
      <CardContent>{events.isLoading ? <Skeleton className="h-36" /> : events.error ? <p className="text-sm text-red-700">Storage records could not be loaded. Please retry.</p> : !events.data?.length ?
        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No loaded-container storage Deal event has been recorded by AP yet.</p>
        : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Deal / location</th><th className="p-3">Initial period</th><th className="p-3">Status</th><th className="p-3">Customer invoice</th><th className="p-3">Transport PO</th><th className="p-3">Storage PO</th></tr></thead><tbody>{events.data.map((event) => {
          const receipts = Array.isArray(event.documentResults) ? event.documentResults as StorageReceipt[] : [];
          const finalReceipts = Array.isArray(event.finalisationResults) ? event.finalisationResults as StorageReceipt[] : [];
          const receipt = (kind: string) => receipts.find((item) => item.documentType === kind);
          return <tr key={event.id} className="border-b align-top last:border-0"><td className="p-3"><span className="font-mono font-medium">{event.dealNumber}</span><br /><span className="capitalize text-muted-foreground">{event.location}</span></td>
            <td className="whitespace-nowrap p-3 font-mono text-xs"><span className="font-sans capitalize">{event.eventKind}</span><br />{event.periodStart}<br />to {event.finalDate ?? event.periodEnd}{event.nextBillingDate && <p className="mt-1 text-muted-foreground">Next: {event.nextBillingDate}</p>}</td><td className="p-3"><Badge className={statusStyle(event.status)}>{event.finalisedAt ? "finalised" : event.status.replaceAll("_", " ")}</Badge>{finalReceipts.length > 0 && <p className="mt-1 text-xs">{finalReceipts.length} final Draft receipts</p>}{event.errorMessage && <p className="mt-1 max-w-64 text-xs text-muted-foreground">{event.errorMessage}</p>}</td>
            {(["customer_invoice", "jd_transport", "gd_storage"] as const).map((kind) => <td key={kind} className="p-3"><span className="font-mono text-xs">{receipt(kind)?.number ?? "—"}</span><br /><span className="text-xs text-muted-foreground">{receipt(kind)?.status ?? "Not verified"}</span></td>)}
          </tr>;
        })}</tbody></table></div>}</CardContent>
    </Card>
    {invoiceOnlyTests.length > 0 && <Card>
      <CardHeader><CardTitle className="text-base">Approved invoice-only tests</CardTitle>
        <p className="text-sm text-muted-foreground">Separately approved Xero Drafts. These are not VTiger stage webhook events or three-document completions.</p>
      </CardHeader>
      <CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Invoice</th><th className="p-3">Xero status</th><th className="p-3">Verified Xero ID</th><th className="p-3">AP execution</th></tr></thead>
        <tbody>{invoiceOnlyTests.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="p-3 font-mono">{row.proposedDocumentNumber}</td><td className="p-3"><Badge className={statusStyle(row.status === "succeeded" ? "drafts_created" : row.status)}>{row.status === "succeeded" ? row.xeroDocumentStatus ?? "Verified" : row.status.replaceAll("_", " ")}</Badge></td><td className="p-3 font-mono text-xs">{row.xeroDocumentId ?? "—"}</td><td className="p-3 text-muted-foreground">#{row.id}</td></tr>)}</tbody>
      </table></div></CardContent>
    </Card>}
    <p className="text-xs text-muted-foreground">This page is read-only. It cannot start a webhook, change a VTiger Deal, or create/authorise Xero documents.</p>
  </div>;
}
