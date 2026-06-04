import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { formatCurrency, formatRelativeTime } from "@/lib/invoiceUtils";
import { Upload, Search, FileText, Filter, Users } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const STATUS_OPTIONS = [
  { value: "all", label: "All Statuses" },
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
  { value: "resolved", label: "Resolved" },
  { value: "duplicate", label: "Duplicate" },
];

export default function InvoiceList() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: invoices, isLoading } = trpc.invoices.list.useQuery({
    status: statusFilter !== "all" ? statusFilter : undefined,
    search: search || undefined,
  });

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Invoices</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {invoices?.length ?? 0} invoice{invoices?.length !== 1 ? "s" : ""} total
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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44 h-9 gap-2">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
        ) : invoices?.length === 0 ? (
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/25 mb-4" />
            <p className="text-base font-medium text-foreground">No invoices found</p>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              {search || statusFilter !== "all"
                ? "Try adjusting your filters"
                : "Upload your first invoice to get started"}
            </p>
            {!search && statusFilter === "all" && (
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
          <>
            {/* Table header */}
            <div className="hidden md:grid grid-cols-[1fr_160px_120px_100px_100px] gap-4 px-5 py-2.5 bg-muted/40 border-b text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <span>Invoice</span>
              <span>Supplier</span>
              <span>Amount</span>
              <span>Date</span>
              <span>Status</span>
            </div>
            <div className="divide-y divide-border">
              {invoices?.map((invoice) => (
                <div
                  key={invoice.id}
                  className="grid grid-cols-1 md:grid-cols-[1fr_160px_120px_100px_100px] gap-2 md:gap-4 items-center px-5 py-3.5 hover:bg-muted/20 cursor-pointer transition-colors"
                  onClick={() => setLocation(`/invoices/${invoice.id}`)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {invoice.extractedInvoiceNumber ?? invoice.originalFileName ?? `Invoice #${invoice.id}`}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {invoice.extractedPoNumber && `PO: ${invoice.extractedPoNumber} · `}
                        {formatRelativeTime(invoice.createdAt)}
                      </p>
                    </div>
                  </div>
                  <span className="text-sm text-foreground truncate hidden md:block">
                    {invoice.extractedSupplierName ?? "—"}
                  </span>
                  <span className="text-sm font-medium text-foreground tabular-nums hidden md:block">
                    {formatCurrency(invoice.extractedTotal)}
                  </span>
                  <span className="text-xs text-muted-foreground hidden md:block">
                    {invoice.extractedInvoiceDate
                      ? new Date(invoice.extractedInvoiceDate).toLocaleDateString("en-AU", {
                          day: "2-digit", month: "short",
                        })
                      : "—"}
                  </span>
                  <div className="flex items-center justify-between md:justify-start">
                    <StatusBadge status={invoice.status} size="sm" />
                    {invoice.hasDiscrepancy && (
                      <span className="ml-2 text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full hidden lg:inline">
                        Δ {formatCurrency(invoice.discrepancyAmount)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
