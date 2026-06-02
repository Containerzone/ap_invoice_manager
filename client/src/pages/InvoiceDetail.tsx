import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useLocation, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/StatusBadge";
import { formatCurrency, formatDate, formatRelativeTime, parseContainerNumbers } from "@/lib/invoiceUtils";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  ArrowLeft, FileText, RefreshCw, Send, CheckCircle2,
  MessageSquare, Mail, AlertTriangle, ExternalLink,
  Building2, Calendar, Hash, Container, DollarSign,
  Loader2, Plus, ChevronDown, ChevronUp
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const invoiceId = parseInt(id ?? "0");

  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.invoices.get.useQuery({ id: invoiceId });
  const { data: emailTemplate } = trpc.invoices.generateEmailTemplate.useQuery(
    { invoiceId },
    { enabled: !!data?.invoice }
  );

  const extractMutation = trpc.invoices.extract.useMutation();
  const verifyMutation = trpc.invoices.verifyWithXero.useMutation();
  const sendQueryMutation = trpc.invoices.sendQuery.useMutation();
  const addNoteMutation = trpc.invoices.addNote.useMutation();
  const resolveMutation = trpc.invoices.resolve.useMutation();

  const [noteContent, setNoteContent] = useState("");
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [showLineItems, setShowLineItems] = useState(false);

  const invalidate = () => utils.invoices.get.invalidate({ id: invoiceId });

  const handleExtract = async () => {
    try {
      await extractMutation.mutateAsync({ invoiceId });
      await invalidate();
      toast.success("Data re-extracted successfully");
    } catch (e: any) {
      toast.error(e?.message ?? "Extraction failed");
    }
  };

  const handleVerify = async () => {
    try {
      const result = await verifyMutation.mutateAsync({ invoiceId });
      await invalidate();
      if (result.discrepancy) {
        toast.warning("Discrepancy detected — invoice flagged");
      } else {
        toast.success(result.matched ? "Verified — amounts match" : "No Xero bill found — marked verified");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Verification failed");
    }
  };

  const openEmailDialog = () => {
    const supplier = data?.supplier;
    setEmailTo(supplier?.email ?? data?.invoice.extractedSupplierEmail ?? "");
    setEmailSubject(emailTemplate?.subject ?? "");
    setEmailBody(emailTemplate?.body ?? "");
    setShowEmailDialog(true);
  };

  const handleSendEmail = async () => {
    if (!emailTo || !emailSubject || !emailBody) {
      toast.error("Please fill in all email fields");
      return;
    }
    try {
      const result = await sendQueryMutation.mutateAsync({
        invoiceId,
        to: emailTo,
        subject: emailSubject,
        body: emailBody,
      });
      await invalidate();
      setShowEmailDialog(false);
      toast.success((result as any).demo ? "Email logged (demo mode — SMTP not configured)" : "Email sent successfully");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to send email");
    }
  };

  const handleAddNote = async () => {
    if (!noteContent.trim()) return;
    try {
      await addNoteMutation.mutateAsync({ invoiceId, content: noteContent });
      await invalidate();
      setNoteContent("");
      toast.success("Note added");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to add note");
    }
  };

  const handleResolve = async () => {
    try {
      const result = await resolveMutation.mutateAsync({
        invoiceId,
        resolutionNotes,
        pushToXero: true,
      });
      await invalidate();
      setShowResolveDialog(false);
      if (result.xeroResult) {
        toast.success(`Resolved — Draft bill ${result.xeroResult.invoiceNumber} created in Xero`);
      } else {
        toast.success("Invoice marked as resolved");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to resolve invoice");
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-6xl mx-auto text-center py-20">
        <p className="text-muted-foreground">Invoice not found</p>
        <Button variant="outline" className="mt-4" onClick={() => setLocation("/invoices")}>
          Back to Invoices
        </Button>
      </div>
    );
  }

  const { invoice, lineItems, notes, emails, supplier } = data;
  const containers = parseContainerNumbers(invoice.extractedContainerNumbers);
  const canVerify = ["extracted", "verified", "flagged"].includes(invoice.status);
  const canQuery = ["flagged", "verified", "extracted"].includes(invoice.status);
  const canResolve = ["flagged", "queried", "verified"].includes(invoice.status);

  const noteTypeConfig: Record<string, { icon: React.ComponentType<any>; color: string; label: string }> = {
    note:           { icon: MessageSquare, color: "text-blue-500",   label: "Note" },
    email_sent:     { icon: Mail,          color: "text-purple-500", label: "Email Sent" },
    email_received: { icon: Mail,          color: "text-green-500",  label: "Email Received" },
    status_change:  { icon: RefreshCw,     color: "text-amber-500",  label: "Status Change" },
    system:         { icon: FileText,      color: "text-gray-400",   label: "System" },
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-muted-foreground"
          onClick={() => setLocation("/invoices")}
        >
          <ArrowLeft className="h-4 w-4" />
          Invoices
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium text-foreground">
          {invoice.extractedInvoiceNumber ?? `Invoice #${invoice.id}`}
        </span>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">
              {invoice.extractedInvoiceNumber ?? `Invoice #${invoice.id}`}
            </h1>
            <StatusBadge status={invoice.status} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {invoice.extractedSupplierName ?? "Unknown supplier"} ·{" "}
            {invoice.originalFileName} · Uploaded {formatRelativeTime(invoice.createdAt)}
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {["uploaded", "extracted"].includes(invoice.status) && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleExtract}
              disabled={extractMutation.isPending}
            >
              {extractMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Re-extract
            </Button>
          )}
          {canVerify && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleVerify}
              disabled={verifyMutation.isPending}
            >
              {verifyMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Verify with Xero
            </Button>
          )}
          {canQuery && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 border-purple-200 text-purple-700 hover:bg-purple-50"
              onClick={openEmailDialog}
            >
              <Send className="h-3.5 w-3.5" />
              Send Query
            </Button>
          )}
          {canResolve && (
            <Button
              size="sm"
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => setShowResolveDialog(true)}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Resolve
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column — invoice data */}
        <div className="lg:col-span-2 space-y-5">

          {/* Discrepancy Alert */}
          {invoice.hasDiscrepancy && (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-800">Amount Discrepancy Detected</p>
                <p className="text-sm text-amber-700 mt-0.5">
                  Extracted total {formatCurrency(invoice.extractedTotal)} differs from Xero total{" "}
                  {formatCurrency(invoice.xeroTotal)} by{" "}
                  <strong>{formatCurrency(invoice.discrepancyAmount)}</strong>
                </p>
              </div>
            </div>
          )}

          {/* Extracted Data */}
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Extracted Invoice Data
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <DataRow icon={Hash} label="Invoice Number" value={invoice.extractedInvoiceNumber} />
                <DataRow icon={Hash} label="PO Number" value={invoice.extractedPoNumber} />
                <DataRow icon={Calendar} label="Invoice Date" value={formatDate(invoice.extractedInvoiceDate)} />
                <DataRow icon={Calendar} label="Due Date" value={formatDate(invoice.extractedDueDate)} />
                <DataRow icon={Building2} label="Supplier" value={invoice.extractedSupplierName} />
                <DataRow icon={Building2} label="ABN" value={invoice.extractedSupplierAbn} />
              </div>

              {containers.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Container className="h-3.5 w-3.5" />
                      Container Numbers
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {containers.map((cn) => (
                        <Badge key={cn} variant="secondary" className="font-mono text-xs">
                          {cn}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <Separator />

              {/* Amounts comparison */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <DollarSign className="h-3.5 w-3.5" />
                  Amount Comparison
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Extracted (Invoice)</p>
                    <AmountRow label="Subtotal" value={formatCurrency(invoice.extractedSubtotal)} />
                    <AmountRow label="GST" value={formatCurrency(invoice.extractedTax)} />
                    <AmountRow
                      label="Total"
                      value={formatCurrency(invoice.extractedTotal)}
                      highlight
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Xero{" "}
                      {invoice.xeroVerifiedAt && (
                        <span className="text-muted-foreground/60">
                          · verified {formatRelativeTime(invoice.xeroVerifiedAt)}
                        </span>
                      )}
                    </p>
                    {invoice.xeroTotal ? (
                      <>
                        <AmountRow label="Subtotal" value={formatCurrency(invoice.xeroSubtotal)} />
                        <AmountRow label="GST" value={formatCurrency(invoice.xeroTax)} />
                        <AmountRow
                          label="Total"
                          value={formatCurrency(invoice.xeroTotal)}
                          highlight
                          discrepancy={invoice.hasDiscrepancy ?? false}
                        />
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">Not verified yet</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Line Items */}
              {lineItems.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <button
                      className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
                      onClick={() => setShowLineItems(!showLineItems)}
                    >
                      {showLineItems ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      Line Items ({lineItems.length})
                    </button>
                    {showLineItems && (
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="text-left pb-2 font-medium">Description</th>
                              <th className="text-right pb-2 font-medium">Qty</th>
                              <th className="text-right pb-2 font-medium">Unit Price</th>
                              <th className="text-right pb-2 font-medium">Amount</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {lineItems.map((li) => (
                              <tr key={li.id} className="text-foreground">
                                <td className="py-2 pr-4">{li.description ?? "—"}</td>
                                <td className="py-2 text-right tabular-nums">{li.quantity ?? "—"}</td>
                                <td className="py-2 text-right tabular-nums">{formatCurrency(li.unitPrice)}</td>
                                <td className="py-2 text-right tabular-nums font-medium">{formatCurrency(li.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Xero Result */}
          {invoice.xeroFinalBillId && (
            <Card className="border border-emerald-200 bg-emerald-50/50 shadow-sm">
              <CardContent className="p-4 flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-emerald-800">
                    Draft Bill Created in Xero
                  </p>
                  <p className="text-xs text-emerald-700 mt-0.5">
                    Bill number: {invoice.xeroFinalBillNumber} — awaiting payment approval in Xero
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* PDF Viewer link */}
          <Card className="border shadow-sm">
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{invoice.originalFileName}</p>
                  <p className="text-xs text-muted-foreground">Original PDF</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => window.open(invoice.fileUrl, "_blank")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View PDF
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Right column — conversation */}
        <div className="space-y-5">
          {/* Supplier card */}
          {supplier && (
            <Card className="border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  Supplier
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm font-medium text-foreground">{supplier.name}</p>
                {supplier.email && (
                  <p className="text-xs text-muted-foreground">{supplier.email}</p>
                )}
                {supplier.abn && (
                  <p className="text-xs text-muted-foreground">ABN: {supplier.abn}</p>
                )}
                {supplier.phone && (
                  <p className="text-xs text-muted-foreground">{supplier.phone}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Conversation thread */}
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                Activity & Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Notes list */}
              <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                {notes.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No activity yet</p>
                ) : (
                  notes.map((note) => {
                    const config = noteTypeConfig[note.type] ?? noteTypeConfig.note;
                    const Icon = config.icon;
                    return (
                      <div key={note.id} className="flex gap-2.5">
                        <div className={cn("h-6 w-6 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5", config.color)}>
                          <Icon className="h-3 w-3" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">{config.label}</span>
                            <span className="text-xs text-muted-foreground">{formatRelativeTime(note.createdAt)}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap break-words">
                            {note.content}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <Separator />

              {/* Add note */}
              <div className="space-y-2">
                <Textarea
                  placeholder="Add a note..."
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  className="text-sm resize-none min-h-[72px]"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-2"
                  onClick={handleAddNote}
                  disabled={!noteContent.trim() || addNoteMutation.isPending}
                >
                  {addNoteMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  Add Note
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Email Dialog */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Send Supplier Query
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">To</Label>
                <Input
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder="supplier@example.com"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">From</Label>
                <Input
                  value="admin@containerzone.com.au"
                  disabled
                  className="h-9 text-sm bg-muted"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Subject</Label>
              <Input
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Message</Label>
              <Textarea
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                className="text-sm min-h-[200px] font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEmailDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSendEmail}
              disabled={sendQueryMutation.isPending}
              className="gap-2"
            >
              {sendQueryMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send Email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resolve Dialog */}
      <Dialog open={showResolveDialog} onOpenChange={setShowResolveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Resolve Invoice
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Marking this invoice as resolved will create a draft bill in Xero ready for payment approval.
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Resolution Notes (optional)</Label>
              <Textarea
                placeholder="Describe how the dispute was resolved..."
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                className="text-sm min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResolveDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleResolve}
              disabled={resolveMutation.isPending}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {resolveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              Resolve & Push to Xero
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DataRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground flex items-center gap-1 mb-0.5">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className="text-sm font-medium text-foreground">{value ?? "—"}</p>
    </div>
  );
}

function AmountRow({
  label,
  value,
  highlight,
  discrepancy,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  discrepancy?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between", highlight && "font-semibold")}>
      <span className={cn("text-xs", highlight ? "text-foreground" : "text-muted-foreground")}>
        {label}
      </span>
      <span
        className={cn(
          "text-sm tabular-nums",
          highlight ? "text-foreground" : "text-muted-foreground",
          discrepancy && "text-amber-600"
        )}
      >
        {value}
      </span>
    </div>
  );
}
