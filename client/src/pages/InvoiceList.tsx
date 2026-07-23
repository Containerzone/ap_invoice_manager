import { useState, useMemo, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/StatusBadge";
import { formatRelativeTime } from "@/lib/invoiceUtils";
import { Upload, Search, FileText, Filter, Users, ChevronUp, ChevronDown, ChevronsUpDown, X, MessageSquare, StickyNote } from "lucide-react";

// ── Status options ────────────────────────────────────────────────────────────
const STATUS_OPTIONS = [
  { value: "uploaded", label: "Uploaded" },
  { value: "extracting", label: "Extracting" },
  { value: "extracted", label: "Extracted" },
  { value: "verified", label: "Verified" },
  { value: "under_budget", label: "Under Budget" },
  { value: "approved", label: "Approved" },
  { value: "flagged", label: "Flagged" },
  { value: "queried", label: "1st Query Sent" },
  { value: "queried_2nd", label: "2nd Query Sent" },
  { value: "queried_3rd", label: "3rd Query Sent" },
  { value: "queried_4th", label: "4th Query Sent" },
  { value: "queried_5th", label: "5th Query Sent" },
  { value: "resolved", label: "Resolved" },
  { value: "duplicate", label: "Duplicate" },
  { value: "archived", label: "Archived" },
];

// ── Sort config ───────────────────────────────────────────────────────────────
type SortKey = "invoiceNumber" | "poNumber" | "supplier" | "amount" | "issueDate" | "dueDate" | "received" | "status";
type SortDir = "asc" | "desc";

function formatShortDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "2-digit" });
  } catch {
    return "—";
  }
}

