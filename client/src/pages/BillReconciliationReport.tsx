import { trpc } from "@/lib/trpc";
import { formatCurrency, formatRelativeTime } from "@/lib/invoiceUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowDown, ArrowUp, CalendarDays, CheckCircle2,
  ChevronDown, ChevronRight, CircleAlert, ExternalLink, FileCheck2,
  FileText, GripVertical, RefreshCw, RotateCcw, SlidersHorizontal,
  Unplug, XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  BILL_RECONCILIATION_COLUMNS,
  DEFAULT_BILL_RECONCILIATION_COLUMN_ORDER,
  filterReportRows,
  moveReportColumn,
  normalizeBillReconciliationColumnOrder,
  reportDateRangeForPreset,
  type BillReconciliationColumnId,
  type ReportFilters,
} from "@/lib/reportCustomisation";

export type ReconciliationRow = {
  invoiceId: number;
  invoiceNumber: string | null;
  supplierName: string | null;
  invoiceDate: string | null;
  localStatus: string | null;
  invoiceTotal: number | null;
  currencyCode: string | null;
  xeroBillId: string | null;
  xeroBillNumber: string | null;
  xeroBillStatus: string | null;
  xeroBillContact: string | null;
  xeroBillSubtotal: number | null;
  xeroBillTax: number | null;
  xeroBillTotal: number | null;
  difference: number | null;
  reconciliationStatus: "matched" | "amount_differs" | "not_pushed" | "needs_refresh" | "xero_bill_unavailable" | "refresh_failed";
  lastReconciledAt: string | null;
  refreshError: string | null;
};

const ORDER_STORAGE_KEY = "containerzone-bill-reconciliation-column-order";
const VISIBLE_STORAGE_KEY = "containerzone-bill-reconciliation-visible-columns";
const EMPTY_FILTERS: ReportFilters = { supplier: "", fromDate: "", toDate: "" };

type StatusFilter = "all" | ReconciliationRow["reconciliationStatus"];

function storedOrder(): BillReconciliationColumnId[] {
  try { return normalizeBillReconciliationColumnOrder(JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) ?? "null")); }
  catch { return [...DEFAULT_BILL_RECONCILIATION_COLUMN_ORDER]; }
}

function storedVisible(): Set<BillReconciliationColumnId> {
  try {
    const raw = JSON.parse(localStorage.getItem(VISIBLE_STORAGE_KEY) ?? "null");
    const normalized = normalizeBillReconciliationColumnOrder(raw);
    return Array.isArray(raw) ? new Set(normalized.filter((id) => raw.includes(id))) : new Set(DEFAULT_BILL_RECONCILIATION_COLUMN_ORDER);
  } catch { return new Set(DEFAULT_BILL_RECONCILIATION_COLUMN_ORDER); }
}

function displayInvoiceDate(value: string | null): string | null {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return iso ? `${iso[3]}-${iso[2]}-${iso[1].slice(-2)}` : value;
}

