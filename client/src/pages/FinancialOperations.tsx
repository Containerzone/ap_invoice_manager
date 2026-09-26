import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/invoiceUtils";
import {
  Activity, AlertTriangle, CalendarClock, CheckCircle2, ClipboardList, Clock3,
  FilePlus2, FileText, Landmark, Play, RefreshCw, Settings2, ShieldCheck,
  Sparkles, TicketCheck, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

const WORKFLOW_OPTIONS = [
  ["container_control_acquisition", "Container Control acquisition"],
  ["recurring_for_hire", "Recurring For Hire"],
  ["storage_activation", "Storage activation"],
  ["recurring_storage", "Recurring storage"],
  ["storage_finalisation", "Storage finalisation"],
  ["main_customer_invoice", "Main customer invoice"],
  ["deposit_invoice", "Deposit invoice"],
  ["final_weight_adjustment", "Final weight adjustment"],
  ["extra_hire", "Extra Hire"],
  ["warranty_reconciliation", "Warranty reconciliation"],
] as const;

const DEFAULT_SOURCE_DATA = `{
  "customerOrganisationName": "Example Customer Pty Ltd",
  "containerType": "20 foot"
}`;

const DEFAULT_EXPECTED_RESULT = `{
  "proposedDocumentNumbers": ["INV-700001"],
  "accountCodes": [],
  "itemCodes": []
}`;

type Intent = {
  id: number;
  documentFamily: "purchase_order" | "customer_invoice";
  documentType: string;
  proposedAction: string;
  proposedDocumentNumber: string | null;
  partyName: string | null;
  accountCode: string | null;
  gstTreatment: string;
  total: string | number;
  validationStatus: string;
  createdAt: Date | string;
  lineItems: unknown;
};

type FinancialRun = {
  id: number;
  workflowType: string;
  triggerType: string;
  sourceRecordId: string | null;
  sourceRecordNumber: string | null;
  status: string;
  validationOutcome: string;
  mode: string;
  createdAt: Date | string;
  errorMessage: string | null;
  intentCount: number;
  exceptionCount: number;
};

type FinancialException = {
  id: number;
  workflowRunId: number | null;
  exceptionCode: string;
  title: string;
  details: string;
  severity: "warning" | "error";
  status: "open" | "resolved" | "ignored";
  assignedTo: number | null;
  resolutionNotes: string | null;
  createdAt: Date | string;
};

type FinancialSchedule = {
  id: number;
  workflowType: string;
  cronExpression: string | null;
  taskUid: string | null;
  enabled: boolean;
  lastRunAt: Date | string | null;
  nextRunAt: Date | string | null;
  lastOutcome: string | null;
};

type ShadowTest = {
  id: number;
  workflowType: string;
  branch: string;
  sourceRecordType: string | null;
  sourceRecordId: string | null;
  sourceRecordNumber: string | null;
  expectedResult: unknown;
  actualResult: unknown;
  fieldComparisons: unknown;
  xeroPreflight: unknown;
  status: "pending" | "passed" | "failed" | "held" | "needs_data" | "blocked";
  differenceExplanation: string | null;
  sourceRefreshedAt: Date | string | null;
  workflowRunId: number | null;
  documentIntentIds: unknown;
  exceptionIds: unknown;
  initiatedBy: number | null;
  testedAt: Date | string | null;
};

function auDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

function titleize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function modeBadge() {
  return <Badge className="border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-50"><ShieldCheck className="mr-1 h-3 w-3" />Shadow mode — no Xero writes</Badge>;
}

function statusBadge(status: string) {
  if (["evaluated", "valid", "passed", "resolved"].includes(status)) return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-50">{titleize(status)}</Badge>;
  if (["held", "warning", "open", "proposed"].includes(status)) return <Badge className="border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-50">{titleize(status)}</Badge>;
  if (["failed", "invalid"].includes(status)) return <Badge className="border-red-200 bg-red-50 text-red-800 hover:bg-red-50">{titleize(status)}</Badge>;
  return <Badge variant="outline">{titleize(status)}</Badge>;
}

function downloadShadowTestsCsv(rows: ShadowTest[]) {
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = ["Test ID", "Workflow", "Branch", "Named source", "Status", "Tested (Australia/Sydney)", "Source refreshed", "Expected", "Actual", "Differences", "Xero preflight", "Explanation", "Workflow run", "Intent IDs", "Exception IDs"];
  const lines = rows.map((row) => [
    row.id, row.workflowType, row.branch, row.sourceRecordNumber ?? row.sourceRecordId ?? "", row.status, auDate(row.testedAt), auDate(row.sourceRefreshedAt),
    JSON.stringify(row.expectedResult ?? {}), JSON.stringify(row.actualResult ?? {}), JSON.stringify(row.fieldComparisons ?? []), JSON.stringify(row.xeroPreflight ?? {}), row.differenceExplanation ?? "", row.workflowRunId ?? "", JSON.stringify(row.documentIntentIds ?? []), JSON.stringify(row.exceptionIds ?? []),
  ].map(escape).join(","));
  const blob = new Blob([[header.map(escape).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `financial-shadow-test-register-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function Metric({ label, value, icon: Icon, tone = "text-sky-600" }: { label: string; value: string | number; icon: typeof Activity; tone?: string }) {
  return <Card><CardContent className="flex items-center gap-3 pt-5 pb-4"><div className={`rounded-lg bg-muted p-2.5 ${tone}`}><Icon className="h-5 w-5" /></div><div><p className="text-2xl font-bold tabular-nums">{value}</p><p className="text-xs text-muted-foreground">{label}</p></div></CardContent></Card>;
}

function DryRunDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const [workflowType, setWorkflowType] = useState<(typeof WORKFLOW_OPTIONS)[number][0]>("main_customer_invoice");
  const [vtigerRecordId, setVtigerRecordId] = useState("");
  const [sourceRecordId, setSourceRecordId] = useState("test-deal-001");
  const [sourceRecordNumber, setSourceRecordNumber] = useState("D700001");
  const [sourceData, setSourceData] = useState(DEFAULT_SOURCE_DATA);
  const [existingNumbers, setExistingNumbers] = useState("");
  const [branch, setBranch] = useState("Named live source validation");
  const [expectedResult, setExpectedResult] = useState(DEFAULT_EXPECTED_RESULT);
  const dryRun = trpc.financialOperations.dryRun.useMutation({
    onSuccess: (result) => {
      toast.success(result.persistence.duplicate ? "Matching shadow run already recorded" : `Shadow run recorded: ${result.evaluation.intents.length} proposed document(s)`);
      utils.financialOperations.dashboard.invalidate();
      utils.financialOperations.runs.invalidate();
      utils.financialOperations.documentIntents.invalidate();
      utils.financialOperations.exceptions.invalidate();
      onOpenChange(false);
    },
    onError: (error) => toast.error(`Dry run failed: ${error.message}`),
  });
  const validateCurrentRecord = trpc.financialOperations.validateCurrentVtigerRecord.useMutation({
    onSuccess: (result) => {
      toast.success(`Read-only shadow test recorded as ${result.testStatus.replace(/_/g, " ")}`);
      utils.financialOperations.dashboard.invalidate();
      utils.financialOperations.runs.invalidate();
      utils.financialOperations.documentIntents.invalidate();
      utils.financialOperations.exceptions.invalidate();
      utils.financialOperations.shadowTests.invalidate();
      onOpenChange(false);
    },
    onError: (error) => toast.error(`Current VTiger record could not be validated: ${error.message}`),
  });

  const submit = () => {
    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(sourceData);
      if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") throw new Error("Source data must be an object");
      parsed = candidate;
    } catch (error: any) {
      toast.error(error?.message ?? "Source data must be valid JSON");
      return;
    }
    dryRun.mutate({
      workflowType,
      sourceRecordId: sourceRecordId.trim() || undefined,
      sourceRecordNumber: sourceRecordNumber.trim() || undefined,
      sourceRecordType: "VTiger record",
      sourceData: parsed,
      existingDocumentNumbers: existingNumbers.split(",").map((value) => value.trim()).filter(Boolean),
      reEvaluationKey: `${Date.now()}`,
    });
  };

  const submitCurrentRecord = () => {
    let parsedExpected: Record<string, unknown>;
    try {
      const candidate = JSON.parse(expectedResult);
      if (!candidate || Array.isArray(candidate) || typeof candidate !== "object") throw new Error("Expected result must be an object");
      parsedExpected = candidate;
    } catch (error: any) {
      toast.error(error?.message ?? "Expected result must be valid JSON");
      return;
    }
    validateCurrentRecord.mutate({
      workflowType,
      branch: branch.trim() || "Named live source validation",
      vtigerRecordId: vtigerRecordId.trim(),
      sourceRecordNumber: sourceRecordNumber.trim() || undefined,
      sourceRecordType: "VTiger record",
      existingDocumentNumbers: existingNumbers.split(",").map((value) => value.trim()).filter(Boolean),
      expectedResult: parsedExpected,
    });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle className="flex items-center gap-2"><Play className="h-4 w-4" />Read-only financial shadow test</DialogTitle></DialogHeader><div className="space-y-4 text-sm"><div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sky-900"><ShieldCheck className="mr-1 inline h-4 w-4" /><strong>Shadow mode only.</strong> This test reads one current VTiger record, reads only relevant Xero contacts/items/document candidates, then records evidence. It cannot create, update, authorise, send, pay, void or delete a Xero document.</div><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Workflow family</Label><select value={workflowType} onChange={(event) => setWorkflowType(event.target.value as typeof workflowType)} className="h-9 w-full rounded-md border bg-background px-3 text-sm">{WORKFLOW_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="space-y-1.5"><Label>Validation branch</Label><Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Initial For Hire / Origin / Overweight" /></div><div className="space-y-1.5"><Label>Named Deal / Container Control</Label><Input value={sourceRecordNumber} onChange={(event) => setSourceRecordNumber(event.target.value)} /></div><div className="space-y-1.5"><Label>Existing Xero-style references (optional)</Label><Input value={existingNumbers} onChange={(event) => setExistingNumbers(event.target.value)} placeholder="INV-700001-1, HC1860-2" /></div></div><div className="rounded-lg border bg-muted/20 p-3"><Label htmlFor="vtiger-current-record">Current VTiger record ID</Label><Input id="vtiger-current-record" className="mt-1.5" value={vtigerRecordId} onChange={(event) => setVtigerRecordId(event.target.value)} placeholder="4x12345" /><p className="mt-1.5 text-xs text-muted-foreground">Uses this AP project’s server-side VTiger credentials for a user-initiated GET-only source refresh; it does not change CRM data or URLs.</p></div><div className="space-y-1.5"><Label>Expected result (business-rule facts)</Label><Textarea value={expectedResult} onChange={(event) => setExpectedResult(event.target.value)} className="min-h-36 font-mono text-xs" /><p className="text-xs text-muted-foreground">Supply only facts to compare. Leave arrays empty only when the field is not part of this branch; no expected facts yields a needs-data evidence record.</p></div><details className="rounded-lg border bg-muted/20 p-3"><summary className="cursor-pointer font-medium">Optional synthetic evaluator preview</summary><div className="mt-3 space-y-3"><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Preview source record ID</Label><Input value={sourceRecordId} onChange={(event) => setSourceRecordId(event.target.value)} /></div></div><Textarea value={sourceData} onChange={(event) => setSourceData(event.target.value)} className="min-h-40 font-mono text-xs" /><Button type="button" variant="outline" onClick={submit} disabled={dryRun.isPending}>{dryRun.isPending ? "Evaluating…" : "Preview synthetic payload"}</Button></div></details></div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submitCurrentRecord} disabled={!/^\d+x\d+$/i.test(vtigerRecordId.trim()) || validateCurrentRecord.isPending}>{validateCurrentRecord.isPending ? "Reading and validating…" : "Run read-only shadow test"}</Button></DialogFooter></DialogContent></Dialog>;
}


function BlockedTestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const utils = trpc.useUtils();
  const [workflowType, setWorkflowType] = useState<(typeof WORKFLOW_OPTIONS)[number][0]>("main_customer_invoice");
  const [branch, setBranch] = useState("Named branch");
  const [sourceRecordNumber, setSourceRecordNumber] = useState("");
  const [missingCondition, setMissingCondition] = useState("Required current VTiger source record or approved expected-result facts are not available.");
  const record = trpc.financialOperations.recordBlockedShadowTest.useMutation({
    onSuccess: () => { toast.success("Needs-data shadow evidence recorded"); utils.financialOperations.shadowTests.invalidate(); onOpenChange(false); },
    onError: (error) => toast.error(error.message),
  });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Record blocked test condition</DialogTitle></DialogHeader><div className="space-y-3 text-sm"><p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">This records a <strong>needs-data</strong> evidence row only. It does not retrieve, create or change any VTiger or Xero record.</p><div className="space-y-1.5"><Label>Workflow family</Label><select value={workflowType} onChange={(event) => setWorkflowType(event.target.value as typeof workflowType)} className="h-9 w-full rounded-md border bg-background px-3 text-sm">{WORKFLOW_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="space-y-1.5"><Label>Branch</Label><Input value={branch} onChange={(event) => setBranch(event.target.value)} /></div><div className="space-y-1.5"><Label>Named Deal / Container Control (optional)</Label><Input value={sourceRecordNumber} onChange={(event) => setSourceRecordNumber(event.target.value)} /></div><div className="space-y-1.5"><Label>Exact missing source condition</Label><Textarea value={missingCondition} onChange={(event) => setMissingCondition(event.target.value)} className="min-h-28" /></div></div><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={record.isPending || branch.trim().length === 0 || missingCondition.trim().length < 8} onClick={() => record.mutate({ workflowType, branch: branch.trim(), sourceRecordNumber: sourceRecordNumber.trim() || undefined, sourceRecordType: "VTiger record", missingCondition: missingCondition.trim() })}>{record.isPending ? "Recording…" : "Record needs-data evidence"}</Button></DialogFooter></DialogContent></Dialog>;
}

export default function FinancialOperations() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const isAdmin = user?.role === "admin";
  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [selectedException, setSelectedException] = useState<FinancialException | null>(null);
  const [selectedShadowTest, setSelectedShadowTest] = useState<ShadowTest | null>(null);
  const [blockedTestOpen, setBlockedTestOpen] = useState(false);
  const [historicalReferences, setHistoricalReferences] = useState("");
  const [historicalRows, setHistoricalRows] = useState<Array<{ reference: string; inferredFamily: string; reconciliationState: string; xeroDocumentId: string | null; documentNumber: string | null; status: string | null; partyName: string | null; importPreviewedAt: Date | string; note: string }>>([]);
  const [comment, setComment] = useState("");
  const [configKey, setConfigKey] = useState("warranty.mappings");
  const [configValue, setConfigValue] = useState("{}");
  const [configDescription, setConfigDescription] = useState("Non-secret warranty item mappings for shadow validation");
  const [poFilter, setPoFilter] = useState("");
  const [invoiceFilter, setInvoiceFilter] = useState("");
  const dashboard = trpc.financialOperations.dashboard.useQuery(undefined, { refetchInterval: 30_000 });
  const runs = trpc.financialOperations.runs.useQuery({ limit: 150 }, { refetchInterval: 30_000 });
  const intents = trpc.financialOperations.documentIntents.useQuery({ limit: 300 }, { refetchInterval: 30_000 });
  const exceptions = trpc.financialOperations.exceptions.useQuery({ limit: 300 }, { refetchInterval: 30_000 });
  const schedules = trpc.financialOperations.schedules.useQuery(undefined, { refetchInterval: 30_000 });
  const config = trpc.financialOperations.config.useQuery(undefined, { enabled: isAdmin });
  const configAudits = trpc.financialOperations.configAudits.useQuery(undefined, { enabled: isAdmin });
  const automationSettings = trpc.financialOperations.automationSettings.useQuery(undefined, { enabled: isAdmin });
  const shadowTests = trpc.financialOperations.shadowTests.useQuery({ limit: 300 }, { enabled: isAdmin, refetchInterval: 30_000 });
  const vtigerReadStatus = trpc.financialOperations.vtigerReadStatus.useQuery(undefined, { enabled: isAdmin });
  const comments = trpc.financialOperations.exceptionComments.useQuery({ exceptionId: selectedException?.id ?? 0 }, { enabled: selectedException !== null });
  const resolve = trpc.financialOperations.resolveException.useMutation({ onSuccess: () => { toast.success("Exception resolved"); utils.financialOperations.exceptions.invalidate(); setSelectedException(null); } });
  const addComment = trpc.financialOperations.addExceptionComment.useMutation({ onSuccess: () => { setComment(""); utils.financialOperations.exceptionComments.invalidate(); toast.success("Review comment added"); } });
  const saveConfig = trpc.financialOperations.saveConfig.useMutation({ onSuccess: () => { toast.success("Non-secret mapping saved"); utils.financialOperations.config.invalidate(); utils.financialOperations.configAudits.invalidate(); utils.financialOperations.automationSettings.invalidate(); } });
  const testVtigerConnection = trpc.financialOperations.testVtigerConnection.useMutation({
    onSuccess: (result) => {
      result.outcome === "passed" ? toast.success(result.message) : toast.error(result.message);
      utils.financialOperations.automationSettings.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const testXeroConnection = trpc.financialOperations.testXeroConnection.useMutation({
    onSuccess: (result) => {
      result.outcome === "passed" ? toast.success(result.message) : toast.error(result.message);
      utils.financialOperations.automationSettings.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const historicalPreview = trpc.financialOperations.historicalImportPreview.useMutation({
    onSuccess: (result) => {
      setHistoricalRows(result.rows);
      toast.success(`Read-only historical preview returned ${result.rows.length} reference${result.rows.length === 1 ? "" : "s"}`);
    },
    onError: (error) => toast.error(error.message),
  });

  const allIntents = (intents.data ?? []) as Intent[];
  const poIntents = useMemo(() => allIntents.filter((intent) => intent.documentFamily === "purchase_order" && `${intent.proposedDocumentNumber ?? ""} ${intent.partyName ?? ""} ${intent.documentType}`.toLowerCase().includes(poFilter.toLowerCase())), [allIntents, poFilter]);
  const customerIntents = useMemo(() => allIntents.filter((intent) => intent.documentFamily === "customer_invoice" && `${intent.proposedDocumentNumber ?? ""} ${intent.partyName ?? ""} ${intent.documentType}`.toLowerCase().includes(invoiceFilter.toLowerCase())), [allIntents, invoiceFilter]);
  const exceptionRows = (exceptions.data ?? []) as FinancialException[];
  const runRows = (runs.data ?? []) as FinancialRun[];
  const persistedSchedules = (schedules.data ?? []) as FinancialSchedule[];
  const shadowTestRows = (shadowTests.data ?? []) as ShadowTest[];
  // Phase one intentionally creates no Heartbeat task. Render the two planned
  // financial schedules explicitly even before an administrator documents a
  // future cadence in the ledger.
  const scheduleRows = (["recurring_for_hire", "recurring_storage"] as const).map((workflowType, index) =>
    persistedSchedules.find((schedule) => schedule.workflowType === workflowType) ?? {
      id: -(index + 1), workflowType, cronExpression: null, taskUid: null, enabled: false,
      lastRunAt: null, nextRunAt: null, lastOutcome: "not_registered",
    },
  );
  const refreshAll = () => { dashboard.refetch(); runs.refetch(); intents.refetch(); exceptions.refetch(); schedules.refetch(); shadowTests.refetch(); automationSettings.refetch(); };

  return <div className="mx-auto max-w-7xl space-y-6"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><div className="flex flex-wrap items-center gap-2"><h1 className="text-2xl font-bold tracking-tight">Financial Operations</h1>{modeBadge()}</div><p className="mt-1 text-sm text-muted-foreground">AP-side migration workbench for proposed financial triggers. Existing AP bills, VTiger workflows, schedules and live Xero documents remain untouched.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={refreshAll}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>{isAdmin && <Button onClick={() => setDryRunOpen(true)}><Play className="mr-2 h-4 w-4" />New dry-run</Button>}</div></div>
    <div className="rounded-xl border border-sky-200 bg-gradient-to-r from-sky-50 to-indigo-50 px-4 py-3 text-sm text-sky-950"><ShieldCheck className="mr-2 inline h-4 w-4" /><strong>Financial write lock is active.</strong> Every result below is an AP-side shadow calculation and audit record. There is no live retry or schedule-enable action on this page.</div>
    {dashboard.isLoading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-24" />)}</div> : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6"><Metric label="Trigger runs today" value={dashboard.data?.runsToday ?? 0} icon={Activity} /><Metric label="Proposed documents" value={dashboard.data?.proposedDocuments ?? 0} icon={FilePlus2} tone="text-violet-600" /><Metric label="Confirmed Draft documents" value={dashboard.data?.confirmedDraftDocuments ?? 0} icon={CheckCircle2} tone="text-slate-500" /><Metric label="Failed or held" value={dashboard.data?.failedOrHeld ?? 0} icon={TriangleAlert} tone="text-amber-600" /><Metric label="Open exceptions" value={dashboard.data?.openExceptions ?? 0} icon={AlertTriangle} tone="text-red-600" /><Metric label="Next recurring / storage" value={dashboard.data?.nextRecurringHire ? auDate(dashboard.data.nextRecurringHire) : dashboard.data?.nextStorage ? auDate(dashboard.data.nextStorage) : "Not scheduled"} icon={CalendarClock} tone="text-indigo-600" /></div>}
    <Tabs defaultValue="overview" className="gap-5"><TabsList className="h-auto w-full justify-start overflow-x-auto"><TabsTrigger value="overview">Overview</TabsTrigger><TabsTrigger value="po">PO Operations</TabsTrigger><TabsTrigger value="invoices">Customer Invoices</TabsTrigger><TabsTrigger value="runs">Trigger Runs</TabsTrigger><TabsTrigger value="exceptions">Exceptions</TabsTrigger><TabsTrigger value="schedules">Schedules</TabsTrigger>{isAdmin && <TabsTrigger value="shadow-tests">Shadow Test Register</TabsTrigger>}{isAdmin && <TabsTrigger value="history-preview">Historical Preview</TabsTrigger>}{isAdmin && <TabsTrigger value="configuration">Automation Settings</TabsTrigger>}</TabsList>
      <TabsContent value="overview" className="space-y-4"><div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><ClipboardList className="h-4 w-4" />Phase-one coverage</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm sm:grid-cols-2">{WORKFLOW_OPTIONS.map(([value, label]) => <div key={value} className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2"><CheckCircle2 className="h-4 w-4 text-emerald-600" /><span>{label}</span></div>)}</CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Landmark className="h-4 w-4" />Current controls</CardTitle></CardHeader><CardContent className="space-y-3 text-sm text-muted-foreground"><p><strong className="text-foreground">VTiger:</strong> accepted test events are isolated to this AP project; no existing CRM workflow URL is changed.</p><p><strong className="text-foreground">Xero:</strong> proposed numbers and validation data are recorded only. No create, update, authorise, send, pay, void or delete is available.</p><p><strong className="text-foreground">Schedules:</strong> configured state is visible below, but target jobs remain disabled and no Heartbeat task is created.</p></CardContent></Card></div></TabsContent>
      <TabsContent value="po" className="space-y-4"><Card><CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle>PO Operations</CardTitle><p className="mt-1 text-sm text-muted-foreground">Asset, Customer Sale, initial/recurring Hire, JD, GD and Aviso warranty purchase-order proposals.</p></div><Input value={poFilter} onChange={(event) => setPoFilter(event.target.value)} placeholder="Filter PO, party or family" className="sm:w-72" /></CardHeader><CardContent>{poIntents.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">No proposed POs match the current filter.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">PO / family</th><th className="p-3">Supplier</th><th className="p-3">Account</th><th className="p-3 text-right">Proposed total</th><th className="p-3">Action</th><th className="p-3">Validation</th></tr></thead><tbody>{poIntents.map((intent) => <tr key={intent.id} className="border-b last:border-0"><td className="p-3"><p className="font-mono font-medium">{intent.proposedDocumentNumber ?? "Reference pending"}</p><p className="text-xs text-muted-foreground">{titleize(intent.documentType)}</p></td><td className="p-3">{intent.partyName ?? "Unassigned"}</td><td className="p-3 font-mono">{intent.accountCode ?? "—"}</td><td className="p-3 text-right tabular-nums">{formatCurrency(Number(intent.total))}</td><td className="p-3">{titleize(intent.proposedAction)}</td><td className="p-3">{statusBadge(intent.validationStatus)}</td></tr>)}</tbody></table></div>}</CardContent></Card></TabsContent>
      <TabsContent value="invoices" className="space-y-4"><Card><CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle>Customer Invoice Operations</CardTitle><p className="mt-1 text-sm text-muted-foreground">Main, deposit, storage, final-weight, extra-hire and warranty invoice proposals, all Draft-only in a future approved phase.</p></div><Input value={invoiceFilter} onChange={(event) => setInvoiceFilter(event.target.value)} placeholder="Filter invoice, customer or type" className="sm:w-72" /></CardHeader><CardContent>{customerIntents.length === 0 ? <p className="py-10 text-center text-sm text-muted-foreground">No proposed customer invoices match the current filter.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Invoice / type</th><th className="p-3">Customer</th><th className="p-3">GST treatment</th><th className="p-3 text-right">Proposed total</th><th className="p-3">Draft eligibility</th></tr></thead><tbody>{customerIntents.map((intent) => <tr key={intent.id} className="border-b last:border-0"><td className="p-3"><p className="font-mono font-medium">{intent.proposedDocumentNumber ?? "Reference pending"}</p><p className="text-xs text-muted-foreground">{titleize(intent.documentType)}</p></td><td className="p-3">{intent.partyName ?? "Unassigned"}</td><td className="p-3">{intent.gstTreatment}</td><td className="p-3 text-right tabular-nums">{formatCurrency(Number(intent.total))}</td><td className="p-3">{statusBadge(intent.validationStatus)}</td></tr>)}</tbody></table></div>}</CardContent></Card></TabsContent>
      <TabsContent value="runs" className="space-y-4"><Card><CardHeader><CardTitle>Trigger Runs</CardTitle><p className="mt-1 text-sm text-muted-foreground">Authenticated test events and administrator dry-runs. Re-evaluation creates a new shadow audit run; no live retry exists.</p></CardHeader><CardContent>{runs.isLoading ? <Skeleton className="h-64" /> : runRows.length === 0 ? <div className="py-12 text-center"><Clock3 className="mx-auto mb-3 h-9 w-9 text-muted-foreground" /><p className="font-medium">No shadow trigger runs yet</p>{isAdmin && <Button className="mt-4" size="sm" onClick={() => setDryRunOpen(true)}><Play className="mr-2 h-4 w-4" />Run a safe evaluation</Button>}</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Time / family</th><th className="p-3">Source</th><th className="p-3">Outcome</th><th className="p-3">Proposed</th><th className="p-3">Exceptions</th><th className="p-3">Mode</th></tr></thead><tbody>{runRows.map((run) => <tr key={run.id} className="border-b last:border-0"><td className="p-3"><p className="font-medium">{titleize(run.workflowType)}</p><p className="text-xs text-muted-foreground">{auDate(run.createdAt)} · {titleize(run.triggerType)}</p></td><td className="p-3 font-mono text-xs">{run.sourceRecordNumber ?? run.sourceRecordId ?? "—"}</td><td className="p-3">{statusBadge(run.validationOutcome)}</td><td className="p-3">{run.intentCount}</td><td className="p-3">{run.exceptionCount}</td><td className="p-3">{modeBadge()}</td></tr>)}</tbody></table></div>}</CardContent></Card></TabsContent>
      <TabsContent value="exceptions" className="space-y-4"><Card><CardHeader><CardTitle>Exceptions and Review Queue</CardTitle><p className="mt-1 text-sm text-muted-foreground">Missing source data, duplicate references, non-Draft conflicts and validation failures. Resolution changes the ledger only; it never retries a live document action.</p></CardHeader><CardContent>{exceptionRows.length === 0 ? <div className="py-12 text-center"><CheckCircle2 className="mx-auto mb-3 h-9 w-9 text-emerald-500" /><p className="font-medium">No financial exceptions are awaiting review</p></div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Exception</th><th className="p-3">Workflow run</th><th className="p-3">Severity</th><th className="p-3">Status</th><th className="p-3">Review</th></tr></thead><tbody>{exceptionRows.map((exception) => <tr key={exception.id} className="border-b last:border-0"><td className="max-w-xl p-3"><p className="font-medium">{exception.title}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{exception.details}</p></td><td className="p-3 font-mono text-xs">{exception.workflowRunId ?? "—"}</td><td className="p-3">{statusBadge(exception.severity)}</td><td className="p-3">{statusBadge(exception.status)}</td><td className="p-3"><Button variant="outline" size="sm" onClick={() => setSelectedException(exception)}>Review</Button></td></tr>)}</tbody></table></div>}</CardContent></Card></TabsContent>
      <TabsContent value="schedules" className="space-y-4"><Card><CardHeader><CardTitle>Schedules</CardTitle><p className="mt-1 text-sm text-muted-foreground">Recurring For Hire and storage scheduling metadata. No target schedule is registered or enabled in shadow mode.</p></CardHeader><CardContent><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Workflow</th><th className="p-3">Intended cadence</th><th className="p-3">Task ID</th><th className="p-3">State</th><th className="p-3">Last / next run</th></tr></thead><tbody>{scheduleRows.map((schedule) => <tr key={schedule.id} className="border-b last:border-0"><td className="p-3 font-medium">{titleize(schedule.workflowType)}</td><td className="p-3 font-mono text-xs">{schedule.cronExpression ?? "Not configured"}</td><td className="p-3 font-mono text-xs">{schedule.taskUid ?? "None"}</td><td className="p-3">{schedule.enabled ? <Badge className="bg-red-100 text-red-800">Blocked</Badge> : <Badge className="border-slate-200 bg-slate-50 text-slate-700">Disabled</Badge>}</td><td className="p-3 text-xs text-muted-foreground">{auDate(schedule.lastRunAt)} / {auDate(schedule.nextRunAt)}</td></tr>)}</tbody></table></div><p className="mt-3 text-xs text-muted-foreground">The intended cadence can be documented after shadow testing, but a target schedule cannot be created or enabled from this screen.</p></CardContent></Card></TabsContent>
      {isAdmin && <TabsContent value="history-preview" className="space-y-4"><Card><CardHeader><CardTitle>Read-only Historical Import Preview</CardTitle><p className="mt-1 text-sm text-muted-foreground">Check a bounded list of known A/S/H/JD/GD/I/INV- references against Xero. This report does not list, copy, persist or alter historical documents.</p></CardHeader><CardContent className="space-y-4"><div className="space-y-1.5"><Label>References (comma or newline separated; maximum 50)</Label><Textarea value={historicalReferences} onChange={(event) => setHistoricalReferences(event.target.value)} className="min-h-28 font-mono text-xs" placeholder={"A1860\nH1860\nINV-702900"} /></div><Button onClick={() => historicalPreview.mutate({ references: historicalReferences.split(/[\n,]/).map((value) => value.trim()).filter(Boolean) })} disabled={historicalPreview.isPending || !historicalReferences.trim()}>{historicalPreview.isPending ? "Previewing…" : "Run read-only preview"}</Button>{historicalRows.length > 0 && <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="p-3">Reference</th><th className="p-3">Family</th><th className="p-3">State</th><th className="p-3">Xero summary</th><th className="p-3">Previewed</th><th className="p-3">Note</th></tr></thead><tbody>{historicalRows.map((row) => <tr key={row.reference} className="border-b last:border-0"><td className="p-3 font-mono">{row.reference}</td><td className="p-3">{titleize(row.inferredFamily)}</td><td className="p-3">{statusBadge(row.reconciliationState)}</td><td className="p-3 text-xs">{row.documentNumber ?? "—"}{row.xeroDocumentId ? <><br />ID: <span className="font-mono">{row.xeroDocumentId}</span></> : null}{row.partyName ? <><br />{row.partyName}</> : null}{row.status ? <><br />{row.status}</> : null}</td><td className="p-3 text-xs text-muted-foreground">{auDate(row.importPreviewedAt)}</td><td className="p-3 text-xs text-muted-foreground">{row.note}</td></tr>)}</tbody></table></div>}</CardContent></Card></TabsContent>}
      {isAdmin && <TabsContent value="shadow-tests" className="space-y-4"><Card><CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle className="flex items-center gap-2"><ClipboardList className="h-4 w-4" />Shadow Test Register</CardTitle><p className="mt-1 text-sm text-muted-foreground">Evidence-only comparison of named current VTiger records against AP Management proposals and GET-only Xero preflight reads.</p></div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => downloadShadowTestsCsv(shadowTestRows)} disabled={shadowTestRows.length === 0}>Export CSV</Button><Button size="sm" variant="outline" onClick={() => setBlockedTestOpen(true)}>Record needs-data</Button><Button size="sm" onClick={() => setDryRunOpen(true)}><Play className="mr-2 h-4 w-4" />New read-only test</Button></div></CardHeader><CardContent>{shadowTests.isLoading ? <Skeleton className="h-64" /> : shadowTestRows.length === 0 ? <div className="py-12 text-center"><ClipboardList className="mx-auto mb-3 h-9 w-9 text-muted-foreground" /><p className="font-medium">No shadow tests recorded</p><p className="mt-1 text-sm text-muted-foreground">Use a named current VTiger record, or record a needs-data condition without inventing source data.</p></div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Test / source</th><th className="p-3">Branch</th><th className="p-3">Tested / source refreshed</th><th className="p-3">Status</th><th className="p-3">Evidence links</th><th className="p-3">Details</th></tr></thead><tbody>{shadowTestRows.map((test) => <tr key={test.id} className="border-b last:border-0"><td className="p-3"><p className="font-medium">{titleize(test.workflowType)}</p><p className="font-mono text-xs text-muted-foreground">{test.sourceRecordNumber ?? test.sourceRecordId ?? "Named source pending"}</p></td><td className="p-3">{test.branch}</td><td className="p-3 text-xs text-muted-foreground">{auDate(test.testedAt)}<br />Refreshed: {auDate(test.sourceRefreshedAt)}</td><td className="p-3">{statusBadge(test.status)}</td><td className="p-3 text-xs">Run #{test.workflowRunId ?? "—"}<br />Intent {JSON.stringify(test.documentIntentIds ?? [])}<br />Exception {JSON.stringify(test.exceptionIds ?? [])}</td><td className="p-3"><Button size="sm" variant="outline" onClick={() => setSelectedShadowTest(test)}>Review</Button></td></tr>)}</tbody></table></div>}</CardContent></Card></TabsContent>}
      {isAdmin && <TabsContent value="configuration" className="space-y-4"><Card><CardHeader><CardTitle className="flex items-center gap-2"><Settings2 className="h-4 w-4" />Financial Automation Settings</CardTitle><p className="mt-1 text-sm text-muted-foreground">Non-secret rules, read-only integration readiness and disabled schedule intent for all ten evaluators. OAuth tokens, webhook secrets and credentials never appear in this browser.</p></CardHeader><CardContent className="space-y-4"><div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950"><ShieldCheck className="mr-1 inline h-4 w-4" /><strong>{automationSettings.data?.mode ?? "SHADOW / NO WRITE"}</strong> — server-enforced financial write lock. Xero write methods observed in validation: none.</div><div className="grid gap-3 lg:grid-cols-3"><div className={`rounded-lg border p-3 text-sm ${automationSettings.data?.vtiger.configured ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><p className="font-medium">VTiger source</p><p className="mt-1 text-xs">{automationSettings.data?.vtiger.configured ? "Configured for user-initiated GET-only source refreshes." : `Missing: ${automationSettings.data?.vtiger.missing.join(", ") ?? "checking"}`}</p><Button className="mt-3" variant="outline" size="sm" onClick={() => testVtigerConnection.mutate()} disabled={testVtigerConnection.isPending}>{testVtigerConnection.isPending ? "Testing…" : "Test read-only connection"}</Button>{testVtigerConnection.data && <p className="mt-2 text-xs">{testVtigerConnection.data.message}</p>}</div><div className={`rounded-lg border p-3 text-sm ${automationSettings.data?.xero.configured ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><p className="font-medium">Xero AP Management tenant</p><p className="mt-1 text-xs">{automationSettings.data?.xero.tenantName ?? automationSettings.data?.xero.tenantIdHint ?? "Not connected"} · token {automationSettings.data?.xero.tokenState ?? "checking"}</p><Button className="mt-3" variant="outline" size="sm" onClick={() => testXeroConnection.mutate()} disabled={testXeroConnection.isPending}>{testXeroConnection.isPending ? "Testing…" : "Test read-only connection"}</Button>{testXeroConnection.data && <p className="mt-2 text-xs">{testXeroConnection.data.message}</p>}</div><div className={`rounded-lg border p-3 text-sm ${automationSettings.data?.webhook.configured ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><p className="font-medium">Authenticated shadow webhook</p><p className="mt-1 break-all font-mono text-xs">{window.location.origin}{automationSettings.data?.webhook.endpointPath ?? "/api/financial-workflows/shadow-events"}</p><p className="mt-2 text-xs">Authentication: {automationSettings.data?.webhook.configured ? "configured (secret hidden)" : "not configured"}. Accepted modes: shadow, dry_run.</p></div></div><div className="rounded-lg border bg-muted/20 p-3 text-sm"><p className="font-medium">Disabled recurring schedule entries</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{scheduleRows.map((schedule) => <div key={schedule.workflowType} className="rounded border bg-background p-2 text-xs"><strong>{titleize(schedule.workflowType)}</strong><br />Proposed cadence: {schedule.cronExpression ?? (schedule.workflowType === "recurring_for_hire" ? automationSettings.data?.rules.defaults.recurringHireCadence : automationSettings.data?.rules.defaults.recurringStorageCadence) ?? "Not configured"}<br />State: <strong>{schedule.enabled ? "blocked" : "disabled — no task created"}</strong></div>)}</div></div><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Configuration key</Label><Input value={configKey} onChange={(event) => setConfigKey(event.target.value)} /></div><div className="space-y-1.5"><Label>Description</Label><Input value={configDescription} onChange={(event) => setConfigDescription(event.target.value)} /></div></div><div className="space-y-1.5"><Label>JSON configuration value</Label><Textarea value={configValue} onChange={(event) => setConfigValue(event.target.value)} className="min-h-32 font-mono text-xs" /></div><Button onClick={() => { try { saveConfig.mutate({ configKey, configValue: JSON.parse(configValue), description: configDescription || null }); } catch { toast.error("Configuration value must be valid JSON"); } }} disabled={saveConfig.isPending}>Save non-secret configuration</Button><div className="grid gap-3 lg:grid-cols-2"><div className="rounded-lg border"><p className="border-b p-3 text-sm font-medium">Active configuration</p>{config.data && config.data.length > 0 ? <table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase text-muted-foreground"><tr><th className="p-3">Key</th><th className="p-3">Description</th><th className="p-3">Updated</th></tr></thead><tbody>{config.data.map((item) => <tr key={item.id} className="border-b last:border-0"><td className="p-3 font-mono text-xs">{item.configKey}</td><td className="p-3">{item.description ?? "—"}</td><td className="p-3 text-xs text-muted-foreground">{auDate(item.updatedAt)}</td></tr>)}</tbody></table> : <p className="p-3 text-sm text-muted-foreground">Defaults are active; no override records saved.</p>}</div><div className="rounded-lg border"><p className="border-b p-3 text-sm font-medium">Immutable configuration audit</p>{configAudits.data?.length ? <div className="max-h-56 overflow-y-auto text-xs">{configAudits.data.map((entry) => <div key={entry.id} className="border-b p-3 last:border-0"><p className="font-mono">{entry.configKey}</p><p className="text-muted-foreground">Changed {auDate(entry.changedAt)} by user #{entry.changedBy}</p></div>)}</div> : <p className="p-3 text-sm text-muted-foreground">No configuration changes recorded yet.</p>}</div></div></CardContent></Card></TabsContent>}
    </Tabs>
    {isAdmin && <DryRunDialog open={dryRunOpen} onOpenChange={setDryRunOpen} />}
    {isAdmin && <BlockedTestDialog open={blockedTestOpen} onOpenChange={setBlockedTestOpen} />}
    <Dialog open={selectedShadowTest !== null} onOpenChange={(open) => !open && setSelectedShadowTest(null)}><DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Shadow test evidence #{selectedShadowTest?.id}</DialogTitle></DialogHeader>{selectedShadowTest && <div className="space-y-4 text-sm"><div className="flex flex-wrap gap-2">{statusBadge(selectedShadowTest.status)}<Badge variant="outline">{titleize(selectedShadowTest.workflowType)}</Badge><Badge variant="outline">{selectedShadowTest.branch}</Badge></div><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-md border p-3"><p className="font-medium">Source</p><p className="mt-1 font-mono text-xs">{selectedShadowTest.sourceRecordNumber ?? selectedShadowTest.sourceRecordId ?? "Not supplied"}</p><p className="mt-1 text-xs text-muted-foreground">Refreshed {auDate(selectedShadowTest.sourceRefreshedAt)} · tested {auDate(selectedShadowTest.testedAt)}</p></div><div className="rounded-md border p-3"><p className="font-medium">Related ledger evidence</p><p className="mt-1 text-xs">Workflow run #{selectedShadowTest.workflowRunId ?? "—"}<br />Intent IDs {JSON.stringify(selectedShadowTest.documentIntentIds ?? [])}<br />Exception IDs {JSON.stringify(selectedShadowTest.exceptionIds ?? [])}</p></div></div>{selectedShadowTest.differenceExplanation && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">{selectedShadowTest.differenceExplanation}</div>}<div className="grid gap-3 lg:grid-cols-2"><div><p className="mb-1 font-medium">Expected business-rule result</p><pre className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 text-xs">{JSON.stringify(selectedShadowTest.expectedResult ?? {}, null, 2)}</pre></div><div><p className="mb-1 font-medium">Actual AP shadow proposal and source values</p><pre className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 text-xs">{JSON.stringify(selectedShadowTest.actualResult ?? {}, null, 2)}</pre></div><div><p className="mb-1 font-medium">Field-level comparison</p><pre className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 text-xs">{JSON.stringify(selectedShadowTest.fieldComparisons ?? [], null, 2)}</pre></div><div><p className="mb-1 font-medium">GET-only Xero preflight</p><pre className="max-h-72 overflow-auto rounded-md border bg-muted/20 p-3 text-xs">{JSON.stringify(selectedShadowTest.xeroPreflight ?? {}, null, 2)}</pre></div></div></div>}</DialogContent></Dialog>
    <Dialog open={selectedException !== null} onOpenChange={(open) => !open && setSelectedException(null)}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{selectedException?.title}</DialogTitle></DialogHeader>{selectedException && <div className="space-y-4 text-sm"><div className="flex gap-2">{statusBadge(selectedException.severity)}{statusBadge(selectedException.status)}<span className="text-muted-foreground">Code: {selectedException.exceptionCode}</span></div><div className="rounded-md border bg-muted/30 p-3 whitespace-pre-wrap">{selectedException.details}</div>{selectedException.resolutionNotes && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">Resolution: {selectedException.resolutionNotes}</div>}<div><p className="mb-2 text-sm font-medium">Review history</p>{comments.isLoading ? <Skeleton className="h-12" /> : (comments.data ?? []).length === 0 ? <p className="text-xs text-muted-foreground">No comments yet.</p> : <div className="space-y-2">{comments.data?.map((entry) => <div key={entry.id} className="rounded-md bg-muted/40 p-2 text-xs"><p>{entry.comment}</p><p className="mt-1 text-muted-foreground">{auDate(entry.createdAt)}</p></div>)}</div>}</div>{isAdmin && selectedException.status === "open" && <><Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add a review comment (optional before resolving)" /><div className="flex justify-end gap-2"><Button variant="outline" disabled={!comment.trim() || addComment.isPending} onClick={() => addComment.mutate({ exceptionId: selectedException.id, comment: comment.trim() })}>Add comment</Button><Button disabled={resolve.isPending} onClick={() => resolve.mutate({ exceptionId: selectedException.id, resolutionNotes: comment.trim() || undefined })}><TicketCheck className="mr-2 h-4 w-4" />Mark resolved</Button></div></>}</div>}</DialogContent></Dialog>
  </div>;
}
