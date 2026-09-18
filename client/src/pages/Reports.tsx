import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { formatCurrency } from "@/lib/invoiceUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TrendingUp, TrendingDown, Minus, FileText,
  CheckCircle2, AlertTriangle, ExternalLink,
  ChevronDown, ChevronRight, SlidersHorizontal,
  ArrowDown, ArrowUp, RotateCcw, CalendarDays, GripVertical,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_REPORT_COLUMN_ORDER,
  filterReportRows,
  moveReportColumn,
  normalizeReportColumnOrder,
  REPORT_COLUMNS,
  type ReportColumnId,
  type ReportFilters,
  reportDateRangeForPreset,
} from "@/lib/reportCustomisation";

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

const COLUMN_ORDER_STORAGE_KEY = "containerzone-report-column-order";
const VISIBLE_COLUMNS_STORAGE_KEY = "containerzone-report-visible-columns";
const EMPTY_FILTERS: ReportFilters = { supplier: "", fromDate: "", toDate: "" };

function storedColumnOrder(): ReportColumnId[] {
  try {
    return normalizeReportColumnOrder(JSON.parse(localStorage.getItem(COLUMN_ORDER_STORAGE_KEY) ?? "null"));
  } catch {
    return [...DEFAULT_REPORT_COLUMN_ORDER];
  }
}

function storedVisibleColumns(): Set<ReportColumnId> {
  try {
    const ids = normalizeReportColumnOrder(JSON.parse(localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY) ?? "null"));
    const stored = JSON.parse(localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY) ?? "null");
    return Array.isArray(stored) ? new Set(ids.filter((id) => stored.includes(id))) : new Set(DEFAULT_REPORT_COLUMN_ORDER);
  } catch {
    return new Set(DEFAULT_REPORT_COLUMN_ORDER);
  }
}

function DiffBadge({ diff }: { diff: number }) {
  if (Math.abs(diff) < 0.01) {
    return <Badge variant="secondary" className="gap-1 text-xs"><Minus className="h-3 w-3" /> Exact match</Badge>;
  }
  if (diff > 0) {
    return <Badge className="gap-1 text-xs bg-red-100 text-red-800 border-red-200 hover:bg-red-100">
      <TrendingUp className="h-3 w-3" /> +{formatCurrency(diff)} over
    </Badge>;
  }
  return <Badge className="gap-1 text-xs bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100">
    <TrendingDown className="h-3 w-3" /> {formatCurrency(Math.abs(diff))} under
  </Badge>;
}

function ApprovalBadge({ row }: { row: VarianceRow }) {
  if (row.adminApproved) {
    return <Badge className="text-xs bg-violet-100 text-violet-800 border-violet-200 hover:bg-violet-100">Admin Approved</Badge>;
  }
  if (row.staffApproved) {
    return <Badge className="text-xs bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-100">Staff Approved</Badge>;
  }
  return <span className="text-sm text-muted-foreground">—</span>;
}

function displayInvoiceDate(value: string | null): string | null {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return iso ? `${iso[3]}-${iso[2]}-${iso[1].slice(-2)}` : value;
}

