import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "@/components/StatusBadge";
import { formatCurrency } from "@/lib/invoiceUtils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Send, Loader2, ArrowLeft, Building2, FileText, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function BulkQuery() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const { data: invoices, isLoading } = trpc.invoices.list.useQuery(undefined);
  const { data: suppliers } = trpc.suppliers.list.useQuery();
  const sendBulkMutation = trpc.invoices.sendBulkQuery.useMutation();

  const [selectedSupplierId, setSelectedSupplierId] = useState<string>("");
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<number>>(new Set());
  const [emailTo, setEmailTo] = useState("");
  const [emailCc, setEmailCc] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [step, setStep] = useState<"select" | "compose">("select");

  // Filter invoices by selected supplier
  const supplierInvoices = useMemo(() => {
    if (!invoices || !selectedSupplierId) return [];
    return invoices.filter(
      (inv) =>
        inv.supplierId === parseInt(selectedSupplierId) &&
        inv.status !== "resolved"
    );
  }, [invoices, selectedSupplierId]);

  // Selected supplier details
  const selectedSupplier = useMemo(() => {
    if (!suppliers || !selectedSupplierId) return null;
    return suppliers.find((s) => s.id === parseInt(selectedSupplierId)) ?? null;
  }, [suppliers, selectedSupplierId]);

  const handleSupplierChange = (supplierId: string) => {
    setSelectedSupplierId(supplierId);
    setSelectedInvoiceIds(new Set());
    setEmailTo("");
    setEmailSubject("");
    setEmailBody("");
    // Pre-fill email from supplier profile
    const supplier = suppliers?.find((s) => s.id === parseInt(supplierId));
    if (supplier?.email) setEmailTo(supplier.email);
  };

  const toggleInvoice = (id: number) => {
    setSelectedInvoiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedInvoiceIds.size === supplierInvoices.length) {
      setSelectedInvoiceIds(new Set());
    } else {
      setSelectedInvoiceIds(new Set(supplierInvoices.map((i) => i.id)));
    }
  };

  const handleProceedToCompose = () => {
    if (selectedInvoiceIds.size === 0) {
      toast.error("Please select at least one invoice");
      return;
    }
    // Auto-generate subject and body
    const selectedInvoices = supplierInvoices.filter((i) => selectedInvoiceIds.has(i.id));
    const invoiceNumbers = selectedInvoices
      .map((i) => i.extractedInvoiceNumber ?? `#${i.id}`)
      .join(", ");
    const totalAmount = selectedInvoices.reduce(
      (sum, i) => sum + parseFloat(i.extractedTotal ?? "0"),
      0
    );

    setEmailSubject(
      `Invoice Query — ${selectedSupplier?.name ?? "Supplier"} — ${selectedInvoices.length} Invoice${selectedInvoices.length > 1 ? "s" : ""}`
    );

    const invoiceList = selectedInvoices
      .map((inv, idx) => {
        const lines = [
          `  ${idx + 1}. Invoice ${inv.extractedInvoiceNumber ?? `#${inv.id}`}`,
        ];
        if (inv.extractedPoNumber) lines.push(`     PO: ${inv.extractedPoNumber}`);
        if (inv.extractedTotal) lines.push(`     Amount: ${formatCurrency(inv.extractedTotal, inv.extractedCurrency ?? "AUD")}`);
        if (inv.hasDiscrepancy) lines.push(`     ⚠ Discrepancy: ${formatCurrency(inv.discrepancyAmount)}`);
        // Include query points for this invoice if present
        const rawQueryPoints = (inv as any).queryPoints;
        const qPoints: string[] = Array.isArray(rawQueryPoints)
          ? rawQueryPoints
          : typeof rawQueryPoints === "string" && rawQueryPoints
          ? (() => { try { return JSON.parse(rawQueryPoints); } catch { return []; } })()
          : [];
        if (qPoints.length > 0) {
          lines.push(`     Queries:`);
          qPoints.forEach((pt, qIdx) => lines.push(`       ${qIdx + 1}. ${pt}`));
        }
        return lines.join("\n");
      })
      .join("\n\n");

    // Collect all query points across all selected invoices for a consolidated section
    const allQueryPoints: string[] = [];
    selectedInvoices.forEach((inv) => {
      const rawQP = (inv as any).queryPoints;
      const pts: string[] = Array.isArray(rawQP)
        ? rawQP
        : typeof rawQP === "string" && rawQP
        ? (() => { try { return JSON.parse(rawQP); } catch { return []; } })()
        : [];
      pts.forEach((pt) => {
        if (!allQueryPoints.includes(pt)) allQueryPoints.push(pt);
      });
    });

    const querySection = allQueryPoints.length > 0
      ? `We have the following specific queries:\n${allQueryPoints.map((pt, i) => `  ${i + 1}. ${pt}`).join("\n")}\n\n`
      : "";

    setEmailBody(
      `Dear ${selectedSupplier?.contactName ?? selectedSupplier?.name ?? "Sir/Madam"},\n\n` +
      `We are writing to raise queries regarding the following invoice${selectedInvoices.length > 1 ? "s" : ""} ` +
      `totalling ${formatCurrency(totalAmount, selectedInvoices[0]?.extractedCurrency ?? "AUD")}:\n\n` +
      `${invoiceList}\n\n` +
      `${querySection}` +
      `We would appreciate your prompt response to resolve these matters.\n\n` +
      `Please do not hesitate to contact us if you require any further information.\n\n` +
      `Kind regards,\n` +
      `Container Zone Accounts Payable\n` +
      `admin@containerzone.com.au`
    );

    setStep("compose");
  };

  const handleSend = async () => {
    if (!emailTo || !emailSubject || !emailBody) {
      toast.error("Please fill in all required fields");
      return;
    }
    try {
      const result = await sendBulkMutation.mutateAsync({
        invoiceIds: Array.from(selectedInvoiceIds),
        to: emailTo,
        cc: emailCc || undefined,
        subject: emailSubject,
        body: emailBody,
      });
      await utils.invoices.list.invalidate();
      toast.success(
        `Query sent — ${result.invoiceCount} invoice${result.invoiceCount > 1 ? "s" : ""} updated`
      );
      setLocation("/invoices");
    } catch (err: any) {
      toast.error(err.message ?? "Failed to send email");
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={() => setLocation("/invoices")}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Invoices
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold text-foreground tracking-tight">Bulk Supplier Query</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Send one consolidated dispute email covering multiple invoices from the same supplier.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-3">
        <div className={cn(
          "flex items-center gap-2 text-sm font-medium",
          step === "select" ? "text-foreground" : "text-muted-foreground"
        )}>
          <span className={cn(
            "h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold",
            step === "select" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          )}>1</span>
          Select Invoices
        </div>
        <div className="h-px flex-1 bg-border" />
        <div className={cn(
          "flex items-center gap-2 text-sm font-medium",
          step === "compose" ? "text-foreground" : "text-muted-foreground"
        )}>
          <span className={cn(
            "h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold",
            step === "compose" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          )}>2</span>
          Compose & Send
        </div>
      </div>

      {step === "select" ? (
        <div className="space-y-4">
          {/* Supplier selector */}
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                Select Supplier
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={selectedSupplierId} onValueChange={handleSupplierChange}>
                <SelectTrigger className="w-full max-w-sm">
                  <SelectValue placeholder="Choose a supplier..." />
                </SelectTrigger>
                <SelectContent>
                  {suppliers?.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Invoice list for selected supplier */}
          {selectedSupplierId && (
            <Card className="border shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    Invoices from {selectedSupplier?.name}
                    {supplierInvoices.length > 0 && (
                      <Badge variant="secondary" className="text-xs">{supplierInvoices.length}</Badge>
                    )}
                  </CardTitle>
                  {supplierInvoices.length > 0 && (
                    <Button variant="ghost" size="sm" className="text-xs h-7" onClick={toggleAll}>
                      {selectedInvoiceIds.size === supplierInvoices.length ? "Deselect All" : "Select All"}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {isLoading ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                  </div>
                ) : supplierInvoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    No open invoices found for this supplier
                  </p>
                ) : (
                  <div className="divide-y divide-border -mx-6">
                    {supplierInvoices.map((inv) => (
                      <div
                        key={inv.id}
                        className={cn(
                          "flex items-center gap-3 px-6 py-3 cursor-pointer hover:bg-muted/30 transition-colors",
                          selectedInvoiceIds.has(inv.id) && "bg-primary/5"
                        )}
                        onClick={() => toggleInvoice(inv.id)}
                      >
                        <Checkbox
                          checked={selectedInvoiceIds.has(inv.id)}
                          onCheckedChange={() => toggleInvoice(inv.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {inv.extractedInvoiceNumber ?? `Invoice #${inv.id}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {inv.extractedPoNumber && `PO: ${inv.extractedPoNumber} · `}
                            {formatCurrency(inv.extractedTotal, inv.extractedCurrency ?? "AUD")}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {inv.hasDiscrepancy && (
                            <span className="text-xs text-amber-600 flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Δ {formatCurrency(inv.discrepancyAmount)}
                            </span>
                          )}
                          <StatusBadge status={inv.status} size="sm" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {selectedInvoiceIds.size > 0 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{selectedInvoiceIds.size}</span> invoice{selectedInvoiceIds.size > 1 ? "s" : ""} selected
              </p>
              <Button onClick={handleProceedToCompose} className="gap-2">
                Compose Email
                <ArrowLeft className="h-4 w-4 rotate-180" />
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary of selected invoices */}
          <Card className="border shadow-sm bg-muted/30">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Querying:</span>
                {supplierInvoices
                  .filter((i) => selectedInvoiceIds.has(i.id))
                  .map((inv) => (
                    <Badge key={inv.id} variant="outline" className="text-xs">
                      {inv.extractedInvoiceNumber ?? `#${inv.id}`}
                    </Badge>
                  ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 ml-auto text-muted-foreground"
                  onClick={() => setStep("select")}
                >
                  Change selection
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Email composer */}
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Send className="h-4 w-4 text-muted-foreground" />
                Compose Email
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">To *</Label>
                  <Input
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="supplier@example.com"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">From</Label>
                  <Input value="admin@containerzone.com.au" disabled className="h-9 text-sm bg-muted" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">CC (optional)</Label>
                <Input
                  value={emailCc}
                  onChange={(e) => setEmailCc(e.target.value)}
                  placeholder="cc@example.com"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Subject *</Label>
                <Input
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Message *</Label>
                <Textarea
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  className="text-sm min-h-[280px] font-mono"
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" onClick={() => setStep("select")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </Button>
            <Button
              onClick={handleSend}
              disabled={sendBulkMutation.isPending || !emailTo || !emailSubject || !emailBody}
              className="gap-2"
            >
              {sendBulkMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send to {selectedInvoiceIds.size} Invoice{selectedInvoiceIds.size > 1 ? "s" : ""}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