function formatCurrency(amount: string | number | null | undefined): string {
  if (amount == null || amount === "") return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "—";
  return `$${num.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getSortValue(invoice: any, key: SortKey): string | number {
  switch (key) {
    case "invoiceNumber": return invoice.extractedInvoiceNumber ?? invoice.originalFileName ?? `${invoice.id}`;
    case "poNumber": return invoice.extractedPoNumber ?? "";
    case "supplier": return invoice.extractedSupplierName ?? "";
    case "amount": return invoice.extractedTotal ? parseFloat(invoice.extractedTotal) : 0;
    case "issueDate": return invoice.extractedInvoiceDate ? new Date(invoice.extractedInvoiceDate).getTime() : 0;
    case "dueDate": return invoice.extractedDueDate ? new Date(invoice.extractedDueDate).getTime() : 0;
    case "received": return invoice.createdAt ? new Date(invoice.createdAt).getTime() : 0;
    case "status": return invoice.status ?? "";
    default: return "";
  }
}

// ── Sort icon component ───────────────────────────────────────────────────────
function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 ml-1 opacity-40" />;
  return dir === "asc"
    ? <ChevronUp className="h-3 w-3 ml-1 text-foreground" />
    : <ChevronDown className="h-3 w-3 ml-1 text-foreground" />;
}

// ── Multi-select status dropdown ──────────────────────────────────────────────
function StatusMultiSelect({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const label =
    selected.size === 0
      ? "All Statuses"
      : selected.size === 1
      ? STATUS_OPTIONS.find((o) => o.value === Array.from(selected)[0])?.label ?? "1 selected"
      : `${selected.size} statuses`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm text-foreground shadow-sm hover:bg-muted/50 transition-colors min-w-[11rem] justify-between"
      >
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          <span className={selected.size > 0 ? "text-foreground font-medium" : ""}>{label}</span>
        </span>
        <span className="flex items-center gap-1">
          {selected.size > 0 && (
            <span
              role="button"
              tabIndex={0}
              className="rounded-full hover:bg-muted p-0.5"
              onClick={(e) => { e.stopPropagation(); onChange(new Set()); }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onChange(new Set()); } }}
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-52 rounded-md border border-border bg-popover shadow-md py-1 max-h-72 overflow-y-auto">
          {STATUS_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50 text-sm select-none"
            >
              <Checkbox
                checked={selected.has(opt.value)}
                onCheckedChange={() => toggle(opt.value)}
                className="h-3.5 w-3.5"
              />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function InvoiceList() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("received");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // If "archived" is one of the selected statuses, we need to fetch archived records from the backend
  const isArchivedSelected = selectedStatuses.has("archived");
  const isOnlyArchivedSelected = isArchivedSelected && selectedStatuses.size === 1;

  const { data: invoices, isLoading } = trpc.invoices.list.useQuery({
    search: search || undefined,
    includeArchived: isArchivedSelected ? true : undefined,
  });

  // ── Client-side filter + sort ─────────────────────────────────────────────
  const displayedInvoices = useMemo(() => {
    if (!invoices) return [];

    // 1. Status filter — archived invoices are identified by archivedAt being set
    let filtered: typeof invoices;
    if (selectedStatuses.size === 0) {
      // No filter: exclude archived (archivedAt is null for normal invoices returned by backend)
      filtered = invoices.filter((inv) => !(inv as any).archivedAt);
    } else {
      filtered = invoices.filter((inv) => {
        const hasArchivedAt = !!(inv as any).archivedAt;
        // For each selected status:
        return Array.from(selectedStatuses).some((s) => {
          if (s === "archived") return hasArchivedAt;
          return inv.status === s && !hasArchivedAt;
        });
      });
    }

    // 2. Sort — resolved/archived always goes to the bottom regardless of sort key
    filtered = [...filtered].sort((a, b) => {
      const aResolved = a.status === "resolved" || !!(a as any).archivedAt;
      const bResolved = b.status === "resolved" || !!(b as any).archivedAt;
      if (aResolved && !bResolved) return 1;
      if (!aResolved && bResolved) return -1;

      const aVal = getSortValue(a, sortKey);
      const bVal = getSortValue(b, sortKey);
      let cmp = 0;
      if (typeof aVal === "number" && typeof bVal === "number") {
        cmp = aVal - bVal;
      } else {
        cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true, sensitivity: "base" });
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return filtered;
  }, [invoices, selectedStatuses, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // ── Sortable header cell ──────────────────────────────────────────────────
  const SortHeader = ({ col, label, className }: { col: SortKey; label: string; className?: string }) => (
    <button
      onClick={() => handleSort(col)}
      className={`flex items-center gap-0.5 uppercase tracking-wider text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group ${className ?? ""}`}
    >
      {label}
      <SortIcon active={sortKey === col} dir={sortDir} />
    </button>
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {displayedInvoices.length} invoice{displayedInvoices.length !== 1 ? "s" : ""} total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setLocation("/invoices/bulk-query")}
            className="gap-2 shadow-sm"
          >
            <Users className="h-4 w-4" />
            Bulk Query
          </Button>
          <Button onClick={() => setLocation("/invoices/upload")} className="gap-2 shadow-sm">
            <Upload className="h-4 w-4" />
            Upload Invoice
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search invoices, suppliers, PO numbers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <StatusMultiSelect selected={selectedStatuses} onChange={setSelectedStatuses} />
      </div>

      {/* Table */}
      <Card className="border shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="divide-y divide-border">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="h-9 w-9 rounded-lg" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ) : displayedInvoices.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/25 mb-4" />
            <p className="text-base font-medium text-foreground">No invoices found</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              {search || selectedStatuses.size > 0
                ? "Try adjusting your filters"
                : "Upload your first invoice to get started"}
            </p>
            {!search && selectedStatuses.size === 0 && (
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setLocation("/invoices/upload")}
              >
                <Upload className="h-3.5 w-3.5" />
                Upload Invoice
              </Button>
            )}
          </CardContent>
        ) : (
          <TooltipProvider>
            <>
              {/* Desktop table header — sortable */}
              <div className="hidden xl:grid grid-cols-[1.3fr_0.8fr_1.1fr_0.7fr_0.7fr_0.7fr_0.7fr_0.5fr_0.9fr] gap-3 px-5 py-2.5 bg-muted/40 border-b">
                <SortHeader col="invoiceNumber" label="Invoice #" />
                <SortHeader col="poNumber" label="PO Number" />
                <SortHeader col="supplier" label="Supplier" />
                <SortHeader col="amount" label="Amount" />
                <SortHeader col="issueDate" label="Issue Date" />
                <SortHeader col="dueDate" label="Due Date" />
                <SortHeader col="received" label="Received" />
                <span className="uppercase tracking-wider text-xs font-medium text-muted-foreground">Notes</span>
                <SortHeader col="status" label="Status" />
              </div>
              {/* Tablet header */}
              <div className="xl:hidden hidden md:grid grid-cols-[1fr_1fr_0.7fr_1fr] gap-3 px-5 py-2.5 bg-muted/40 border-b">
                <SortHeader col="invoiceNumber" label="Invoice #" />
                <SortHeader col="supplier" label="Supplier" />
                <SortHeader col="amount" label="Amount" />
                <SortHeader col="status" label="Status" />
              </div>

              <div className="divide-y divide-border">
                {displayedInvoices.map((invoice) => (
                  <div
                    key={invoice.id}
                    className={`grid grid-cols-1 md:grid-cols-[1fr_1fr_0.7fr_1fr] xl:grid-cols-[1.3fr_0.8fr_1.1fr_0.7fr_0.7fr_0.7fr_0.7fr_0.5fr_0.9fr] gap-2 md:gap-3 items-center px-5 py-3.5 hover:bg-muted/20 cursor-pointer transition-colors ${invoice.status === "resolved" ? "opacity-60" : ""}`}
                    onClick={() => window.open(`/invoices/${invoice.id}`, '_blank', 'noopener,noreferrer')}
                  >
                    {/* Col 1: Invoice # */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0 hidden sm:flex">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {invoice.extractedInvoiceNumber ?? invoice.originalFileName ?? `#${invoice.id}`}
                        </p>
                        <p className="text-xs text-muted-foreground truncate xl:hidden">
                          {invoice.extractedPoNumber ?? "No PO"}
                        </p>
                      </div>
                    </div>

                    {/* Col 2: PO Number (desktop only) */}
                    <span className="text-sm text-foreground truncate hidden xl:block">
                      {invoice.extractedPoNumber ?? "—"}
                    </span>

                    {/* Col 3: Supplier */}
                    <span className="text-sm text-foreground truncate hidden md:block">
                      {invoice.extractedSupplierName ?? "—"}
                    </span>

                    {/* Col 4: Amount (GST-inclusive) */}
                    <span className="text-sm font-medium text-foreground hidden md:block">
                      {formatCurrency(invoice.extractedTotal)}
                    </span>

                    {/* Col 5: Issue Date */}
                    <span className="text-xs text-muted-foreground hidden xl:block">
                      {formatShortDate(invoice.extractedInvoiceDate)}
                    </span>

                    {/* Col 6: Due Date (desktop only) */}
                    <span className="text-xs text-muted-foreground hidden xl:block">
                      {formatShortDate(invoice.extractedDueDate)}
                    </span>

                    {/* Col 7: Received Date (desktop only) */}
                    <span className="text-xs text-muted-foreground hidden xl:block">
                      {formatRelativeTime(invoice.createdAt)}
                    </span>

                    {/* Col 8: Notes icons */}
                    <div className="hidden xl:flex items-center gap-1.5">
                      {(invoice as any).queryNoteCount > 0 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">
                              <MessageSquare className="h-3 w-3" />
                              {(invoice as any).queryNoteCount}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Query Notes ({(invoice as any).queryNoteCount})</TooltipContent>
                        </Tooltip>
                      )}
                      {(invoice as any).internalNoteCount > 0 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-purple-600 bg-purple-50 border border-purple-200 px-1.5 py-0.5 rounded">
                              <StickyNote className="h-3 w-3" />
                              {(invoice as any).internalNoteCount}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Internal Notes ({(invoice as any).internalNoteCount})</TooltipContent>
                        </Tooltip>
                      )}
                    </div>

                    {/* Col 9: Status */}
                    <div className="flex items-center gap-2">
                      <StatusBadge status={invoice.status} size="sm" />
                      {invoice.hasDiscrepancy && (
                        <span className="text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full hidden lg:inline">
                          Δ
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          </TooltipProvider>
        )}
      </Card>
    </div>
  );
}
