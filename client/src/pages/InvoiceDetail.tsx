import React, { useState, useEffect, useCallback } from "react";
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
import { SupplierCombobox } from "@/components/SupplierCombobox";
import { formatCurrency, formatRelativeTime, parseContainerNumbers } from "@/lib/invoiceUtils";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  ArrowLeft, FileText, RefreshCw, Send, CheckCircle2,
  MessageSquare, Mail, AlertTriangle, ExternalLink,
  Building2, Calendar, Hash, DollarSign, Container,
  Loader2, Plus, Trash2, Phone, MapPin, User,
  ChevronLeft, ChevronRight, List, Pencil, X, Save,
  ShieldAlert, ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format, addDays, endOfMonth, parse, isValid } from "date-fns";

// ── Date helpers ──────────────────────────────────────────────────────────────
// Display format: DD-MM-YY  (e.g. 04-06-25)
// Storage format: YYYY-MM-DD (ISO, what the DB stores)

function toDisplayDate(isoOrRaw: string | null | undefined): string {
  if (!isoOrRaw) return "";
  // Already in DD-MM-YY
  if (/^\d{2}-\d{2}-\d{2}$/.test(isoOrRaw)) return isoOrRaw;
  // YYYY-MM-DD → DD-MM-YY
  const d = new Date(isoOrRaw);
  if (!isNaN(d.getTime())) {
    return format(d, "dd-MM-yy");
  }
  return isoOrRaw;
}

function toIsoDate(ddMMyy: string): string {
  if (!ddMMyy) return "";
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(ddMMyy)) return ddMMyy;
  // DD-MM-YY → YYYY-MM-DD
  const parsed = parse(ddMMyy, "dd-MM-yy", new Date());
  if (isValid(parsed)) return format(parsed, "yyyy-MM-dd");
  // DD-MM-YYYY
  const parsed2 = parse(ddMMyy, "dd-MM-yyyy", new Date());
  if (isValid(parsed2)) return format(parsed2, "yyyy-MM-dd");
  return ddMMyy;
}

function parseDateForCalendar(isoOrRaw: string | null | undefined): Date | undefined {
  if (!isoOrRaw) return undefined;
  const iso = toIsoDate(isoOrRaw);
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
}

// ── Xero PO types ─────────────────────────────────────────────────────────────
interface XeroPOLineItem {
  lineItemId: string;
  description: string;
  quantity: number;
  unitAmount: number;
  lineAmount: number;
  taxAmount: number;
  accountCode: string;
  itemCode: string;
}

interface XeroPoResult {
  poNumber: string;
  found: boolean;
  status: string;
  poTotal: number;
  poSubtotal: number;
  poTax: number;
  invoiceLineItemTotal?: number; // grouped invoice line-item total for this PO (multi-PO invoices)
  discrepancy: boolean;
  overBilled?: boolean;
  underBilled?: boolean;
  rawDiff?: number;
  diff: number;
  lineItems: XeroPOLineItem[];
  contact?: { contactId: string; name: string };
  currencyCode?: string;
  alreadyBilled?: boolean;
  isPaid?: boolean;
  paidAmount?: number;
  paidDate?: string;
}

const XERO_PO_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  DRAFT:       { label: "Draft",      className: "bg-gray-100 text-gray-700 border-gray-200" },
  AUTHORISED:  { label: "Authorised", className: "bg-blue-100 text-blue-700 border-blue-200" },
  BILLED:      { label: "Billed",     className: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  DELETED:     { label: "Deleted",    className: "bg-red-100 text-red-700 border-red-200" },
  NOT_FOUND:   { label: "Not Found",  className: "bg-red-100 text-red-700 border-red-200" },
};

function XeroPoStatusBadge({ status }: { status: string }) {
  const cfg = XERO_PO_STATUS_CONFIG[status] ?? { label: status, className: "bg-gray-100 text-gray-600 border-gray-200" };
  return (
    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border", cfg.className)}>
      {cfg.label}
    </span>
  );
}

const DISPUTE_TEMPLATES = [
  "Amount does not match the Purchase Order",
  "Invoice is a duplicate of a previously received invoice",
  "Container number on invoice does not match our records",
  "GST/Tax amount is incorrectly calculated",
  "Invoice date or due date is incorrect",
  "Description of services does not match the agreed scope",
  "Rate applied does not match the agreed contract rate",
  "Invoice references an incorrect PO number",
  "Charges have already been paid under a previous invoice",
  "Detention/demurrage charges exceed the agreed free days",
  "Port/terminal handling charges are not in the agreed schedule",
  "Fuel surcharge rate does not match the current schedule",
];

