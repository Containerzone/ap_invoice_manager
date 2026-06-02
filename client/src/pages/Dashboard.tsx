import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { formatCurrency, formatRelativeTime } from "@/lib/invoiceUtils";
import {
  FileText, AlertTriangle, MessageSquare, CheckCircle2,
  Upload, TrendingUp, ArrowRight, RefreshCw
} from "lucide-react";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { data: metrics, isLoading: metricsLoading } = trpc.invoices.metrics.useQuery();
  const { data: recentInvoices, isLoading: invoicesLoading } = trpc.invoices.list.useQuery({});
  const { data: flaggedInvoices } = trpc.invoices.list.useQuery({ status: "flagged" });

  const recent = recentInvoices?.slice(0, 5) ?? [];
  const flagged = flaggedInvoices?.slice(0, 4) ?? [];

  const metricCards = [
    {
      title: "Total Invoices",
      value: metrics?.total ?? 0,
      icon: FileText,
      color: "text-blue-600",
      bg: "bg-blue-50",
      border: "border-blue-100",
    },
    {
      title: "Flagged",
      value: metrics?.flagged ?? 0,
      icon: AlertTriangle,
      color: "text-amber-600",
      bg: "bg-amber-50",
      border: "border-amber-100",
      alert: (metrics?.flagged ?? 0) > 0,
    },
    {
      title: "Open Queries",
      value: metrics?.openQueries ?? 0,
      icon: MessageSquare,
      color: "text-purple-600",
      bg: "bg-purple-50",
      border: "border-purple-100",
    },
    {
      title: "Resolved This Month",
      value: metrics?.resolvedThisMonth ?? 0,
      icon: CheckCircle2,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
      border: "border-emerald-100",
    },
  ];

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Overview of your accounts payable activity
          </p>
        </div>
        <Button
          onClick={() => setLocation("/invoices/upload")}
          className="gap-2 shadow-sm"
        >
          <Upload className="h-4 w-4" />
          Upload Invoice
        </Button>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {metricCards.map((card) => (
          <Card
            key={card.title}
            className={`border shadow-sm hover:shadow-md transition-shadow cursor-pointer ${card.alert ? "ring-1 ring-amber-300" : ""}`}
            onClick={() => setLocation("/invoices")}
          >
            <CardContent className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {card.title}
                  </p>
                  {metricsLoading ? (
                    <Skeleton className="h-8 w-16 mt-2" />
                  ) : (
                    <p className="text-3xl font-bold text-foreground mt-1.5 tabular-nums">
                      {card.value}
                    </p>
                  )}
                </div>
                <div className={`h-10 w-10 rounded-xl ${card.bg} ${card.border} border flex items-center justify-center`}>
                  <card.icon className={`h-5 w-5 ${card.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Invoices */}
        <div className="lg:col-span-2">
          <Card className="border shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold text-foreground">Recent Invoices</CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground gap-1 h-7"
                onClick={() => setLocation("/invoices")}
              >
                View all <ArrowRight className="h-3 w-3" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {invoicesLoading ? (
                <div className="space-y-3 p-4">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : recent.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FileText className="h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">No invoices yet</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 gap-2"
                    onClick={() => setLocation("/invoices/upload")}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Upload your first invoice
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {recent.map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex items-center justify-between px-5 py-3.5 hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => setLocation(`/invoices/${invoice.id}`)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {invoice.extractedInvoiceNumber ?? invoice.originalFileName ?? `Invoice #${invoice.id}`}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {invoice.extractedSupplierName ?? "Unknown supplier"} · {formatRelativeTime(invoice.createdAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-3">
                        <span className="text-sm font-medium text-foreground tabular-nums">
                          {formatCurrency(invoice.extractedTotal)}
                        </span>
                        <StatusBadge status={invoice.status} size="sm" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Flagged Invoices */}
        <div>
          <Card className="border shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Flagged Discrepancies
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground gap-1 h-7"
                onClick={() => setLocation("/invoices?status=flagged")}
              >
                View all <ArrowRight className="h-3 w-3" />
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {flagged.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center px-4">
                  <CheckCircle2 className="h-8 w-8 text-emerald-400 mb-2" />
                  <p className="text-sm font-medium text-foreground">All clear</p>
                  <p className="text-xs text-muted-foreground mt-1">No flagged discrepancies</p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {flagged.map((invoice) => (
                    <div
                      key={invoice.id}
                      className="px-4 py-3 hover:bg-amber-50/50 cursor-pointer transition-colors"
                      onClick={() => setLocation(`/invoices/${invoice.id}`)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {invoice.extractedInvoiceNumber ?? `#${invoice.id}`}
                          </p>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {invoice.extractedSupplierName ?? "Unknown"}
                          </p>
                        </div>
                        {invoice.discrepancyAmount && (
                          <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full shrink-0">
                            Δ {formatCurrency(invoice.discrepancyAmount)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="border shadow-sm mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold text-foreground">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              <Button
                variant="outline"
                className="w-full justify-start gap-2 h-9 text-sm"
                onClick={() => setLocation("/invoices/upload")}
              >
                <Upload className="h-4 w-4 text-primary" />
                Upload Invoice
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2 h-9 text-sm"
                onClick={() => setLocation("/invoices?status=flagged")}
              >
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Review Flagged
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-2 h-9 text-sm"
                onClick={() => setLocation("/invoices?status=queried")}
              >
                <MessageSquare className="h-4 w-4 text-purple-500" />
                Open Queries
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
