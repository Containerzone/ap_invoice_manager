import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { formatCurrency } from "@/lib/invoiceUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  TrendingUp, TrendingDown, Minus, FileText,
  CheckCircle2, AlertTriangle, ExternalLink,
  ChevronDown, ChevronRight,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PoBreakdown {
  poNumber: string;
  poTotal: number;
  invoiceLineItemTotal: number | null;
  rawDiff: number;
  overBilled: boolean;
  underBilled: boolean;
}

interface VarianceRow {
  invoiceId: number;
  invoiceNumber: string | null;
  supplierName: string | null;
  invoiceDate: string | null;
  status: string | null;
  extractedTotal: number | null;
  xeroTotal: number | null;
  totalNetDiff: number;
  poBreakdown: PoBreakdown[];
  staffApproved: boolean | null;
  adminApproved: boolean | null;
  approvedAt: Date | string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function DiffBadge({ diff }: { diff: number }) {
  if (Math.abs(diff) < 0.01) {
    return <Badge variant="secondary" className="gap-1 text-xs"><Minus className="h-3 w-3" /> Exact match</Badge>;
  }
  if (diff > 0) {
    return (
      <Badge className="gap-1 text-xs bg-red-100 text-red-800 border-red-200 hover:bg-red-100">
        <TrendingUp className="h-3 w-3" /> +{formatCurrency(diff)} over
      </Badge>
    );
  }
  return (
    <Badge className="gap-1 text-xs bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100">
      <TrendingDown className="h-3 w-3" /> {formatCurrency(Math.abs(diff))} under
    </Badge>
  );
}

function ApprovalBadge({ row }: { row: VarianceRow }) {
  if (row.adminApproved) {
    return <Badge className="text-xs bg-violet-100 text-violet-800 border-violet-200 hover:bg-violet-100">Admin Approved</Badge>;
  }
  if (row.staffApproved) {
    return <Badge className="text-xs bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-100">Staff Approved</Badge>;
  }
  return null;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Reports() {
  const [, setLocation] = useLocation();
  const { data, isLoading, error } = trpc.reports.poVariance.useQuery();
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  const toggleRow = (id: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Summary KPIs ──────────────────────────────────────────────────────────

  const rows: VarianceRow[] = data ?? [];
  const totalInvoices = rows.length;
  const totalInvoiceValue = rows.reduce((s, r) => s + (r.extractedTotal ?? 0), 0);
  const totalPOValue = rows.reduce((s, r) => s + (r.xeroTotal ?? r.extractedTotal ?? 0), 0);
  const netVariance = rows.reduce((s, r) => s + r.totalNetDiff, 0);
  const overBilledCount = rows.filter((r) => r.totalNetDiff > 0.01).length;
  const underBilledCount = rows.filter((r) => r.totalNetDiff < -0.01).length;
  const exactMatchCount = rows.filter((r) => Math.abs(r.totalNetDiff) <= 0.01).length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">PO Variance Report</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Approved invoices — net over/under position vs Xero Purchase Orders
          </p>
        </div>
      </div>

      {/* KPI cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">Approved Invoices</p>
              <p className="text-2xl font-bold mt-1">{totalInvoices}</p>
            </CardContent>
          </Card>
          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">Total Invoice Value</p>
              <p className="text-xl font-bold mt-1">{formatCurrency(totalInvoiceValue)}</p>
            </CardContent>
          </Card>
          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">Total PO Value</p>
              <p className="text-xl font-bold mt-1">{formatCurrency(totalPOValue)}</p>
            </CardContent>
          </Card>
          <Card className={cn("col-span-1", netVariance > 0.01 ? "border-red-200 bg-red-50" : netVariance < -0.01 ? "border-emerald-200 bg-emerald-50" : "")}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">Net Variance</p>
              <p className={cn("text-xl font-bold mt-1", netVariance > 0.01 ? "text-red-700" : netVariance < -0.01 ? "text-emerald-700" : "")}>
                {netVariance > 0.01 ? "+" : ""}{formatCurrency(netVariance)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {netVariance > 0.01 ? "net over-billed" : netVariance < -0.01 ? "net under-billed" : "balanced"}
              </p>
            </CardContent>
          </Card>
          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">Over-billed</p>
              <p className="text-2xl font-bold mt-1 text-red-700">{overBilledCount}</p>
              <p className="text-xs text-muted-foreground">invoices</p>
            </CardContent>
          </Card>
          <Card className="col-span-1">
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">Under-billed</p>
              <p className="text-2xl font-bold mt-1 text-emerald-700">{underBilledCount}</p>
              <p className="text-xs text-muted-foreground">{exactMatchCount} exact match{exactMatchCount !== 1 ? "es" : ""}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Variance table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Invoice Variance Detail</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
            </div>
          ) : error ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-amber-400" />
              Failed to load report data.
            </div>
          ) : rows.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No approved invoices yet</p>
              <p className="mt-1">Approved and resolved invoices will appear here with their PO variance data.</p>
            </div>
          ) : (
            <div className="divide-y">
              {/* Table header */}
              <div className="grid grid-cols-[1.5rem_1fr_1fr_7rem_7rem_7rem_8rem_6rem] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/40">
                <span />
                <span>Invoice</span>
                <span>Supplier</span>
                <span className="text-right">Invoice Amt</span>
                <span className="text-right">PO Total</span>
                <span className="text-right">Net Diff</span>
                <span>Approval</span>
                <span />
              </div>
              {rows.map((row) => {
                const expanded = expandedRows.has(row.invoiceId);
                return (
                  <div key={row.invoiceId}>
                    {/* Main row */}
                    <div
                      className="grid grid-cols-[1.5rem_1fr_1fr_7rem_7rem_7rem_8rem_6rem] gap-3 px-4 py-3 items-center hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => row.poBreakdown.length > 0 && toggleRow(row.invoiceId)}
                    >
                      {/* Expand toggle */}
                      <span className="text-muted-foreground">
                        {row.poBreakdown.length > 0
                          ? expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />
                          : null}
                      </span>
                      {/* Invoice number */}
                      <span className="text-sm font-medium truncate">
                        {row.invoiceNumber ?? `#${row.invoiceId}`}
                        {row.invoiceDate && <span className="text-xs text-muted-foreground ml-1.5">{row.invoiceDate}</span>}
                      </span>
                      {/* Supplier */}
                      <span className="text-sm text-muted-foreground truncate">{row.supplierName ?? "—"}</span>
                      {/* Invoice amount */}
                      <span className="text-sm text-right tabular-nums">{formatCurrency(row.extractedTotal)}</span>
                      {/* PO total */}
                      <span className="text-sm text-right tabular-nums text-muted-foreground">{formatCurrency(row.xeroTotal)}</span>
                      {/* Net diff */}
                      <span className="text-right">
                        <DiffBadge diff={row.totalNetDiff} />
                      </span>
                      {/* Approval */}
                      <span><ApprovalBadge row={row} /></span>
                      {/* Link */}
                      <span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs gap-1"
                          onClick={(e) => { e.stopPropagation(); setLocation(`/invoices/${row.invoiceId}`); }}
                        >
                          <ExternalLink className="h-3 w-3" /> View
                        </Button>
                      </span>
                    </div>
                    {/* Expanded PO breakdown */}
                    {expanded && row.poBreakdown.length > 0 && (
                      <div className="bg-muted/20 border-t px-8 py-3 space-y-1.5">
                        <p className="text-xs font-semibold text-muted-foreground mb-2">Per-PO breakdown</p>
                        {row.poBreakdown.map((po) => (
                          <div key={po.poNumber} className="grid grid-cols-[8rem_7rem_7rem_1fr] gap-3 text-xs items-center">
                            <span className="font-mono font-medium">{po.poNumber}</span>
                            <span className="text-right tabular-nums text-muted-foreground">
                              Inv: {formatCurrency(po.invoiceLineItemTotal)}
                            </span>
                            <span className="text-right tabular-nums text-muted-foreground">
                              PO: {formatCurrency(po.poTotal)}
                            </span>
                            <span>
                              {Math.abs(po.rawDiff) < 0.01
                                ? <span className="text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" /> Match</span>
                                : po.overBilled
                                  ? <span className="text-red-700 font-medium">+{formatCurrency(po.rawDiff)} over</span>
                                  : <span className="text-emerald-700 font-medium">{formatCurrency(Math.abs(po.rawDiff))} under</span>
                              }
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