// ── DatePickerField ───────────────────────────────────────────────────────────
// Renders a button that opens a calendar popover. Stores/emits ISO dates.
// showQuickSelect: if true, shows quick-select buttons (for due date).
function DatePickerField({
  label,
  icon: Icon,
  value,
  onChange,
  issueDate,
  showQuickSelect = false,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string; // ISO or DD-MM-YY
  onChange: (iso: string) => void;
  issueDate?: string; // ISO or DD-MM-YY — used for quick-select offsets
  showQuickSelect?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedDate = parseDateForCalendar(value);
  const issueDateObj = parseDateForCalendar(issueDate);

  const handleSelect = (d: Date | undefined) => {
    if (d) {
      onChange(format(d, "yyyy-MM-dd"));
      setOpen(false);
    }
  };

  const handleQuick = (days: number | "eom") => {
    const base = issueDateObj ?? new Date();
    const target = days === "eom" ? endOfMonth(base) : addDays(base, days);
    onChange(format(target, "yyyy-MM-dd"));
    setOpen(false);
  };

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {label}
      </Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "h-8 w-full justify-start text-left text-sm font-normal",
              !value && "text-muted-foreground"
            )}
          >
            <Calendar className="mr-2 h-3.5 w-3.5 shrink-0" />
            {value ? toDisplayDate(value) : "Pick a date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          {showQuickSelect && (
            <div className="p-2 border-b flex flex-wrap gap-1">
              {[7, 14, 21, 30, 60].map((d) => (
                <Button
                  key={d}
                  variant="outline"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={() => handleQuick(d)}
                >
                  +{d}d
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => handleQuick("eom")}
              >
                EOM
              </Button>
            </div>
          )}
          <CalendarComponent
            mode="single"
            selected={selectedDate}
            onSelect={handleSelect}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const invoiceId = parseInt(id ?? "0");

  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.invoices.get.useQuery({ id: invoiceId });
  const { data: allInvoices } = trpc.invoices.list.useQuery(undefined);
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
  const updateExtractedMutation = trpc.invoices.updateExtracted.useMutation();
  const updateLineItemMutation = trpc.invoices.updateLineItem.useMutation();
  const addLineItemMutation = trpc.invoices.addLineItem.useMutation();
  const deleteLineItemMutation = trpc.invoices.deleteLineItem.useMutation();
  const saveQueryPointsMutation = trpc.invoices.saveQueryPoints.useMutation();
  const logReplyMutation = trpc.invoices.logReply.useMutation();
  const adminApproveMutation = trpc.invoices.adminApprove.useMutation();
  const staffApproveMutation = trpc.invoices.staffApprove.useMutation();

  // ── Reply state ───────────────────────────────────────────────────────────
  const [replyEmailLogId, setReplyEmailLogId] = useState<number | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [showReplyDialog, setShowReplyDialog] = useState(false);

  const handleOpenReplyDialog = (emailLogId: number) => {
    setReplyEmailLogId(emailLogId);
    setReplyBody("");
    setShowReplyDialog(true);
  };

  const handleLogReply = async () => {
    if (!replyEmailLogId || !replyBody.trim()) return;
    await logReplyMutation.mutateAsync({
      emailLogId: replyEmailLogId,
      invoiceId,
      replyBody: replyBody.trim(),
    });
    await utils.invoices.get.invalidate({ id: invoiceId });
    setShowReplyDialog(false);
    setReplyBody("");
    setReplyEmailLogId(null);
    toast.success("Supplier reply logged");
  };

  // ── Query points state ────────────────────────────────────────────────────
  const [queryPoints, setQueryPoints] = useState<string[]>([]);
  const [newQueryPoint, setNewQueryPoint] = useState("");
  const [queryPointsSaved, setQueryPointsSaved] = useState(false);
  const [queryPointsDirty, setQueryPointsDirty] = useState(false);

  useEffect(() => {
    if (data?.invoice) {
      const pts = Array.isArray((data.invoice as any).queryPoints)
        ? (data.invoice as any).queryPoints as string[]
        : [];
      setQueryPoints(pts);
    }
  }, [data?.invoice]);

  const handleAddQueryPoint = () => {
    const trimmed = newQueryPoint.trim();
    if (!trimmed) return;
    const updated = [...queryPoints, trimmed];
    setQueryPoints(updated);
    setNewQueryPoint("");
    setQueryPointsSaved(false);
    setQueryPointsDirty(true);
  };

  const handleRemoveQueryPoint = (idx: number) => {
    const updated = queryPoints.filter((_, i) => i !== idx);
    setQueryPoints(updated);
    setQueryPointsSaved(false);
    setQueryPointsDirty(true);
  };

  const handleUpdateQueryPoint = (idx: number, value: string) => {
    setQueryPoints(pts => pts.map((p, i) => i === idx ? value : p));
    setQueryPointsSaved(false);
    setQueryPointsDirty(true);
  };

  const handleSaveQueryPoints = async () => {
    await saveQueryPointsMutation.mutateAsync({ id: invoiceId, queryPoints });
    await utils.invoices.generateEmailTemplate.invalidate({ invoiceId });
    setQueryPointsSaved(true);
    setQueryPointsDirty(false);
    toast.success("Query points saved — email template updated");
  };

  const handleDeleteLineItem = async (lineItemId: number) => {
    await deleteLineItemMutation.mutateAsync({ id: lineItemId });
    await utils.invoices.get.invalidate({ id: invoiceId });
  };

  const handleAddLineItem = async () => {
    await addLineItemMutation.mutateAsync({
      invoiceId,
      description: "",
      quantity: "1",
      unitPrice: "0.00",
      amount: "0.00",
    });
    await utils.invoices.get.invalidate({ id: invoiceId });
  };

  // ── Dialog / panel state ──────────────────────────────────────────────────
  const [noteContent, setNoteContent] = useState("");
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showApproveDialog, setShowApproveDialog] = useState(false);
  const [showStaffApproveDialog, setShowStaffApproveDialog] = useState(false);
  const [approveNotes, setApproveNotes] = useState("");
  const [staffApproveNotes, setStaffApproveNotes] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ── Edit mode state ───────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [editSupplierId, setEditSupplierId] = useState<number | undefined>(undefined);
  const [editFields, setEditFields] = useState({
    extractedInvoiceNumber: "",
    extractedPoNumber: "",
    extractedSupplierName: "",
    extractedSupplierAbn: "",
    extractedSupplierEmail: "",
    extractedCurrency: "",
    extractedInvoiceDate: "",
    extractedDueDate: "",
    extractedSubtotal: "",
    extractedTax: "",
    extractedTotal: "",
    extractedContainerNumbers: "",
  });
  // Multi-PO numbers (up to 15) in edit mode
  const [editPoNumbers, setEditPoNumbers] = useState<string[]>([]);

  // Editable line items state
  const [editLineItems, setEditLineItems] = useState<Array<{
    id: number;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
  }>>([]);

  // Populate edit fields when data loads or edit mode is toggled on
  useEffect(() => {
    if (data?.invoice && editMode) {
      const inv = data.invoice;
      const containers = parseContainerNumbers(inv.extractedContainerNumbers);
      setEditSupplierId((inv as any).supplierId ?? undefined);
      setEditFields({
        extractedInvoiceNumber: inv.extractedInvoiceNumber ?? "",
        extractedPoNumber: inv.extractedPoNumber ?? "",
        extractedSupplierName: inv.extractedSupplierName ?? "",
        extractedSupplierAbn: inv.extractedSupplierAbn ?? "",
        extractedSupplierEmail: (inv as any).extractedSupplierEmail ?? "",
        extractedCurrency: inv.extractedCurrency ?? "AUD",
        extractedInvoiceDate: inv.extractedInvoiceDate ?? "",
        extractedDueDate: inv.extractedDueDate ?? "",
        extractedSubtotal: inv.extractedSubtotal ?? "",
        extractedTax: inv.extractedTax ?? "",
        extractedTotal: inv.extractedTotal ?? "",
        extractedContainerNumbers: containers.join(", "),
      });
      // Load multi-PO numbers
      const existingPoNums = Array.isArray((inv as any).extractedPoNumbers)
        ? (inv as any).extractedPoNumbers as string[]
        : inv.extractedPoNumber ? [inv.extractedPoNumber] : [];
      setEditPoNumbers(existingPoNums.length > 0 ? existingPoNums : [""]);
      setEditLineItems(
        (data.lineItems ?? []).map((li) => ({
          id: li.id,
          description: li.description ?? "",
          quantity: li.quantity ?? "",
          unitPrice: li.unitPrice ?? "",
          amount: li.amount ?? "",
          poNumber: (li as any).poNumber ?? "",
          custRef: (li as any).custRef ?? "",
        }))
      );
    }
  }, [editMode, data?.invoice, data?.lineItems]);

  const handleAddPoField = () => {
    if (editPoNumbers.length >= 15) return;
    setEditPoNumbers(prev => [...prev, ""]);
  };

  const handleRemovePoField = (idx: number) => {
    setEditPoNumbers(prev => prev.filter((_, i) => i !== idx));
  };

  const handleUpdatePoField = (idx: number, val: string) => {
    setEditPoNumbers(prev => prev.map((p, i) => i === idx ? val : p));
  };

  const handleSaveEdits = async () => {
    try {
      const containers = editFields.extractedContainerNumbers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // Clean PO numbers — remove empties, deduplicate
      const cleanPoNumbers = Array.from(new Set(editPoNumbers.map(p => p.trim()).filter(Boolean)));
      const primaryPo = cleanPoNumbers[0] ?? null;

      await updateExtractedMutation.mutateAsync({
        id: invoiceId,
        supplierId: editSupplierId ?? null,
        extractedInvoiceNumber: editFields.extractedInvoiceNumber || null,
        extractedPoNumber: primaryPo,
        extractedPoNumbers: cleanPoNumbers.length > 0 ? cleanPoNumbers : null,
        extractedSupplierName: editFields.extractedSupplierName || null,
        extractedSupplierAbn: editFields.extractedSupplierAbn || null,
        extractedSupplierEmail: editFields.extractedSupplierEmail || null,
        extractedCurrency: editFields.extractedCurrency || null,
        extractedInvoiceDate: editFields.extractedInvoiceDate || null,
        extractedDueDate: editFields.extractedDueDate || null,
        extractedSubtotal: editFields.extractedSubtotal || null,
        extractedTax: editFields.extractedTax || null,
        extractedTotal: editFields.extractedTotal || null,
        extractedContainerNumbers: containers,
      });
      await Promise.all(
        editLineItems.map((li) =>
          updateLineItemMutation.mutateAsync({
            id: li.id,
            description: li.description || null,
            quantity: li.quantity || null,
            unitPrice: li.unitPrice || null,
            amount: li.amount || null,
            poNumber: (li as any).poNumber || null,
            custRef: (li as any).custRef || null,
          })
        )
      );
      await utils.invoices.get.invalidate({ id: invoiceId });
      setEditMode(false);
      toast.success("Invoice data saved");
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to save changes");
    }
  };

  // ── Navigation helpers ────────────────────────────────────────────────────
  const sortedIds = (allInvoices ?? []).map((inv: any) => inv.id);
  const currentIndex = sortedIds.indexOf(invoiceId);
  const prevId = currentIndex > 0 ? sortedIds[currentIndex - 1] : null;
  const nextId = currentIndex < sortedIds.length - 1 ? sortedIds[currentIndex + 1] : null;

  const goTo = useCallback((targetId: number) => {
    setEditMode(false);
    setLocation(`/invoices/${targetId}`);
  }, [setLocation]);

  const invalidate = () => utils.invoices.get.invalidate({ id: invoiceId });

  // ── Action handlers ───────────────────────────────────────────────────────
  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync({ id: invoiceId });
      await utils.invoices.list.invalidate();
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
      const poCount = result.poResults?.length ?? 0;
      const missingCount = result.poResults?.filter((r: any) => !r.found).length ?? 0;
      const diffCount = result.poResults?.filter((r: any) => r.found && r.discrepancy).length ?? 0;
      if (result.discrepancy) {
        const parts: string[] = [];
        if (missingCount > 0) parts.push(`${missingCount} PO${missingCount > 1 ? "s" : ""} not found in Xero`);
        if (diffCount > 0) parts.push(`${diffCount} PO${diffCount > 1 ? "s" : ""} with amount mismatch`);
        toast.warning(`Discrepancy detected — ${parts.join(", ")}. Invoice flagged.`);
      } else {
        toast.success(`All ${poCount} PO${poCount !== 1 ? "s" : ""} verified — amounts match.`);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Verification failed");
    }
  };

  const handleAdminApprove = async () => {
    try {
      const result = await adminApproveMutation.mutateAsync({ invoiceId, notes: approveNotes || undefined });
      await utils.invoices.get.invalidate({ id: invoiceId });
      setShowApproveDialog(false);
      setApproveNotes("");
      const xeroResults = (result as any).xeroUpdateResults as Array<{ poNumber: string; status: string; error?: string }> | undefined;
      const xeroWarning = (result as any).xeroWarning as string | undefined;
      if (xeroWarning) {
        toast.warning(`Invoice approved — but Xero PO update failed: ${xeroWarning}`);
      } else if (xeroResults && xeroResults.length > 0) {
        const summary = xeroResults.map(r => `${r.poNumber} → ${r.status}`).join(", ");
        toast.success(`Invoice approved by admin. Xero POs updated: ${summary}`);
      } else {
        toast.success("Invoice approved by admin");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to approve invoice");
    }
  };

  const handleStaffApprove = async () => {
    try {
      const result = await staffApproveMutation.mutateAsync({ invoiceId, notes: staffApproveNotes || undefined });
      await utils.invoices.get.invalidate({ id: invoiceId });
      setShowStaffApproveDialog(false);
      setStaffApproveNotes("");
      if ((result as any).requiresAdminApproval) {
        toast.warning("Discrepancy exceeds staff threshold — admin approval required.");
      } else {
        const xeroResults = (result as any).xeroUpdateResults as Array<{ poNumber: string; status: string; error?: string }> | undefined;
        const xeroWarning = (result as any).xeroWarning as string | undefined;
        if (xeroWarning) {
          toast.warning(`Invoice approved — but Xero PO update failed: ${xeroWarning}`);
        } else if (xeroResults && xeroResults.length > 0) {
          const summary = xeroResults.map(r => `${r.poNumber} → ${r.status}`).join(", ");
          toast.success(`Invoice approved. Xero POs updated: ${summary}`);
        } else {
          toast.success("Invoice approved");
        }
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to approve invoice");
    }
  };

  const openEmailDialog = (prefillLastEmail = false) => {
    const supplier = data?.supplier;
    const emails = data?.emails ?? [];
    setEmailTo(supplier?.email ?? data?.invoice.extractedSupplierEmail ?? "");
    if (prefillLastEmail && emails.length > 0) {
      const last = emails[0];
      setEmailSubject(`Re: ${last.subject}`);
      setEmailBody(`\n\n--- Previous message ---\n${last.body}`);
    } else {
      setEmailSubject(emailTemplate?.subject ?? "");
      setEmailBody(emailTemplate?.body ?? "");
    }
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
        toast.success(`Resolved — Bill ${result.xeroResult.invoiceNumber} pushed to Xero`);
      } else {
        toast.success("Invoice marked as resolved");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to resolve invoice");
    }
  };

  // ── Loading / not found states ────────────────────────────────────────────
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
  const canVerify = ["extracted", "verified", "flagged", "under_budget", "approved"].includes(invoice.status);
  const canQuery = ["flagged", "verified", "extracted", "under_budget", "approved"].includes(invoice.status);
  const canResolve = ["flagged", "queried", "verified", "under_budget", "approved"].includes(invoice.status);
  const isQueried = invoice.status === "queried";
  const hasEmails = emails.length > 0;

  // Two-layer approval logic
  const requiresAdminApproval = !!(invoice as any).requiresAdminApproval;
  const invoiceTotal = parseFloat(invoice.extractedTotal?.toString() ?? "0");
  const discrepancyAmount = parseFloat(invoice.discrepancyAmount?.toString() ?? "0");
  // Staff can approve verified/under_budget/flagged invoices
  const canStaffApprove = ["verified", "under_budget", "flagged"].includes(invoice.status);
  // Admin can approve any non-resolved invoice
  const canAdminApprove = user?.role === "admin" && ["extracted", "flagged", "verified", "under_budget"].includes(invoice.status);

  // Staff threshold check (mirrors server logic)
  function isWithinStaffThreshold(total: number, diff: number): boolean {
    if (total <= 500) return diff <= 30;
    if (total <= 1000) return diff <= 50;
    if (total <= 2000) return diff <= 100;
    return false;
  }
  const staffCanApproveThisInvoice = isWithinStaffThreshold(invoiceTotal, discrepancyAmount);

  const poResults: XeroPoResult[] = Array.isArray((invoice as any).xeroPoResults) ? (invoice as any).xeroPoResults : [];
  const anyAlreadyBilled = poResults.some((r) => r.alreadyBilled);
  const anyNotFound = poResults.some((r) => !r.found);
  const anyOverBilled = poResults.some((r) => r.overBilled);
  // Total net diff across all POs (positive = net over-billed, negative = net under-billed)
  const totalNetDiff = (invoice as any).totalNetDiff != null
    ? parseFloat((invoice as any).totalNetDiff.toString())
    : poResults.filter((r) => r.found && !r.alreadyBilled && r.rawDiff !== undefined)
        .reduce((sum, r) => sum + (r.rawDiff ?? 0), 0);
  const totalNetDiffAbs = Math.abs(Math.round(totalNetDiff * 100) / 100);
  const netOverBilled = totalNetDiff > 0.01;
  const netUnderBilled = totalNetDiff < -0.01;

  const noteTypeConfig: Record<string, { icon: React.ComponentType<any>; color: string; label: string }> = {
    note:           { icon: MessageSquare, color: "text-blue-500",   label: "Note" },
    email_sent:     { icon: Mail,          color: "text-purple-500", label: "Email Sent" },
    email_received: { icon: Mail,          color: "text-green-500",  label: "Email Received" },
    status_change:  { icon: RefreshCw,     color: "text-amber-500",  label: "Status Change" },
    system:         { icon: FileText,      color: "text-gray-400",   label: "System" },
  };

  // Multi-PO display (view mode)
  const viewPoNumbers: string[] = (() => {
    const fromJson = Array.isArray((invoice as any).extractedPoNumbers) ? (invoice as any).extractedPoNumbers as string[] : [];
    if (fromJson.length > 0) return fromJson;
    if (invoice.extractedPoNumber) return [invoice.extractedPoNumber];
    return [];
  })();

  return (
    <div className="max-w-7xl mx-auto space-y-5">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2"
            onClick={() => setLocation("/invoices")}
          >
            <ArrowLeft className="h-4 w-4" />
            Invoices
          </Button>

          <div className="flex items-center gap-0.5 border rounded-md">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 rounded-r-none"
              disabled={!prevId}
              onClick={() => prevId && goTo(prevId)}
              title="Previous invoice"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <div className="w-px h-4 bg-border" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 rounded-l-none"
              disabled={!nextId}
              onClick={() => nextId && goTo(nextId)}
              title="Next invoice"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
                <List className="h-3.5 w-3.5" />
                All Invoices
                {allInvoices && (
                  <Badge variant="secondary" className="text-xs font-normal h-4 px-1.5 ml-0.5">
                    {allInvoices.length}
                  </Badge>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-80 p-0">
              <SheetHeader className="px-4 py-3 border-b">
                <SheetTitle className="text-sm font-semibold">All Invoices</SheetTitle>
              </SheetHeader>
              <ScrollArea className="h-full pb-16">
                <div className="divide-y">
                  {(allInvoices ?? []).map((inv: any) => (
                    <button
                      key={inv.id}
                      className={cn(
                        "w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors",
                        inv.id === invoiceId && "bg-primary/5 border-l-2 border-l-primary"
                      )}
                      onClick={() => { goTo(inv.id); setSidebarOpen(false); }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">
                            {inv.extractedInvoiceNumber ?? `Invoice #${inv.id}`}
                          </p>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {inv.extractedSupplierName ?? inv.originalFileName ?? "Unknown"}
                          </p>
                          {inv.extractedPoNumber && (
                            <p className="text-xs text-primary/70 font-mono mt-0.5">{inv.extractedPoNumber}</p>
                          )}
                        </div>
                        <StatusBadge status={inv.status} className="shrink-0 text-xs" />
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </SheetContent>
          </Sheet>

          <span className="text-muted-foreground/40 hidden sm:block">/</span>
          <div className="hidden sm:block">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold text-foreground tracking-tight">
                {invoice.extractedInvoiceNumber ?? `Invoice #${invoice.id}`}
              </h1>
              <StatusBadge status={invoice.status} />
              {(invoice as any).xeroFinalBillId && (
                <Badge className="text-xs gap-1 bg-emerald-100 text-emerald-800 border border-emerald-200 hover:bg-emerald-100">
                  <CheckCircle2 className="h-3 w-3" />
                  Pushed to Xero
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {invoice.extractedSupplierName ?? "Unknown supplier"} · {invoice.originalFileName} · Uploaded {formatRelativeTime(invoice.createdAt)}
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {!editMode ? (
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setEditMode(true)}>
              <Pencil className="h-3.5 w-3.5" />
              Edit Fields
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" onClick={() => setEditMode(false)}>
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button size="sm" className="gap-2" onClick={handleSaveEdits} disabled={updateExtractedMutation.isPending}>
                {updateExtractedMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save Changes
              </Button>
            </>
          )}

          {["uploaded", "extracted"].includes(invoice.status) && !editMode && (
            <Button variant="outline" size="sm" className="gap-2" onClick={handleExtract} disabled={extractMutation.isPending}>
              {extractMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Re-extract
            </Button>
          )}
          {canVerify && !editMode && (
            <Button variant="outline" size="sm" className="gap-2" onClick={handleVerify} disabled={verifyMutation.isPending}>
              {verifyMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Verify with Xero
            </Button>
          )}
          {(canQuery || isQueried) && !editMode && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 border-purple-200 text-purple-700 hover:bg-purple-50"
              onClick={() => openEmailDialog(isQueried && hasEmails)}
            >
              <Send className="h-3.5 w-3.5" />
              {isQueried ? "Send Query Again" : "Send Query"}
            </Button>
          )}

          {/* Staff Approve button */}
          {canStaffApprove && !editMode && user?.role !== "admin" && (
            <Button
              size="sm"
              className={cn(
                "gap-2",
                requiresAdminApproval || !staffCanApproveThisInvoice
                  ? "opacity-50 cursor-not-allowed bg-gray-400 hover:bg-gray-400 text-white"
                  : "bg-emerald-600 hover:bg-emerald-700 text-white"
              )}
              onClick={() => {
                if (requiresAdminApproval || !staffCanApproveThisInvoice) {
                  toast.info("Admin approval is required for this invoice — discrepancy exceeds staff threshold.");
                  return;
                }
                setShowStaffApproveDialog(true);
              }}
              disabled={staffApproveMutation.isPending}
            >
              {staffApproveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              {requiresAdminApproval || !staffCanApproveThisInvoice ? "Admin Approval Required" : "Approve"}
            </Button>
          )}

          {/* Admin Approve button (admin only) — before Resolve */}
          {canAdminApprove && !editMode && (
            <Button
              size="sm"
              className="gap-2 bg-violet-600 hover:bg-violet-700 text-white"
              onClick={() => setShowApproveDialog(true)}
              disabled={adminApproveMutation.isPending}
            >
              {adminApproveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              Admin Approve
            </Button>
          )}

          {canResolve && !editMode && (
            <Button size="sm" className="gap-2 bg-sky-600 hover:bg-sky-700 text-white" onClick={() => setShowResolveDialog(true)}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Resolve &amp; Push to Xero
            </Button>
          )}

          {user?.role === "admin" && !editMode && (
            <Button variant="outline" size="sm" className="gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300" onClick={() => setShowDeleteDialog(true)}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Mobile title */}
      <div className="sm:hidden">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground tracking-tight">
            {invoice.extractedInvoiceNumber ?? `Invoice #${invoice.id}`}
          </h1>
          <StatusBadge status={invoice.status} />
          {(invoice as any).xeroFinalBillId && (
            <Badge className="text-xs gap-1 bg-emerald-100 text-emerald-800 border border-emerald-200 hover:bg-emerald-100">
              <CheckCircle2 className="h-3 w-3" />
              Pushed to Xero
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {invoice.extractedSupplierName ?? "Unknown supplier"} · Uploaded {formatRelativeTime(invoice.createdAt)}
        </p>
      </div>

      {/* Admin approval required banner */}
      {requiresAdminApproval && invoice.status !== "approved" && invoice.status !== "resolved" && (
        <div className="flex items-start gap-3 p-4 bg-violet-50 border border-violet-200 rounded-xl">
          <ShieldAlert className="h-5 w-5 text-violet-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-violet-800">Admin Approval Required</p>
            <p className="text-sm text-violet-700 mt-0.5">
              The discrepancy of <strong>{formatCurrency(invoice.discrepancyAmount)}</strong> on this invoice (total {formatCurrency(invoice.extractedTotal)}) exceeds the staff approval threshold.
              An administrator must approve this invoice before it can be resolved.
            </p>
          </div>
        </div>
      )}

      {/* Under-budget banner */}
      {invoice.status === "under_budget" && (
        <div className="flex items-start gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
          <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-emerald-800">Billed Amount is Lower than PO — Safe to Approve</p>
            <p className="text-sm text-emerald-700 mt-0.5">
              {poResults.length > 1
                ? <>Each PO's invoice line items are within the approved PO budget. All {poResults.length} POs verified as under budget.
                   {netUnderBilled && <> Total net saving: <strong>{formatCurrency(totalNetDiffAbs)}</strong> under PO budget.</>}
                   {" "}You may proceed to approve and push to Xero.</>
                : <>Invoice total {formatCurrency(invoice.extractedTotal)} is lower than the Xero PO total{" "}
                   {formatCurrency(invoice.xeroTotal)} by <strong>{formatCurrency(totalNetDiffAbs)}</strong>. The billed amount is within the approved PO budget.
                   You may proceed to approve and push to Xero.</>
              }
            </p>
          </div>
        </div>
      )}

      {/* Approved banner */}
      {invoice.status === "approved" && (
        <div className="flex items-start gap-3 p-4 bg-sky-50 border border-sky-200 rounded-xl">
          <CheckCircle2 className="h-5 w-5 text-sky-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-sky-800">
              {(invoice as any).adminApproved ? "Approved by Admin" : "Approved"}
            </p>
            <p className="text-sm text-sky-700 mt-0.5">
              This invoice has been approved and is ready to push to Xero.
              {(invoice as any).approvalNotes && ` Notes: ${(invoice as any).approvalNotes}`}
            </p>
          </div>
        </div>
      )}

      {/* Discrepancy Alert */}
      {invoice.hasDiscrepancy && invoice.status === "flagged" && (() => {
        if (anyAlreadyBilled) {
          const billedPOs = poResults.filter((r) => r.alreadyBilled).map((r) => r.poNumber).join(", ");
          const paidPOs = poResults.filter((r) => r.alreadyBilled && r.isPaid);
          return (
            <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
              <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800">Duplicate Billing Risk — PO Already Billed in Xero</p>
                <p className="text-sm text-red-700 mt-0.5">
                  Purchase Order{billedPOs.includes(",") ? "s" : ""} <strong>{billedPOs}</strong>{" "}
                  {billedPOs.includes(",") ? "have" : "has"} already been billed in Xero.
                </p>
                {paidPOs.length > 0 && (
                  <p className="text-sm text-red-700 mt-1">
                    {paidPOs.map((r) => (
                      <span key={r.poNumber}>
                        PO <strong>{r.poNumber}</strong> has already been <strong>PAID</strong>
                        {r.paidAmount ? ` ($${r.paidAmount.toFixed(2)})` : ""}
                        {r.paidDate ? ` on ${r.paidDate}` : ""}.{" "}
                      </span>
                    ))}
                  </p>
                )}
                <p className="text-sm text-red-700 mt-1">This invoice may be a duplicate. Please verify with the supplier before approving.</p>
              </div>
            </div>
          );
        }
        if (anyNotFound) {
          const notFoundPOs = poResults.filter((r) => !r.found).map((r) => r.poNumber).join(", ");
          return (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-amber-800">Purchase Order Not Found in Xero</p>
                <p className="text-sm text-amber-700 mt-0.5">
                  Purchase Order{notFoundPOs.includes(",") ? "s" : ""} <strong>{notFoundPOs}</strong> could not be found in Xero.
                </p>
              </div>
            </div>
          );
        }
        if (anyOverBilled) {
          const overBilledPOs = poResults.filter((r) => r.overBilled);
          const underBilledPOs = poResults.filter((r) => r.found && !r.alreadyBilled && r.underBilled);
          return (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
              <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-amber-800">Amount Discrepancy — Invoice Exceeds PO</p>
                {overBilledPOs.map((r) => (
                  <p key={r.poNumber} className="text-sm text-amber-700">
                    PO <strong>{r.poNumber}</strong>: invoice lines {formatCurrency(r.invoiceLineItemTotal ?? invoice.extractedTotal)}{" "}
                    vs PO total {formatCurrency(r.poTotal)} — <strong className="text-red-700">over by {formatCurrency(r.diff)}</strong>
                  </p>
                ))}
                {underBilledPOs.map((r) => (
                  <p key={r.poNumber} className="text-sm text-emerald-700">
                    PO <strong>{r.poNumber}</strong>: invoice lines {formatCurrency(r.invoiceLineItemTotal ?? invoice.extractedTotal)}{" "}
                    vs PO total {formatCurrency(r.poTotal)} — <strong>under by {formatCurrency(Math.abs(r.rawDiff ?? 0))}</strong>
                  </p>
                ))}
                <p className="text-sm font-medium text-amber-800 border-t border-amber-200 pt-1 mt-1">
                  Net total difference: {netOverBilled
                    ? <><strong className="text-red-700">+{formatCurrency(totalNetDiffAbs)}</strong> over budget overall</>
                    : netUnderBilled
                      ? <><strong className="text-emerald-700">−{formatCurrency(totalNetDiffAbs)}</strong> under budget overall (but flagged because at least one PO is over-billed)</>  
                      : <>amounts balance out overall</>}
                </p>
              </div>
            </div>
          );
        }
        return (
          <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Xero Verification Issue</p>
              <p className="text-sm text-amber-700 mt-0.5">A discrepancy was detected during Xero PO verification. Please review the PO details below.</p>
            </div>
          </div>
        );
      })()}

      {/* Xero resolved banner */}
      {(invoice as any).xeroFinalBillId && (
        <Card className="border border-emerald-200 bg-emerald-50/50 shadow-sm">
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-500 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-emerald-800">Bill Created in Xero</p>
              <p className="text-xs text-emerald-700 mt-0.5">
                Bill number: <strong>{(invoice as any).xeroFinalBillNumber}</strong>
                {invoice.status === "resolved" && (
                  <> — {["verified", "under_budget"].includes((invoice as any).resolvedFromStatus ?? "") ? "Awaiting Payment" : "Awaiting Approval"} in Xero</>
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Main two-column layout ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

        {/* LEFT: Extracted data + line items */}
        <div className="space-y-4">

          {/* Key fields */}
          <Card className={cn("border shadow-sm", editMode && "ring-2 ring-primary/20")}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  Extracted Invoice Data
                </CardTitle>
                {editMode && (
                  <Badge variant="outline" className="text-xs text-primary border-primary/30 gap-1">
                    <Pencil className="h-2.5 w-2.5" />
                    Editing
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {editMode ? (
                <div className="grid grid-cols-2 gap-3">
                  <EditField label="Invoice Number" icon={Hash}
                    value={editFields.extractedInvoiceNumber}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedInvoiceNumber: v }))} />

                  {/* Date pickers */}
                  <DatePickerField
                    label="Invoice Date"
                    icon={Calendar}
                    value={editFields.extractedInvoiceDate}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedInvoiceDate: v }))}
                  />
                  <DatePickerField
                    label="Due Date"
                    icon={Calendar}
                    value={editFields.extractedDueDate}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedDueDate: v }))}
                    issueDate={editFields.extractedInvoiceDate}
                    showQuickSelect
                  />

                  {/* Supplier */}
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5" />
                      Supplier Name
                    </Label>
                    <SupplierCombobox
                      value={editFields.extractedSupplierName}
                      onChange={({ name, supplierId }) => {
                        setEditFields(f => ({ ...f, extractedSupplierName: name }));
                        setEditSupplierId(supplierId);
                      }}
                    />
                  </div>
                  <EditField label="ABN" icon={Hash}
                    value={editFields.extractedSupplierAbn}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedSupplierAbn: v }))} />
                  <EditField label="Supplier Email" icon={Mail}
                    value={editFields.extractedSupplierEmail}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedSupplierEmail: v }))}
                    placeholder="supplier@example.com" />
                  <EditField label="Currency" icon={DollarSign}
                    value={editFields.extractedCurrency}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedCurrency: v }))}
                    placeholder="AUD" />
                  <div className="col-span-2">
                    <EditField label="Container Numbers (comma-separated)" icon={Container}
                      value={editFields.extractedContainerNumbers}
                      onChange={(v) => setEditFields(f => ({ ...f, extractedContainerNumbers: v }))}
                      placeholder="MSCU1234567, TCKU9876543" />
                  </div>
                  <EditField label="Subtotal" icon={DollarSign}
                    value={editFields.extractedSubtotal}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedSubtotal: v }))}
                    placeholder="0.00" />
                  <EditField label="GST" icon={DollarSign}
                    value={editFields.extractedTax}
                    onChange={(v) => setEditFields(f => ({ ...f, extractedTax: v }))}
                    placeholder="0.00" />
                  <div className="col-span-2">
                    <EditField label="Total" icon={DollarSign}
                      value={editFields.extractedTotal}
                      onChange={(v) => setEditFields(f => ({ ...f, extractedTotal: v }))}
                      placeholder="0.00" />
                  </div>

                  {/* Multi-PO section */}
                  <div className="col-span-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground flex items-center gap-1">
                        <Hash className="h-3 w-3" />
                        PO Numbers ({editPoNumbers.length}/15)
                      </Label>
                      {editPoNumbers.length < 15 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs gap-1 px-2"
                          onClick={handleAddPoField}
                        >
                          <Plus className="h-3 w-3" />
                          Add PO
                        </Button>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {editPoNumbers.map((po, idx) => (
                        <div key={idx} className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground w-5 shrink-0 text-right">{idx + 1}.</span>
                          <Input
                            value={po}
                            onChange={(e) => handleUpdatePoField(idx, e.target.value)}
                            placeholder={`PO number ${idx + 1}`}
                            className="h-7 text-xs flex-1 font-mono"
                          />
                          {editPoNumbers.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => handleRemovePoField(idx)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                /* ── View mode ── */
                <>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <DataRow icon={Hash} label="Invoice Number" value={invoice.extractedInvoiceNumber} />
                    <DataRow icon={Calendar} label="Invoice Date" value={toDisplayDate(invoice.extractedInvoiceDate)} />
                    <DataRow icon={Calendar} label="Due Date" value={toDisplayDate(invoice.extractedDueDate)} />
                    <DataRow icon={Building2} label="Supplier" value={invoice.extractedSupplierName} />
                    <DataRow icon={Hash} label="ABN" value={invoice.extractedSupplierAbn} />
                  </div>

                  {/* Multi-PO view */}
                  {viewPoNumbers.length > 0 && (
                    <>
                      <Separator />
                      <div>
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                          <Hash className="h-3.5 w-3.5" />
                          Purchase Order{viewPoNumbers.length > 1 ? "s" : ""} ({viewPoNumbers.length})
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {viewPoNumbers.map((po) => (
                            <Badge key={po} variant="outline" className="font-mono text-xs text-primary border-primary/30">
                              {po}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </>
                  )}

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
                      {invoice.xeroVerifiedAt && (
                        <span className="text-muted-foreground/60 font-normal normal-case tracking-normal ml-auto">
                          verified {formatRelativeTime(invoice.xeroVerifiedAt)}
                        </span>
                      )}
                    </p>

                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Extracted (Invoice)</p>
                        <AmountRow label="Subtotal" value={formatCurrency(invoice.extractedSubtotal)} />
                        <AmountRow label="GST" value={formatCurrency(invoice.extractedTax)} />
                        <AmountRow label="Total" value={formatCurrency(invoice.extractedTotal)} highlight />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          {poResults.length === 0 ? "Xero PO" :
                           poResults.length === 1 ? `Xero PO ${poResults[0].poNumber}` :
                           `Xero POs (${poResults.length})`}
                        </p>
                        {invoice.xeroTotal ? (
                          <>
                            <AmountRow label="Subtotal" value={formatCurrency(invoice.xeroSubtotal)} />
                            <AmountRow label="GST" value={formatCurrency(invoice.xeroTax)} />
                            <AmountRow label="Total" value={formatCurrency(invoice.xeroTotal)} highlight discrepancy={invoice.hasDiscrepancy ?? false} />
                          </>
                        ) : invoice.xeroVerifiedAt && invoice.hasDiscrepancy ? (
                          <p className="text-xs text-destructive italic">PO not found in Xero</p>
                        ) : (
                          <p className="text-xs text-muted-foreground italic">Not verified yet</p>
                        )}
                      </div>
                    </div>

                    {/* Per-PO results */}
                    {poResults.length > 0 && (
                      <div className="space-y-3">
                        {poResults.map((po) => (
                          <div key={po.poNumber} className={cn(
                            "rounded-lg border p-3 text-xs",
                            !po.found ? "border-red-200 bg-red-50/50" :
                            po.alreadyBilled ? "border-red-200 bg-red-50/50" :
                            po.overBilled ? "border-amber-200 bg-amber-50/50" :
                            po.underBilled ? "border-emerald-200 bg-emerald-50/50" :
                            po.discrepancy ? "border-amber-200 bg-amber-50/50" :
                            "border-emerald-200 bg-emerald-50/50"
                          )}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-semibold text-sm">{po.poNumber}</span>
                                <XeroPoStatusBadge status={po.status} />
                                {/* Match/no-match indicator */}
                                {po.found && !po.alreadyBilled && (
                                  po.discrepancy ? (
                                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5">
                                      ✗ Mismatch
                                    </span>
                                  ) : (
                                    <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 border border-emerald-200 rounded px-1.5 py-0.5">
                                      ✓ Match
                                    </span>
                                  )
                                )}
                              </div>
                              {po.found && !po.alreadyBilled && (
                                <div className="flex items-center gap-3 text-muted-foreground">
                                  {po.invoiceLineItemTotal !== undefined && (
                                    <span>Invoice lines: <strong>{formatCurrency(po.invoiceLineItemTotal)}</strong></span>
                                  )}
                                  <span>PO total: <strong className={cn(
                                    po.overBilled ? "text-amber-700" :
                                    po.underBilled ? "text-emerald-700" :
                                    "text-emerald-700"
                                  )}>{formatCurrency(po.poTotal)}</strong></span>
                                  {po.overBilled && (
                                    <span className="text-amber-700 font-medium">⚠ Over by {formatCurrency(po.diff)}</span>
                                  )}
                                  {po.underBilled && (
                                    <span className="text-emerald-700 font-medium">✓ Under by {formatCurrency(Math.abs(po.diff))}</span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Already billed + payment status */}
                            {po.alreadyBilled && (
                              <div className="mt-1 space-y-0.5">
                                <p className="text-red-700 font-medium">This PO has already been billed in Xero.</p>
                                {po.isPaid ? (
                                  <p className="text-red-700">
                                    <strong>PAID</strong>
                                    {po.paidAmount ? ` — $${po.paidAmount.toFixed(2)}` : ""}
                                    {po.paidDate ? ` on ${po.paidDate}` : ""}
                                  </p>
                                ) : (
                                  <p className="text-amber-700">Payment status: <strong>NOT YET PAID</strong></p>
                                )}
                              </div>
                            )}

                            {/* PO line items */}
                            {po.found && !po.alreadyBilled && po.lineItems && po.lineItems.length > 0 && (
                              <div className="mt-2">
                                <p className="text-xs text-muted-foreground font-medium mb-1.5">PO Line Items</p>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-muted-foreground border-b">
                                        <th className="text-left pb-1 font-medium pr-3">Description</th>
                                        <th className="text-right pb-1 font-medium pr-3">Qty</th>
                                        <th className="text-right pb-1 font-medium pr-3">Unit</th>
                                        <th className="text-right pb-1 font-medium">Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {po.lineItems.map((li: XeroPOLineItem, idx: number) => (
                                        <tr key={li.lineItemId || idx} className="border-b border-border/40 last:border-0">
                                          <td className="py-1 pr-3 text-foreground max-w-[200px] truncate" title={li.description}>
                                            {li.description || <span className="italic text-muted-foreground">No description</span>}
                                          </td>
                                          <td className="py-1 pr-3 text-right tabular-nums">{li.quantity}</td>
                                          <td className="py-1 pr-3 text-right tabular-nums">{formatCurrency(li.unitAmount)}</td>
                                          <td className="py-1 text-right tabular-nums font-medium">{formatCurrency(li.lineAmount)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {!po.found && (
                              <p className="text-red-600 mt-1">This PO was not found in Xero. The PO number may be incorrect or the PO has not been raised yet.</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Line Items */}
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Invoice Lines
                {lineItems.length > 0 && (
                  <Badge variant="secondary" className="text-xs font-normal">{lineItems.length} items</Badge>
                )}
                {editMode && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-7 text-xs gap-1.5"
                    onClick={handleAddLineItem}
                    disabled={addLineItemMutation.isPending}
                  >
                    {addLineItemMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                    New Line
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {lineItems.length === 0 ? (
                <div className="text-center py-4 space-y-2">
                  <p className="text-xs text-muted-foreground italic">No line items extracted. Re-extract to populate.</p>
                  {editMode && (
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={handleAddLineItem} disabled={addLineItemMutation.isPending}>
                      {addLineItemMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      Add First Line
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left pb-2.5 font-medium pr-3">Description</th>
                        {/* Show PO Ref column when any line item has a poNumber or custRef */}
                        {lineItems.some((li) => (li as any).poNumber || (li as any).custRef) && (
                          <th className="text-left pb-2.5 font-medium w-28">PO Ref</th>
                        )}
                        {editMode && <th className="text-left pb-2.5 font-medium w-28">PO Ref</th>}
                        <th className="text-right pb-2.5 font-medium w-16">Qty</th>
                        <th className="text-right pb-2.5 font-medium w-24">Unit Price</th>
                        <th className="text-right pb-2.5 font-medium w-24">Amount</th>
                        {editMode && <th className="w-8"></th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {editMode
                        ? editLineItems.map((li, idx) => (
                            <tr key={li.id} className="text-foreground">
                              <td className="py-1.5 pr-2">
                                <Input value={li.description} onChange={(e) => setEditLineItems(items => items.map((x, i) => i === idx ? { ...x, description: e.target.value } : x))} className="h-7 text-xs" placeholder="Description" />
                              </td>
                              <td className="py-1.5 pr-2">
                                <Input value={(li as any).poNumber ?? ""} onChange={(e) => setEditLineItems(items => items.map((x, i) => i === idx ? { ...x, poNumber: e.target.value } : x))} className="h-7 text-xs w-28" placeholder="P702739" title="PO number for this line" />
                              </td>
                              <td className="py-1.5 pr-2">
                                <Input value={li.quantity} onChange={(e) => setEditLineItems(items => items.map((x, i) => i === idx ? { ...x, quantity: e.target.value } : x))} className="h-7 text-xs text-right w-16" placeholder="1" />
                              </td>
                              <td className="py-1.5 pr-2">
                                <Input value={li.unitPrice} onChange={(e) => setEditLineItems(items => items.map((x, i) => i === idx ? { ...x, unitPrice: e.target.value } : x))} className="h-7 text-xs text-right w-24" placeholder="0.00" />
                              </td>
                              <td className="py-1.5">
                                <Input value={li.amount} onChange={(e) => setEditLineItems(items => items.map((x, i) => i === idx ? { ...x, amount: e.target.value } : x))} className="h-7 text-xs text-right w-24" placeholder="0.00" />
                              </td>
                              <td className="py-1.5 pl-1">
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDeleteLineItem(li.id)} disabled={deleteLineItemMutation.isPending} title="Delete line">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </td>
                            </tr>
                          ))
                        : lineItems.map((li) => (
                            <tr key={li.id} className="text-foreground hover:bg-muted/30 transition-colors">
                              <td className="py-2.5 pr-3 leading-relaxed">{li.description ?? "—"}</td>
                              {lineItems.some((l) => (l as any).poNumber || (l as any).custRef) && (
                                <td className="py-2.5 pr-3 text-xs font-mono text-primary">
                                  {(li as any).poNumber
                                    ? <span title={(li as any).custRef ?? ""}>{(li as any).poNumber}</span>
                                    : (li as any).custRef
                                      ? <span className="text-muted-foreground text-xs">{(li as any).custRef}</span>
                                      : "—"}
                                </td>
                              )}
                              <td className="py-2.5 text-right tabular-nums text-muted-foreground">{li.quantity ?? "—"}</td>
                              <td className="py-2.5 text-right tabular-nums text-muted-foreground">{formatCurrency(li.unitPrice)}</td>
                              <td className="py-2.5 text-right tabular-nums font-medium">{formatCurrency(li.amount)}</td>
                            </tr>
                          ))
                      }
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

          {/* Query Points */}
          <Card className="border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                Query Points
                {queryPoints.length > 0 && (
                  <Badge variant="secondary" className="text-xs font-normal">{queryPoints.length} {queryPoints.length === 1 ? "point" : "points"}</Badge>
                )}
                <span className="ml-auto text-xs font-normal text-muted-foreground">Reflected in dispute email</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {queryPoints.length === 0 ? (
                <p className="text-xs text-muted-foreground italic text-center py-2">No query points added yet.</p>
              ) : (
                <ol className="space-y-2">
                  {queryPoints.map((pt, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="shrink-0 mt-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-semibold">{idx + 1}</span>
                      <Textarea value={pt} onChange={(e) => handleUpdateQueryPoint(idx, e.target.value)} className="flex-1 text-xs min-h-[60px] resize-none" placeholder={`Query point ${idx + 1}`} />
                      <Button variant="ghost" size="icon" className="h-7 w-7 mt-1 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleRemoveQueryPoint(idx)} title="Remove">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
              <div className="pt-1">
                <Select value="" onValueChange={(val) => {
                  if (!val) return;
                  setQueryPoints(prev => [...prev, val]);
                  setQueryPointsSaved(false);
                  setQueryPointsDirty(true);
                }}>
                  <SelectTrigger className="h-8 text-xs w-full">
                    <SelectValue placeholder="⚡ Quick-add a common dispute reason..." />
                  </SelectTrigger>
                  <SelectContent>
                    {DISPUTE_TEMPLATES.map((tpl) => (
                      <SelectItem key={tpl} value={tpl} className="text-xs">{tpl}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Input value={newQueryPoint} onChange={(e) => setNewQueryPoint(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddQueryPoint(); } }} placeholder="Or type a custom query point..." className="flex-1 text-xs h-8" />
                <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 shrink-0" onClick={handleAddQueryPoint} disabled={!newQueryPoint.trim()}>
                  <Plus className="h-3 w-3" /> Add
                </Button>
              </div>
              {(queryPointsDirty || queryPointsSaved) && (
                <Button size="sm" className="w-full h-8 text-xs gap-1.5" onClick={handleSaveQueryPoints} disabled={saveQueryPointsMutation.isPending || queryPointsSaved}>
                  {saveQueryPointsMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : queryPointsSaved ? <CheckCircle2 className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                  {queryPointsSaved ? "Saved — email updated" : "Save & Update Email Template"}
                </Button>
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
                    {supplier.contactName && <div className="flex items-center gap-2 text-xs text-muted-foreground"><User className="h-3 w-3 shrink-0" />{supplier.contactName}</div>}
                    {supplier.email && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Mail className="h-3 w-3 shrink-0" />{supplier.email}</div>}
                    {supplier.phone && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Phone className="h-3 w-3 shrink-0" />{supplier.phone}</div>}
                    {supplier.address && <div className="flex items-start gap-2 text-xs text-muted-foreground"><MapPin className="h-3 w-3 shrink-0 mt-0.5" /><span className="whitespace-pre-line">{supplier.address}</span></div>}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* RIGHT: PDF Preview */}
        <div className="space-y-4">
          <Card className="border shadow-sm h-full" style={{ minHeight: "600px" }}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  Invoice PDF
                </CardTitle>
                <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs" onClick={() => window.open(invoice.fileUrl, "_blank")}>
                  <ExternalLink className="h-3 w-3" />
                  Open
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{invoice.originalFileName}</p>
            </CardHeader>
            <CardContent className="p-0 pb-4 px-4">
              <div className="rounded-lg overflow-hidden border bg-muted/20" style={{ height: "560px" }}>
                <iframe src={`${invoice.fileUrl}#toolbar=0&navpanes=0&scrollbar=1`} className="w-full h-full" title="Invoice PDF Preview" style={{ border: "none" }} />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Activity & Notes ── */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-0">
          <Tabs defaultValue="activity">
            <div className="flex items-center justify-between">
              <TabsList className="h-8">
                <TabsTrigger value="activity" className="text-xs gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  Activity & Notes
                  {notes.length > 0 && <Badge variant="secondary" className="text-xs font-normal h-4 px-1.5">{notes.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="emails" className="text-xs gap-1.5">
                  <Mail className="h-3.5 w-3.5" />
                  Email Log
                  {emails.length > 0 && <Badge variant="secondary" className="text-xs font-normal h-4 px-1.5">{emails.length}</Badge>}
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
                <Textarea placeholder="Add a note..." value={noteContent} onChange={(e) => setNoteContent(e.target.value)} className="text-sm resize-none min-h-[72px]" />
                <Button size="sm" variant="outline" className="gap-2" onClick={handleAddNote} disabled={!noteContent.trim() || addNoteMutation.isPending}>
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
                    <div key={email.id} className="border rounded-lg overflow-hidden">
                      <div className="p-3 space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-xs font-medium text-foreground">{email.subject}</p>
                            <p className="text-xs text-muted-foreground">To: {email.toAddress} · {formatRelativeTime(email.sentAt)}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant={email.status === "sent" ? "default" : "destructive"} className="text-xs">{email.status}</Badge>
                            {!(email as any).replyBody && (
                              <Button size="sm" variant="outline" className="h-6 text-xs px-2 gap-1 border-blue-200 text-blue-700 hover:bg-blue-50" onClick={() => handleOpenReplyDialog(email.id)}>
                                <Mail className="h-3 w-3" />
                                Log Reply
                              </Button>
                            )}
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap border-t pt-1.5 mt-1.5 leading-relaxed line-clamp-4">{email.body}</p>
                      </div>
                      {(email as any).replyBody && (
                        <div className="bg-blue-50/50 border-t border-blue-100 p-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <p className="text-xs font-medium text-blue-700 flex items-center gap-1"><Mail className="h-3 w-3" />Supplier Reply</p>
                            <p className="text-xs text-muted-foreground">{formatRelativeTime((email as any).repliedAt)}</p>
                          </div>
                          <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">{(email as any).replyBody}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {emails.length > 0 && (
                <div className="mt-3 pt-3 border-t">
                  <Button size="sm" variant="outline" className="gap-2 border-purple-200 text-purple-700 hover:bg-purple-50" onClick={() => openEmailDialog(true)}>
                    <Send className="h-3.5 w-3.5" />
                    Send Follow-up (pre-filled with last email)
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-0" />
      </Card>

      {/* ── Email Dialog ── */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              {isQueried && hasEmails ? "Send Follow-up Query" : "Send Supplier Query"}
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
              <Textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} className="text-sm min-h-[220px] font-mono" />
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

      {/* ── Resolve Dialog ── */}
      <Dialog open={showResolveDialog} onOpenChange={setShowResolveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              Resolve &amp; Push to Xero
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {poResults.length > 0
                ? `This will convert ${poResults.length} PO${poResults.length > 1 ? "s" : ""} (${poResults.map(r => r.poNumber).join(", ")}) into a bill in Xero and mark them as BILLED.`
                : "This will create a draft bill in Xero ready for payment approval."}
            </p>
            <div className="space-y-1.5">
              <Label className="text-xs">Resolution Notes (optional)</Label>
              <Textarea placeholder="Describe how the dispute was resolved..." value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} className="text-sm min-h-[100px]" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowResolveDialog(false)}>Cancel</Button>
            <Button onClick={handleResolve} disabled={resolveMutation.isPending} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
              {resolveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Resolve &amp; Push to Xero
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Log Reply Dialog ── */}
      <Dialog open={showReplyDialog} onOpenChange={setShowReplyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-blue-500" />
              Log Supplier Reply
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Paste or type the supplier's reply below. It will be saved against this email and added to the activity log.</p>
            <Textarea placeholder="Paste the supplier's reply here..." value={replyBody} onChange={(e) => setReplyBody(e.target.value)} className="text-sm min-h-[140px]" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReplyDialog(false)}>Cancel</Button>
            <Button onClick={handleLogReply} disabled={!replyBody.trim() || logReplyMutation.isPending} className="gap-2 bg-blue-600 hover:bg-blue-700 text-white">
              {logReplyMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
              Save Reply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Dialog ── */}
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
              <strong className="text-foreground">{invoice.extractedInvoiceNumber ?? `Invoice #${invoiceId}`}</strong>?
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

      {/* ── Staff Approve Dialog ── */}
      <Dialog open={showStaffApproveDialog} onOpenChange={setShowStaffApproveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              Approve Invoice
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
              <p className="font-medium">Within staff approval threshold</p>
              <p className="text-xs mt-1 text-emerald-700">
                Invoice total: <strong>{formatCurrency(invoice.extractedTotal)}</strong> ·
                Discrepancy: <strong>{formatCurrency(invoice.discrepancyAmount)}</strong>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Approval Notes (optional)</Label>
              <Textarea placeholder="Reason for approval..." value={staffApproveNotes} onChange={(e) => setStaffApproveNotes(e.target.value)} className="text-sm min-h-[80px]" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStaffApproveDialog(false)}>Cancel</Button>
            <Button onClick={handleStaffApprove} disabled={staffApproveMutation.isPending} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white">
              {staffApproveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Admin Approve Dialog ── */}
      <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-violet-500" />
              Admin Approve Invoice
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              You are approving{" "}
              <strong className="text-foreground">{invoice.extractedInvoiceNumber ?? `Invoice #${invoiceId}`}</strong>{" "}
              as administrator. This will update the PO details in Xero to match the invoice.
            </p>
            {invoice.discrepancyAmount && parseFloat(invoice.discrepancyAmount.toString()) > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                <p className="font-medium">Discrepancy: {formatCurrency(invoice.discrepancyAmount)}</p>
                <p className="text-xs mt-1 text-amber-700">Invoice total: {formatCurrency(invoice.extractedTotal)}</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Approval Notes (optional)</Label>
              <Textarea placeholder="Reason for admin approval..." value={approveNotes} onChange={(e) => setApproveNotes(e.target.value)} className="text-sm min-h-[80px]" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowApproveDialog(false)}>Cancel</Button>
            <Button onClick={handleAdminApprove} disabled={adminApproveMutation.isPending} className="gap-2 bg-violet-600 hover:bg-violet-700 text-white">
              {adminApproveMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
              Admin Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

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

function EditField({
  icon: Icon,
  label,
  value,
  onChange,
  placeholder,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {label}
      </Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8 text-sm" />
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
