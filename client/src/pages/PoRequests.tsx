import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Loader2,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoResult {
  poNumber: string;
  prefix: string;
  amountExclGst: number;
  supplier: string;
  accountCode: string;
  description: string;
  xeroPoId: string | null;
  xeroPoNumber: string | null;
  status: "created" | "skipped" | "error" | "duplicate";
  error?: string;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function statusBadge(status: string) {
  switch (status) {
    case "completed":
      return <Badge className="bg-emerald-100 text-emerald-800 border-emerald-200">Completed</Badge>;
    case "partial":
      return <Badge className="bg-amber-100 text-amber-800 border-amber-200">Partial</Badge>;
    case "failed":
      return <Badge className="bg-red-100 text-red-800 border-red-200">Failed</Badge>;
    case "processing":
      return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Processing</Badge>;
    case "pending":
      return <Badge className="bg-slate-100 text-slate-700 border-slate-200">Pending</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function poResultIcon(status: PoResult["status"]) {
  switch (status) {
    case "created":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    case "duplicate":
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case "skipped":
      return <Clock className="h-4 w-4 text-slate-400" />;
    case "error":
      return <XCircle className="h-4 w-4 text-red-500" />;
  }
}

function poResultBadge(status: PoResult["status"]) {
  switch (status) {
    case "created":
      return <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 text-xs">Created</Badge>;
    case "duplicate":
      return <Badge className="bg-amber-50 text-amber-700 border-amber-200 text-xs">Already exists</Badge>;
    case "skipped":
      return <Badge className="bg-slate-50 text-slate-500 border-slate-200 text-xs">Skipped (zero)</Badge>;
    case "error":
      return <Badge className="bg-red-50 text-red-700 border-red-200 text-xs">Error</Badge>;
  }
}

// ─── Detail Dialog ────────────────────────────────────────────────────────────

function PoRequestDetail({
  requestId,
  open,
  onClose,
}: {
  requestId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.poRequests.get.useQuery(
    { id: requestId! },
    { enabled: open && requestId != null }
  );

  const retryMutation = trpc.poRequests.retry.useMutation({
    onSuccess: () => {
      toast.success("Retrying PO creation — check back in a few seconds");
      utils.poRequests.list.invalidate();
      utils.poRequests.get.invalidate({ id: requestId! });
    },
    onError: (err) => toast.error(`Retry failed: ${err.message}`),
  });

  if (!open || requestId == null) return null;

  const poResults: PoResult[] = Array.isArray(data?.poResults)
    ? (data!.poResults as unknown as PoResult[])
    : [];

  const createdCount = poResults.filter((r) => r.status === "created").length;
  const errorCount = poResults.filter((r) => r.status === "error").length;
  const skippedCount = poResults.filter((r) => r.status === "skipped").length;
  const dupCount = poResults.filter((r) => r.status === "duplicate").length;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span>PO Request — {data?.vtigerDealNumber ?? `#${requestId}`}</span>
            {data && statusBadge(data.status)}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        ) : data ? (
          <div className="space-y-5">
            {/* Summary row */}
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
              <span>Received: <strong className="text-foreground">{new Date(data.createdAt!).toLocaleString()}</strong></span>
              {data.processedAt && (
                <span>Processed: <strong className="text-foreground">{new Date(data.processedAt).toLocaleString()}</strong></span>
              )}
            </div>

            {/* Stats */}
            {poResults.length > 0 && (
              <div className="grid grid-cols-4 gap-3">
                <div className="rounded-lg border bg-emerald-50 p-3 text-center">
                  <div className="text-2xl font-bold text-emerald-700">{createdCount}</div>
                  <div className="text-xs text-emerald-600 mt-0.5">Created</div>
                </div>
                <div className="rounded-lg border bg-amber-50 p-3 text-center">
                  <div className="text-2xl font-bold text-amber-700">{dupCount}</div>
                  <div className="text-xs text-amber-600 mt-0.5">Already existed</div>
                </div>
                <div className="rounded-lg border bg-slate-50 p-3 text-center">
                  <div className="text-2xl font-bold text-slate-600">{skippedCount}</div>
                  <div className="text-xs text-slate-500 mt-0.5">Skipped (zero)</div>
                </div>
                <div className="rounded-lg border bg-red-50 p-3 text-center">
                  <div className="text-2xl font-bold text-red-700">{errorCount}</div>
                  <div className="text-xs text-red-600 mt-0.5">Errors</div>
                </div>
              </div>
            )}

            {/* Error message */}
            {data.errorMessage && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <strong>Error:</strong> {data.errorMessage}
              </div>
            )}

            {/* PO results table */}
            {poResults.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Purchase Orders</h3>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="w-8"></TableHead>
                        <TableHead>PO Number</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Supplier</TableHead>
                        <TableHead className="text-right">Amount (excl. GST)</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {poResults.map((r) => (
                        <TableRow key={r.poNumber} className={r.status === "error" ? "bg-red-50/50" : ""}>
                          <TableCell>{poResultIcon(r.status)}</TableCell>
                          <TableCell className="font-mono font-medium text-sm">
                            {r.xeroPoNumber ?? r.poNumber}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">{r.description}</TableCell>
                          <TableCell className="text-sm">{r.supplier}</TableCell>
                          <TableCell className="text-right font-medium">
                            {r.amountExclGst > 0
                              ? `$${r.amountExclGst.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              : "—"}
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              {poResultBadge(r.status)}
                              {r.error && (
                                <p className="text-xs text-red-600 max-w-[200px] truncate" title={r.error}>
                                  {r.error}
                                </p>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* Actions */}
            {(data.status === "failed" || data.status === "partial") && (
              <div className="flex justify-end pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => retryMutation.mutate({ id: requestId })}
                  disabled={retryMutation.isPending}
                >
                  {retryMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Retry PO Creation
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm py-4">Request not found.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PoRequests() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const utils = trpc.useUtils();

  const { data: rows, isLoading } = trpc.poRequests.list.useQuery(
    { limit: 50, offset: 0 },
    { refetchInterval: 10_000 } // auto-refresh every 10s to catch async processing
  );

  const handleRefresh = () => {
    utils.poRequests.list.invalidate();
    toast.success("Refreshed");
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">PO Requests</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Purchase orders automatically created in Xero from Vtiger deal triggers
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !rows || rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="rounded-full bg-muted p-4 mb-4">
                <ExternalLink className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="font-semibold text-lg mb-1">No PO requests yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm">
                When a Vtiger deal reaches Stage 1, the webhook will fire here and purchase orders
                will be created automatically in Xero.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Deal</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Processed</TableHead>
                  <TableHead>POs Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-8"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const results: PoResult[] = Array.isArray(row.poResults)
                    ? (row.poResults as unknown as PoResult[])
                    : [];
                  const createdCount = results.filter((r) => r.status === "created").length;
                  const errorCount = results.filter((r) => r.status === "error").length;

                  return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => setSelectedId(row.id)}
                    >
                      <TableCell>
                        <div className="font-mono font-semibold text-sm">
                          {row.vtigerDealNumber ?? row.vtigerDealId ?? `#${row.id}`}
                        </div>
                        {row.vtigerDealName && (
                          <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {row.vtigerDealName}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(row.createdAt!).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.processedAt
                          ? new Date(row.processedAt).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {results.length > 0 ? (
                          <div className="flex items-center gap-2 text-sm">
                            {createdCount > 0 && (
                              <span className="text-emerald-700 font-medium">{createdCount} created</span>
                            )}
                            {errorCount > 0 && (
                              <span className="text-red-600 font-medium">{errorCount} failed</span>
                            )}
                            {createdCount === 0 && errorCount === 0 && (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell>{statusBadge(row.status)}</TableCell>
                      <TableCell>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <PoRequestDetail
        requestId={selectedId}
        open={selectedId != null}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