function ReconciliationBadge({ status }: { status: ReconciliationRow["reconciliationStatus"] }) {
  const config = {
    matched: { label: "Matched", icon: CheckCircle2, className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
    amount_differs: { label: "Amount differs", icon: CircleAlert, className: "bg-red-100 text-red-800 border-red-200" },
    not_pushed: { label: "No linked bill", icon: Unplug, className: "bg-slate-100 text-slate-700 border-slate-200" },
    needs_refresh: { label: "Needs refresh", icon: RefreshCw, className: "bg-amber-100 text-amber-800 border-amber-200" },
    xero_bill_unavailable: { label: "Bill unavailable", icon: XCircle, className: "bg-rose-100 text-rose-800 border-rose-200" },
    refresh_failed: { label: "Refresh failed", icon: AlertTriangle, className: "bg-rose-100 text-rose-800 border-rose-200" },
  }[status];
  const Icon = config.icon;
  return <Badge className={cn("gap-1 text-xs hover:bg-inherit", config.className)}><Icon className="h-3 w-3" />{config.label}</Badge>;
}

function DifferenceValue({ difference, currency }: { difference: number | null; currency?: string | null }) {
  if (difference === null) return <span className="text-sm text-muted-foreground">—</span>;
  if (Math.abs(difference) <= 0.01) return <span className="text-sm font-medium text-emerald-700">$0.00</span>;
  return <span className={cn("text-sm font-medium tabular-nums", difference > 0 ? "text-red-700" : "text-emerald-700")}>
    {difference > 0 ? "+" : ""}{formatCurrency(difference, currency ?? "AUD")}
  </span>;
}

function ReportTabs({ active, onSelectVariance }: { active: "bills"; onSelectVariance: () => void }) {
  return <div className="flex w-fit rounded-lg border bg-muted/40 p-1" role="tablist" aria-label="Report type">
    <Button variant="ghost" size="sm" role="tab" aria-selected={false} onClick={onSelectVariance} className="h-8">PO Variance</Button>
    <Button variant="secondary" size="sm" role="tab" aria-selected={active === "bills"} className="h-8 shadow-sm">Xero Bill Reconciliation</Button>
  </div>;
}

export default function BillReconciliationReport({ onSelectVariance }: { onSelectVariance: () => void }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.reports.billReconciliation.useQuery();
  const refreshMutation = trpc.reports.refreshBillReconciliation.useMutation({
    onSuccess: async (result) => {
      await utils.reports.billReconciliation.invalidate();
      const messages = [`${result.refreshed} refreshed`];
      if (result.unavailable) messages.push(`${result.unavailable} unavailable`);
      if (result.failed) messages.push(`${result.failed} failed`);
      if (result.skipped) messages.push(`${result.skipped} not linked`);
      toast.success(`Xero reconciliation refresh complete: ${messages.join(", ")}.`);
    },
    onError: (error) => toast.error(error.message ?? "Xero bill refresh failed."),
  });
  const [filters, setFilters] = useState<ReportFilters>(EMPTY_FILTERS);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [columnOrder, setColumnOrder] = useState<BillReconciliationColumnId[]>(storedOrder);
  const [visibleColumns, setVisibleColumns] = useState<Set<BillReconciliationColumnId>>(storedVisible);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<BillReconciliationColumnId | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(columnOrder)); }, [columnOrder]);
  useEffect(() => { localStorage.setItem(VISIBLE_STORAGE_KEY, JSON.stringify(Array.from(visibleColumns))); }, [visibleColumns]);

  const rows: ReconciliationRow[] = data ?? [];
  const suppliers = useMemo(() => Array.from(new Set(rows.map((row) => row.supplierName?.trim()).filter((name): name is string => Boolean(name)))).sort((a, b) => a.localeCompare(b)), [rows]);
  const filteredRows = useMemo(() => filterReportRows(rows, filters).filter((row) => statusFilter === "all" || row.reconciliationStatus === statusFilter), [rows, filters, statusFilter]);
  const columnsById = useMemo(() => new Map(BILL_RECONCILIATION_COLUMNS.map((column) => [column.id, column])), []);
  const activeColumns = columnOrder.filter((id) => visibleColumns.has(id));
  const gridTemplateColumns = `1.5rem ${activeColumns.map((id) => columnsById.get(id)?.minWidth ?? "minmax(8rem, 1fr)").join(" ")} 5.25rem`;
  const linkedFilteredRows = filteredRows.filter((row) => row.xeroBillId);
  const canRefresh = linkedFilteredRows.length > 0 && !refreshMutation.isPending;
  const hasFilters = Boolean(filters.supplier || filters.fromDate || filters.toDate || statusFilter !== "all");

  const totalInvoiceAmount = filteredRows.reduce((sum, row) => sum + (row.invoiceTotal ?? 0), 0);
  const totalXeroAmount = filteredRows.reduce((sum, row) => sum + (row.xeroBillTotal ?? 0), 0);
  const matchedCount = filteredRows.filter((row) => row.reconciliationStatus === "matched").length;
  const differingCount = filteredRows.filter((row) => row.reconciliationStatus === "amount_differs").length;
  const needsActionCount = filteredRows.filter((row) => ["needs_refresh", "xero_bill_unavailable", "refresh_failed"].includes(row.reconciliationStatus)).length;
  const netDifference = filteredRows.reduce((sum, row) => sum + (row.difference ?? 0), 0);

  const updateFilter = <K extends keyof ReportFilters>(key: K, value: ReportFilters[K]) => setFilters((previous) => ({ ...previous, [key]: value }));
  const resetFilters = () => { setFilters(EMPTY_FILTERS); setStatusFilter("all"); };
  const applyPreset = (preset: "month" | "30d" | "90d") => setFilters((previous) => ({ ...previous, ...reportDateRangeForPreset(preset) }));
  const resetColumns = () => { setColumnOrder([...DEFAULT_BILL_RECONCILIATION_COLUMN_ORDER]); setVisibleColumns(new Set(DEFAULT_BILL_RECONCILIATION_COLUMN_ORDER)); };
  const toggleColumn = (id: BillReconciliationColumnId) => setVisibleColumns((previous) => {
    if (previous.has(id) && previous.size === 1) return previous;
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const moveColumn = (id: BillReconciliationColumnId, direction: -1 | 1) => {
    const destination = columnOrder[columnOrder.indexOf(id) + direction];
    if (destination) setColumnOrder((order) => moveReportColumn(order, id, destination));
  };
  const toggleExpanded = (id: number) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const refresh = () => {
    const ids = linkedFilteredRows.slice(0, 25).map((row) => row.invoiceId);
    if (!ids.length) { toast.info("There are no linked Xero bills in the current result set to refresh."); return; }
    refreshMutation.mutate({ invoiceIds: ids });
  };

  const renderCell = (column: BillReconciliationColumnId, row: ReconciliationRow) => {
    switch (column) {
      case "invoice": return <span className="text-sm font-medium truncate">{row.invoiceNumber ?? `#${row.invoiceId}`}{row.invoiceDate && <span className="ml-1.5 text-xs text-muted-foreground">{displayInvoiceDate(row.invoiceDate)}</span>}</span>;
      case "supplier": return <span className="text-sm text-muted-foreground truncate">{row.supplierName ?? "—"}</span>;
      case "invoiceAmount": return <span className="text-right text-sm tabular-nums">{formatCurrency(row.invoiceTotal, row.currencyCode ?? "AUD")}</span>;
      case "xeroBill": return <span className="text-sm font-mono truncate">{row.xeroBillNumber ?? (row.xeroBillId ? "Linked bill" : "—")}</span>;
      case "billStatus": return row.xeroBillStatus ? <Badge variant="outline" className="text-xs">{row.xeroBillStatus.replaceAll("_", " ")}</Badge> : <span className="text-sm text-muted-foreground">—</span>;
      case "xeroAmount": return <span className="text-right text-sm tabular-nums">{formatCurrency(row.xeroBillTotal, row.currencyCode ?? "AUD")}</span>;
      case "difference": return <span className="flex justify-end"><DifferenceValue difference={row.difference} currency={row.currencyCode} /></span>;
      case "reconciliationStatus": return <ReconciliationBadge status={row.reconciliationStatus} />;
      case "lastReconciled": return <span className="text-xs text-muted-foreground">{row.lastReconciledAt ? formatRelativeTime(row.lastReconciledAt) : "—"}</span>;
    }
  };

  return <div className="max-w-7xl mx-auto space-y-6">
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div><h1 className="text-2xl font-bold tracking-tight">Reports</h1><p className="mt-0.5 text-sm text-muted-foreground">Reconcile supplier invoice totals against the actual linked Xero supplier bill.</p></div>
      <ReportTabs active="bills" onSelectVariance={onSelectVariance} />
    </div>

    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5"><Label htmlFor="bill-report-from" className="text-xs">Invoice date from</Label><Input id="bill-report-from" type="date" value={filters.fromDate} max={filters.toDate || undefined} onChange={(event) => updateFilter("fromDate", event.target.value)} className="h-9" /></div>
            <div className="space-y-1.5"><Label htmlFor="bill-report-to" className="text-xs">Invoice date to</Label><Input id="bill-report-to" type="date" value={filters.toDate} min={filters.fromDate || undefined} onChange={(event) => updateFilter("toDate", event.target.value)} className="h-9" /></div>
            <div className="space-y-1.5"><Label htmlFor="bill-report-supplier" className="text-xs">Supplier</Label><select id="bill-report-supplier" value={filters.supplier} onChange={(event) => updateFilter("supplier", event.target.value)} className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"><option value="">All suppliers ({suppliers.length})</option>{suppliers.map((supplier) => <option key={supplier} value={supplier}>{supplier}</option>)}</select></div>
            <div className="space-y-1.5"><Label htmlFor="bill-report-status" className="text-xs">Reconciliation</Label><select id="bill-report-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"><option value="all">All statuses</option><option value="matched">Matched</option><option value="amount_differs">Amount differs</option><option value="not_pushed">Not pushed</option><option value="needs_refresh">Needs refresh</option><option value="xero_bill_unavailable">Bill unavailable</option><option value="refresh_failed">Refresh failed</option></select></div>
          </div>
          <div className="flex flex-wrap items-center gap-2"><span className="mr-1 flex items-center gap-1 text-xs text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" /> Quick range</span><Button variant="outline" size="sm" onClick={() => applyPreset("month")}>This month</Button><Button variant="outline" size="sm" onClick={() => applyPreset("30d")}>Last 30 days</Button><Button variant="outline" size="sm" onClick={() => applyPreset("90d")}>Last 90 days</Button>{hasFilters && <Button variant="ghost" size="sm" className="gap-1" onClick={resetFilters}><RotateCcw className="h-3.5 w-3.5" /> Clear</Button>}</div>
        </div>
        <div className="flex flex-col gap-2 rounded-md border border-sky-100 bg-sky-50/50 p-3 text-xs text-sky-950 sm:flex-row sm:items-center sm:justify-between"><p><strong>Refresh from Xero is read-only.</strong> It checks only the exact ACCPAY bill ID previously linked by this application, then stores a local reconciliation snapshot. It does not create, alter, approve, pay or delete any Xero bill.</p>{linkedFilteredRows.length > 25 && <Badge variant="outline" className="w-fit border-sky-200 bg-background text-sky-900">Refreshes first 25 linked bills</Badge>}</div>
      </CardContent>
    </Card>

    {isLoading ? <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-xl" />)}</div> : <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6"><Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Invoices</p><p className="mt-1 text-2xl font-bold">{filteredRows.length}</p></CardContent></Card><Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Invoice Total</p><p className="mt-1 text-xl font-bold">{formatCurrency(totalInvoiceAmount)}</p></CardContent></Card><Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Xero Bill Total</p><p className="mt-1 text-xl font-bold">{formatCurrency(totalXeroAmount)}</p></CardContent></Card><Card className={cn(netDifference > 0.01 ? "border-red-200 bg-red-50" : netDifference < -0.01 ? "border-emerald-200 bg-emerald-50" : "")}><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Net Difference</p><p className={cn("mt-1 text-xl font-bold", netDifference > 0.01 ? "text-red-700" : netDifference < -0.01 ? "text-emerald-700" : "")}>{netDifference > 0.01 ? "+" : ""}{formatCurrency(netDifference)}</p></CardContent></Card><Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Matched</p><p className="mt-1 text-2xl font-bold text-emerald-700">{matchedCount}</p></CardContent></Card><Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Needs Action</p><p className="mt-1 text-2xl font-bold text-amber-700">{needsActionCount + differingCount}</p><p className="text-xs text-muted-foreground">{differingCount} amounts differ</p></CardContent></Card></div>}

    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-3"><div><CardTitle className="text-base">Xero Bill Reconciliation</CardTitle>{!isLoading && <p className="mt-1 text-xs text-muted-foreground">Showing {filteredRows.length} of {rows.length} eligible invoice{rows.length === 1 ? "" : "s"}</p>}</div><div className="flex gap-2"><Button variant="outline" size="sm" className="gap-1.5" onClick={() => setColumnsOpen((value) => !value)}><SlidersHorizontal className="h-3.5 w-3.5" /> Columns</Button><Button size="sm" className="gap-1.5" disabled={!canRefresh} onClick={refresh}>{refreshMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh from Xero</Button></div></CardHeader>
      {columnsOpen && <div className="mx-6 mb-4 rounded-lg border bg-muted/30 p-3"><div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-medium">Column layout</p><p className="text-xs text-muted-foreground">Drag a table header to reorder it, or use the controls below. Your choices remain on this device.</p></div><Button variant="ghost" size="sm" className="w-fit gap-1" onClick={resetColumns}><RotateCcw className="h-3.5 w-3.5" /> Reset layout</Button></div><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{columnOrder.map((id, index) => { const column = columnsById.get(id)!; const checked = visibleColumns.has(id); return <div key={id} className="flex items-center gap-1 rounded-md border bg-background px-2 py-1.5"><input id={`bill-column-${id}`} type="checkbox" checked={checked} onChange={() => toggleColumn(id)} disabled={checked && visibleColumns.size === 1} className="h-3.5 w-3.5 accent-primary" /><Label htmlFor={`bill-column-${id}`} className="flex-1 cursor-pointer text-xs font-normal">{column.label}</Label><Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === 0} onClick={() => moveColumn(id, -1)} aria-label={`Move ${column.label} left`}><ArrowUp className="h-3 w-3 -rotate-90" /></Button><Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === columnOrder.length - 1} onClick={() => moveColumn(id, 1)} aria-label={`Move ${column.label} right`}><ArrowDown className="h-3 w-3 -rotate-90" /></Button></div>; })}</div></div>}
      <CardContent className="p-0">{isLoading ? <div className="space-y-3 p-6">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-12 w-full rounded-lg" />)}</div> : error ? <div className="p-8 text-center text-sm text-muted-foreground"><AlertTriangle className="mx-auto mb-2 h-8 w-8 text-amber-400" />Failed to load bill reconciliation data.</div> : filteredRows.length === 0 ? <div className="p-12 text-center text-sm text-muted-foreground"><FileCheck2 className="mx-auto mb-3 h-10 w-10 opacity-30" /><p className="font-medium">{rows.length ? "No invoices match these filters" : "No eligible invoices yet"}</p><p className="mt-1">{rows.length ? "Try changing the date, supplier or reconciliation filter." : "Approved and resolved work will appear here."}</p></div> : <div className="overflow-x-auto"><div className="min-w-[65rem] divide-y"><div className="grid gap-3 bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground" style={{ gridTemplateColumns }}><span />{activeColumns.map((id) => { const column = columnsById.get(id)!; return <button key={id} type="button" draggable onDragStart={() => setDraggedColumn(id)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedColumn) setColumnOrder((order) => moveReportColumn(order, draggedColumn, id)); setDraggedColumn(null); }} onDragEnd={() => setDraggedColumn(null)} className={cn("flex min-w-0 items-center gap-1 text-left hover:text-foreground cursor-grab active:cursor-grabbing", column.align === "right" && "justify-end text-right")} title={`Drag to move ${column.label}`}><GripVertical className="h-3 w-3 shrink-0 opacity-50" />{column.label}</button>; })}<span /></div>{filteredRows.map((row) => { const open = expanded.has(row.invoiceId); return <div key={row.invoiceId}><div className="grid cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30" style={{ gridTemplateColumns }} onClick={() => toggleExpanded(row.invoiceId)}><span className="text-muted-foreground">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>{activeColumns.map((id) => <div key={id} className="min-w-0">{renderCell(id, row)}</div>)}<span><Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={(event) => { event.stopPropagation(); setLocation(`/invoices/${row.invoiceId}`); }}><ExternalLink className="h-3 w-3" /> View</Button></span></div>{open && <div className="grid gap-4 border-t bg-muted/20 px-8 py-4 md:grid-cols-2"><div className="rounded-md border bg-background p-3"><p className="mb-2 text-xs font-semibold text-muted-foreground">Supplier invoice</p><dl className="grid grid-cols-2 gap-y-1.5 text-xs"><dt className="text-muted-foreground">Invoice total (inc. GST)</dt><dd className="text-right font-medium tabular-nums">{formatCurrency(row.invoiceTotal, row.currencyCode ?? "AUD")}</dd><dt className="text-muted-foreground">Invoice date</dt><dd className="text-right">{displayInvoiceDate(row.invoiceDate) ?? "—"}</dd><dt className="text-muted-foreground">Local workflow</dt><dd className="text-right capitalize">{row.localStatus?.replaceAll("_", " ") ?? "—"}</dd></dl></div><div className="rounded-md border bg-background p-3"><p className="mb-2 text-xs font-semibold text-muted-foreground">Linked Xero ACCPAY bill</p>{row.xeroBillId ? <dl className="grid grid-cols-2 gap-y-1.5 text-xs"><dt className="text-muted-foreground">Bill number</dt><dd className="text-right font-mono">{row.xeroBillNumber ?? "Awaiting refresh"}</dd><dt className="text-muted-foreground">Linked Xero bill ID</dt><dd className="text-right font-mono text-[10px] truncate" title={row.xeroBillId}>{row.xeroBillId}</dd><dt className="text-muted-foreground">Bill total (inc. GST)</dt><dd className="text-right font-medium tabular-nums">{formatCurrency(row.xeroBillTotal, row.currencyCode ?? "AUD")}</dd><dt className="text-muted-foreground">Subtotal / GST</dt><dd className="text-right tabular-nums">{row.xeroBillSubtotal == null ? "—" : `${formatCurrency(row.xeroBillSubtotal, row.currencyCode ?? "AUD")} / ${formatCurrency(row.xeroBillTax, row.currencyCode ?? "AUD")}`}</dd><dt className="text-muted-foreground">Xero status</dt><dd className="text-right">{row.xeroBillStatus ?? "Awaiting refresh"}</dd><dt className="text-muted-foreground">Difference</dt><dd className="flex justify-end"><DifferenceValue difference={row.difference} currency={row.currencyCode} /></dd>{row.xeroBillContact && <><dt className="text-muted-foreground">Xero contact</dt><dd className="text-right truncate">{row.xeroBillContact}</dd></>}{row.refreshError && <><dt className="col-span-2 mt-2 text-rose-700">{row.refreshError}</dt></>}</dl> : <p className="text-xs text-muted-foreground">No bill is linked to this invoice. It may not have been pushed through this app, or it may be a historic record created before the bill link was recorded. Refresh does not search by invoice number because that could select the wrong supplier or a customer invoice.</p>}</div></div>}</div>; })}</div></div>}</CardContent>
    </Card>
  </div>;
}
