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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/StatusBadge";
import { formatCurrency, formatDate, formatRelativeTime, parseContainerNumbers } from "@/lib/invoiceUtils";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  ArrowLeft, FileText, RefreshCw, Send, CheckCircle2,
  MessageSquare, Mail, AlertTriangle, ExternalLink,
  Building2, Calendar, Hash, Container, DollarSign,
  Loader2, Plus, Trash2, Phone, MapPin, User
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
  const deleteMutation = trpc.invoices.delete.useMutation();

  const [noteContent, setNoteContent] = useState("");
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");

  const invalidate = () => utils.invoices.get.invalidate({ id: invoiceId });
  const listUtils = trpc.useUtils();

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync({ id: invoiceId });
      await listUtils.invoices.list.invalidate();
      toast.success("Invoice deleted");
      setLocation("/invoices");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to delete invoice");
    }
  };

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
      <div className="max-w-7xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-[600px] w-full" />
          <Skeleton className="h-[600px] w-full" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-7xl mx-auto text-center py-20">
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
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2"
            onClick={() => setLocation("/invoices")}
          >
            <ArrowLeft className="h-4 w-4" />
            Invoices
          </Button>
          <span className="text-muted-foreground/40">/</span>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold text-foreground tracking-tight">
                {invoice.extractedInvoiceNumber ?? `Invoice #${invoice.id}`}
              </h1>
              <StatusBadge status={invoice.status} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {invoice.extractedSupplierName ?? "Unknown supplier"} · {invoice.originalFileName} · Uploaded {formatRelativeTime(invoice.createdAt)}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {["uploaded", "extracted"].includes(invoice.status) && (
            <Button variant="outline" size="sm" className="gap-2" onClick={handleExtract} disabled={extractMutation.isPending}>
              {extractMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Re-extract
            </Button>
          )}
          {canVerify && (
            <Button variant="outline" size="sm" className="gap-2" onClick={handleVerify} disabled={verifyMutation.isPending}>
              {verifyMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Verify with Xero
            </Button>
          )}
          {canQuery && (
            <Button variant="outline" size="sm" className="gap-2 border-purple-200 text-purple-700 hover:bg-purple-50" onClick={openEmailDialog}>
              <Send className="h-3.5 w-3.5" />
              Send Query
            </Button>
          )}
          {canResolve && (
            <Button size="sm" className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setShowResolveDialog(true)}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Resolve
            </Button>
          )}
          {user?.role === "admin" && (
            <Button variant="outline" size="sm" className="gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300" onClick={() => setShowDeleteDialog(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
      </div>

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

      {/* Xero resolved banner */}
      {invoice.xeroFinalBillId && (
        <Card className="border border-emerald-200 bg-emerald-50/50 shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-emerald-800">Draft Bill Created in Xero</p>
              <p className="text-xs text-emerald-700 mt-0.5">
                Bill number: {invoice.xeroFinalBillNumber} — awaiting payment approval in Xero
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main two-column layout: extracted data left, PDF preview right */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

        {/* ── LEFT: Extracted data + line items ── */}
        <div className="space-y-4">

          {/* Key fields */}
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
                <DataRow icon={Hash} label="PO Number" value={invoice.extractedPoNumber} highlight={!!invoice.extractedPoNumber} />
                <DataRow icon={Calendar} label="Invoice Date" value={formatDate(invoice.extractedInvoiceDate)} />
                <DataRow icon={Calendar} label="Due Date" value={formatDate(invoice.extractedDueDate)} />
                <DataRow icon={Building2} label="Supplier" value={invoice.extractedSupplierName} />
                <DataRow icon={Hash} label="ABN" value={invoice.extractedSupplierAbn} />
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
                        <Badge key={cn} variant="secondary" className="font-mono text-xs">{cn}</Badge>
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
                    <AmountRow label="Total" value={formatCurrency(invoice.extractedTotal)} highlight />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Xero{invoice.xeroVerifiedAt && (
                        <span className="text-muted-foreground/60"> · verified {formatRelativeTime(invoice.xeroVerifiedAt)}</span>
                      )}
                    </p>
                    {invoice.xeroTotal ? (
                      <>
                        <AmountRow label="Subtotal" value={formatCurrency(invoice.xeroSubtotal)} />
                        <AmountRow label="GST" value={formatCurrency(invoice.xeroTax)} />
                        <AmountRow label="Total" value={formatCurrency(invoice.xeroTotal)} highlight discrepancy={invoice.hasDiscrepancy ?? false} />
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">Not verified yet</p>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Line Items — always visible */}
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Invoice Lines
                {lineItems.length > 0 && (
                  <Badge variant="secondary" className="text-xs font-normal ml-auto">{lineItems.length} items</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {lineItems.length === 0 ? (
                <p className="text-xs text-muted-foreground italic text-center py-4">
                  No line items extracted. Re-extract to populate.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left pb-2.5 font-medium pr-3">Description</th>
                        <th className="text-right pb-2.5 font-medium w-12">Qty</th>
                        <th className="text-right pb-2.5 font-medium w-24">Unit Price</th>
                        <th className="text-right pb-2.5 font-medium w-24">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {lineItems.map((li) => (
                        <tr key={li.id} className="text-foreground hover:bg-muted/30 transition-colors">
                          <td className="py-2.5 pr-3 leading-relaxed">{li.description ?? "—"}</td>
                          <td className="py-2.5 text-right tabular-nums text-muted-foreground">{li.quantity ?? "—"}</td>
                          <td className="py-2.5 text-right tabular-nums text-muted-foreground">{formatCurrency(li.unitPrice)}</td>
                          <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(li.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {(invoice.extractedSubtotal || invoice.extractedTax || invoice.extractedTotal) && (
                      <tfoot>
                        <tr className="border-t border-border/60">
                          <td colSpan={3} className="pt-2.5 text-right text-xs text-muted-foreground font-medium pr-3">Subtotal</td>
                          <td className="pt-2.5 text-right tabular-nums text-xs">{formatCurrency(invoice.extractedSubtotal)}</td>
                        </tr>
                        {invoice.extractedTax && (
                          <tr>
                            <td colSpan={3} className="pt-1 text-right text-xs text-muted-foreground pr-3">GST</td>
                            <td className="pt-1 text-right tabular-nums text-xs">{formatCurrency(invoice.extractedTax)}</td>
                          </tr>
                        )}
                        <tr>
                          <td colSpan={3} className="pt-1.5 text-right text-xs font-semibold pr-3">Total</td>
                          <td className="pt-1.5 text-right tabular-nums text-xs font-semibold">{formatCurrency(invoice.extractedTotal)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Supplier card */}
          {supplier && (
            <Card className="border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  Supplier Profile
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-foreground">{supplier.name}</p>
                  {supplier.abn && <p className="text-xs text-muted-foreground">ABN: {supplier.abn}</p>}
                  <div className="grid grid-cols-1 gap-1.5 mt-2">
                    {supplier.contactName && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <User className="h-3 w-3 shrink-0" />
                        {supplier.contactName}
                      </div>
                    )}
                    {supplier.email && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Mail className="h-3 w-3 shrink-0" />
                        {supplier.email}
                      </div>
                    )}
                    {supplier.phone && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3 shrink-0" />
                        {supplier.phone}
                      </div>
                    )}
                    {supplier.address && (
                      <div className="flex items-start gap-2 text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3 shrink-0 mt-0.5" />
                        <span className="whitespace-pre-line">{supplier.address}</span>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── RIGHT: PDF Preview ── */}
        <div className="space-y-4">
          <Card className="border shadow-sm h-full" style={{ minHeight: "600px" }}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  Invoice PDF
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                  onClick={() => window.open(invoice.fileUrl, "_blank")}
                >
                  <ExternalLink className="h-3 w-3" />
                  Open
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{invoice.originalFileName}</p>
            </CardHeader>
            <CardContent className="p-0 pb-4 px-4">
              <div className="rounded-lg overflow-hidden border bg-muted/20" style={{ height: "560px" }}>
                <iframe
                  src={`${invoice.fileUrl}#toolbar=0&navpanes=0&scrollbar=1`}
                  className="w-full h-full"
                  title="Invoice PDF Preview"
                  style={{ border: "none" }}
                />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Activity & Notes — full width below */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-0">
          <Tabs defaultValue="activity">
            <div className="flex items-center justify-between">
              <TabsList className="h-8">
                <TabsTrigger value="activity" className="text-xs gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Activity & Notes
                  {notes.length > 0 && (
                    <Badge variant="secondary" className="text-xs font-normal h-4 px-1.5">{notes.length}</Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger value="emails" className="text-xs gap-1.5">
                  <Mail className="h-3.5 w-3.5" />
                  Email Log
                  {emails.length > 0 && (
                    <Badge variant="secondary" className="text-xs font-normal h-4 px-1.5">{emails.length}</Badge>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="activity" className="mt-4">
              <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                {notes.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">No activity yet</p>
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
                          <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap break-words">{note.content}</p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <Separator className="my-3" />
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
                  className="gap-2"
                  onClick={handleAddNote}
                  disabled={!noteContent.trim() || addNoteMutation.isPending}
                >
                  {addNoteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Add Note
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="emails" className="mt-4">
              {emails.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">No emails sent yet</p>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
                  {emails.map((email) => (
                    <div key={email.id} className="border rounded-lg p-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-xs font-medium text-foreground">{email.subject}</p>
                          <p className="text-xs text-muted-foreground">
                            To: {email.toAddress} · {formatRelativeTime(email.sentAt)}
                          </p>
                        </div>
                        <Badge variant={email.status === "sent" ? "default" : "destructive"} className="text-xs shrink-0">
                          {email.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap border-t pt-1.5 mt-1.5 leading-relaxed">
                        {email.body}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-0" />
      </Card>

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
                <Input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="supplier@example.com" className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">From</Label>
                <Input value="admin@containerzone.com.au" disabled className="h-9 text-sm bg-muted" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Subject</Label>
              <Input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} className="h-9 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Message</Label>
              <Textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} className="text-sm min-h-[200px] font-mono" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEmailDialog(false)}>Cancel</Button>
            <Button onClick={handleSendEmail} disabled={sendQueryMutation.isPending} className="gap-2">
              {sendQueryMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
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
            <Button variant="outline" onClick={() => setShowResolveDialog(false)}>Cancel</Button>
            <Button onClick={handleResolve} disabled={resolveMutation.isPending} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
              {resolveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Resolve & Push to Xero
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-red-500" />
              Delete Invoice
            </DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to permanently delete{" "}
              <strong className="text-foreground">
                {invoice.extractedInvoiceNumber ?? `Invoice #${invoiceId}`}
              </strong>?
              This will remove all associated notes, email logs, and line items and cannot be undone.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>Cancel</Button>
            <Button onClick={handleDelete} disabled={deleteMutation.isPending} className="gap-2 bg-red-600 hover:bg-red-700 text-white">
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete Invoice
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
  highlight,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value?: string | null;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground flex items-center gap-1 mb-0.5">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className={cn(
        "text-sm font-medium truncate",
        value ? (highlight ? "text-primary" : "text-foreground") : "text-muted-foreground/50 italic text-xs font-normal"
      )}>
        {value ?? "Not found"}
      </p>
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
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn(
        "text-xs tabular-nums",
        highlight ? "font-semibold text-foreground" : "text-muted-foreground",
        discrepancy && "text-red-600 font-semibold"
      )}>
        {value}
      </span>
    </div>
  );
}