export default function Reports() {
  const [, setLocation] = useLocation();
  const { data, isLoading, error } = trpc.reports.poVariance.useQuery();
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [filters, setFilters] = useState<ReportFilters>(EMPTY_FILTERS);
  const [columnOrder, setColumnOrder] = useState<ReportColumnId[]>(storedColumnOrder);
  const [visibleColumns, setVisibleColumns] = useState<Set<ReportColumnId>>(storedVisibleColumns);
  const [isColumnPanelOpen, setIsColumnPanelOpen] = useState(false);
  const [draggedColumn, setDraggedColumn] = useState<ReportColumnId | null>(null);

  useEffect(() => {
    localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

  useEffect(() => {
    localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(Array.from(visibleColumns)));
  }, [visibleColumns]);

  const rows: VarianceRow[] = data ?? [];
  const suppliers = useMemo(
    () => Array.from(new Set(rows.map((row) => row.supplierName?.trim()).filter((name): name is string => Boolean(name)))).sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const filteredRows = useMemo(() => filterReportRows(rows, filters), [rows, filters]);
  const activeColumns = columnOrder.filter((id) => visibleColumns.has(id));
  const columnById = useMemo(() => new Map(REPORT_COLUMNS.map((column) => [column.id, column])), []);
  const gridTemplateColumns = `1.5rem ${activeColumns.map((id) => columnById.get(id)?.minWidth ?? "minmax(8rem, 1fr)").join(" ")} 5.25rem`;
  const hasActiveFilters = Boolean(filters.supplier || filters.fromDate || filters.toDate);

  const totalInvoices = filteredRows.length;
  const totalInvoiceValue = filteredRows.reduce((sum, row) => sum + (row.extractedTotal ?? 0), 0);
  const totalPOValue = filteredRows.reduce((sum, row) => sum + (row.xeroTotal ?? row.extractedTotal ?? 0), 0);
  const netVariance = filteredRows.reduce((sum, row) => sum + row.totalNetDiff, 0);
  const overBilledCount = filteredRows.filter((row) => row.totalNetDiff > 0.01).length;
  const underBilledCount = filteredRows.filter((row) => row.totalNetDiff < -0.01).length;
  const exactMatchCount = filteredRows.filter((row) => Math.abs(row.totalNetDiff) <= 0.01).length;

  const toggleRow = (id: number) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const updateFilter = <K extends keyof ReportFilters>(key: K, value: ReportFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
  };

  const applyPreset = (preset: "month" | "30d" | "90d") => {
    setFilters((previous) => ({ ...previous, ...reportDateRangeForPreset(preset) }));
  };

  const resetFilters = () => setFilters(EMPTY_FILTERS);
  const resetColumns = () => {
    setColumnOrder([...DEFAULT_REPORT_COLUMN_ORDER]);
    setVisibleColumns(new Set(DEFAULT_REPORT_COLUMN_ORDER));
  };

  const toggleColumn = (id: ReportColumnId) => {
    setVisibleColumns((previous) => {
      if (previous.has(id) && previous.size === 1) return previous;
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const moveColumnByDirection = (id: ReportColumnId, direction: -1 | 1) => {
    const index = columnOrder.indexOf(id);
    const destination = columnOrder[index + direction];
    if (destination) setColumnOrder((previous) => moveReportColumn(previous, id, destination));
  };

  const renderCell = (columnId: ReportColumnId, row: VarianceRow) => {
    switch (columnId) {
      case "invoice":
        return <span className="text-sm font-medium truncate">
          {row.invoiceNumber ?? `#${row.invoiceId}`}
          {row.invoiceDate && <span className="text-xs text-muted-foreground ml-1.5">{displayInvoiceDate(row.invoiceDate)}</span>}
        </span>;
      case "supplier":
        return <span className="text-sm text-muted-foreground truncate">{row.supplierName ?? "—"}</span>;
      case "invoiceAmount":
        return <span className="text-sm text-right tabular-nums">{formatCurrency(row.extractedTotal)}</span>;
      case "poTotal":
        return <span className="text-sm text-right tabular-nums text-muted-foreground">{formatCurrency(row.xeroTotal)}</span>;
      case "variance":
        return <span className="text-right"><DiffBadge diff={row.totalNetDiff} /></span>;
      case "approval":
        return <span><ApprovalBadge row={row} /></span>;
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">PO Variance Report</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Approved invoices — net over/under position vs Xero Purchase Orders</p>
        </div>
        <Badge variant="outline" className="w-fit gap-1.5 text-xs font-normal"><SlidersHorizontal className="h-3.5 w-3.5" /> Your layout is saved on this device</Badge>
      </div>

      <Card>
        <CardContent className="pt-5 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="report-from-date" className="text-xs">Invoice date from</Label>
                <Input id="report-from-date" type="date" value={filters.fromDate} max={filters.toDate || undefined} onChange={(event) => updateFilter("fromDate", event.target.value)} className="h-9 w-full" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="report-to-date" className="text-xs">Invoice date to</Label>
                <Input id="report-to-date" type="date" value={filters.toDate} min={filters.fromDate || undefined} onChange={(event) => updateFilter("toDate", event.target.value)} className="h-9 w-full" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="report-supplier" className="text-xs">Supplier</Label>
                <select id="report-supplier" value={filters.supplier} onChange={(event) => updateFilter("supplier", event.target.value)} className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]">
                  <option value="">All suppliers ({suppliers.length})</option>
                  {suppliers.map((supplier) => <option key={supplier} value={supplier}>{supplier}</option>)}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 text-xs text-muted-foreground mr-1"><CalendarDays className="h-3.5 w-3.5" /> Quick range</span>
              <Button variant="outline" size="sm" onClick={() => applyPreset("month")}>This month</Button>
              <Button variant="outline" size="sm" onClick={() => applyPreset("30d")}>Last 30 days</Button>
              <Button variant="outline" size="sm" onClick={() => applyPreset("90d")}>Last 90 days</Button>
              {hasActiveFilters && <Button variant="ghost" size="sm" className="gap-1" onClick={resetFilters}><RotateCcw className="h-3.5 w-3.5" /> Clear</Button>}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Filters use the <strong>invoice issue date</strong>, not the date the report was verified or approved.</p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-24 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">{hasActiveFilters ? "Matching Invoices" : "Approved Invoices"}</p><p className="text-2xl font-bold mt-1">{totalInvoices}</p></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Total Invoice Value</p><p className="text-xl font-bold mt-1">{formatCurrency(totalInvoiceValue)}</p></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Current PO Value</p><p className="text-xl font-bold mt-1">{formatCurrency(totalPOValue)}</p></CardContent></Card>
          <Card className={cn(netVariance > 0.01 ? "border-red-200 bg-red-50" : netVariance < -0.01 ? "border-emerald-200 bg-emerald-50" : "")}><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Net Variance</p><p className={cn("text-xl font-bold mt-1", netVariance > 0.01 ? "text-red-700" : netVariance < -0.01 ? "text-emerald-700" : "")}>{netVariance > 0.01 ? "+" : ""}{formatCurrency(netVariance)}</p><p className="text-xs text-muted-foreground mt-0.5">{netVariance > 0.01 ? "net over-billed" : netVariance < -0.01 ? "net under-billed" : "balanced"}</p></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Over-billed</p><p className="text-2xl font-bold mt-1 text-red-700">{overBilledCount}</p><p className="text-xs text-muted-foreground">invoices</p></CardContent></Card>
          <Card><CardContent className="pt-4 pb-3"><p className="text-xs text-muted-foreground">Under-billed</p><p className="text-2xl font-bold mt-1 text-emerald-700">{underBilledCount}</p><p className="text-xs text-muted-foreground">{exactMatchCount} exact match{exactMatchCount !== 1 ? "es" : ""}</p></CardContent></Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-4 space-y-0">
          <div>
            <CardTitle className="text-base">Invoice Variance Detail</CardTitle>
            {!isLoading && <p className="text-xs text-muted-foreground mt-1">Showing {filteredRows.length} of {rows.length} approved or resolved invoice{rows.length === 1 ? "" : "s"}</p>}
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setIsColumnPanelOpen((open) => !open)} aria-expanded={isColumnPanelOpen}>
            <SlidersHorizontal className="h-3.5 w-3.5" /> Columns
          </Button>
        </CardHeader>
        {isColumnPanelOpen && (
          <div className="mx-6 mb-4 rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
              <div><p className="text-sm font-medium">Column layout</p><p className="text-xs text-muted-foreground">Drag a table header to reorder it, or use the controls below. Your choices remain on this device.</p></div>
              <Button variant="ghost" size="sm" className="w-fit gap-1" onClick={resetColumns}><RotateCcw className="h-3.5 w-3.5" /> Reset layout</Button>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {columnOrder.map((id, index) => {
                const column = columnById.get(id)!;
                const checked = visibleColumns.has(id);
                return <div key={id} className="flex items-center gap-1 rounded-md border bg-background px-2 py-1.5">
                  <input id={`report-column-${id}`} type="checkbox" checked={checked} onChange={() => toggleColumn(id)} disabled={checked && visibleColumns.size === 1} className="h-3.5 w-3.5 accent-primary" />
                  <Label htmlFor={`report-column-${id}`} className="flex-1 cursor-pointer text-xs font-normal">{column.label}</Label>
                  <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === 0} onClick={() => moveColumnByDirection(id, -1)} aria-label={`Move ${column.label} left`}><ArrowUp className="h-3 w-3 -rotate-90" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === columnOrder.length - 1} onClick={() => moveColumnByDirection(id, 1)} aria-label={`Move ${column.label} right`}><ArrowDown className="h-3 w-3 -rotate-90" /></Button>
                </div>;
              })}
            </div>
          </div>
        )}
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-12 w-full rounded-lg" />)}</div>
          ) : error ? (
            <div className="p-6 text-center text-sm text-muted-foreground"><AlertTriangle className="h-8 w-8 mx-auto mb-2 text-amber-400" />Failed to load report data.</div>
          ) : filteredRows.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground"><FileText className="h-10 w-10 mx-auto mb-3 opacity-30" /><p className="font-medium">{rows.length === 0 ? "No approved invoices yet" : "No invoices match these filters"}</p><p className="mt-1">{rows.length === 0 ? "Approved and resolved invoices will appear here with their PO variance data." : "Try changing the invoice-date range or supplier."}</p></div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[48rem] divide-y">
                <div className="grid gap-3 px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/40" style={{ gridTemplateColumns }}>
                  <span />
                  {activeColumns.map((id) => {
                    const column = columnById.get(id)!;
                    return <button key={id} type="button" draggable onDragStart={() => setDraggedColumn(id)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedColumn) setColumnOrder((order) => moveReportColumn(order, draggedColumn, id)); setDraggedColumn(null); }} onDragEnd={() => setDraggedColumn(null)} className={cn("flex min-w-0 items-center gap-1 text-left hover:text-foreground cursor-grab active:cursor-grabbing", column.align === "right" && "justify-end text-right")} title={`Drag to move ${column.label}`}><GripVertical className="h-3 w-3 shrink-0 opacity-50" />{column.label}</button>;
                  })}
                  <span />
                </div>
                {filteredRows.map((row) => {
                  const expanded = expandedRows.has(row.invoiceId);
                  return <div key={row.invoiceId}>
                    <div className="grid gap-3 px-4 py-3 items-center hover:bg-muted/30 cursor-pointer transition-colors" style={{ gridTemplateColumns }} onClick={() => row.poBreakdown.length > 0 && toggleRow(row.invoiceId)}>
                      <span className="text-muted-foreground">{row.poBreakdown.length > 0 ? expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" /> : null}</span>
                      {activeColumns.map((id) => <div key={id} className="min-w-0">{renderCell(id, row)}</div>)}
                      <span><Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1" onClick={(event) => { event.stopPropagation(); setLocation(`/invoices/${row.invoiceId}`); }}><ExternalLink className="h-3 w-3" /> View</Button></span>
                    </div>
                    {expanded && row.poBreakdown.length > 0 && <div className="bg-muted/20 border-t px-8 py-3 space-y-1.5"><p className="text-xs font-semibold text-muted-foreground mb-2">Per-PO breakdown</p>{row.poBreakdown.map((po) => <div key={po.poNumber} className="grid grid-cols-[8rem_7rem_7rem_1fr] gap-3 text-xs items-center"><span className="font-mono font-medium">{po.poNumber}</span><span className="text-right tabular-nums text-muted-foreground">Inv: {formatCurrency(po.invoiceLineItemTotal)}</span><span className="text-right tabular-nums text-muted-foreground">PO: {formatCurrency(po.poTotal)}</span><span>{Math.abs(po.rawDiff) < 0.01 ? <span className="text-muted-foreground flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" /> Match</span> : po.overBilled ? <span className="text-red-700 font-medium">+{formatCurrency(po.rawDiff)} over</span> : <span className="text-emerald-700 font-medium">{formatCurrency(Math.abs(po.rawDiff))} under</span>}</span></div>)}</div>}
                  </div>;
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
