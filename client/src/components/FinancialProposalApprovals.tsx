import { useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/invoiceUtils";
import { toast } from "sonner";

type Intent = {
  id: number;
  workflowRunId: number;
  documentFamily: "purchase_order" | "customer_invoice";
  documentType: string;
  proposedAction: "create_draft" | "update_draft" | "validate_only" | "hold";
  proposedDocumentNumber: string | null;
  partyName: string | null;
  gstTreatment: string;
  total: string | number;
  validationStatus: string;
  proposalHash: string | null;
  sourceSnapshotHash: string | null;
  rulesSnapshotHash: string | null;
  xeroPreflightHash: string | null;
};

type ApprovalPreview = {
  intentId: number;
  workflowRunId: number;
  workflowType: string;
  proposedDocumentNumber: string;
  documentFamily: "purchase_order" | "customer_invoice";
  proposedAction: "create_draft" | "update_draft";
  approvalEligible: boolean;
  blockers: string[];
  preflight: {
    duplicateState: string;
    status: string | null;
    partyName: string | null;
    contactCheck: { found: boolean | null; count: number | null };
    itemChecks: Array<{ itemCode: string; found: boolean }>;
  };
};

function titleize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * The approval screen is intentionally an audit and revalidation checkpoint.
 * It cannot transmit a write; a later exact execution endpoint must consume the
 * resulting single-use approval after all separately configured live gates pass.
 */
export function FinancialProposalApprovals() {
  const utils = trpc.useUtils();
  const intentsQuery = trpc.financialOperations.documentIntents.useQuery({ limit: 300 });
  const approvalsQuery = trpc.financialOperations.executionApprovals.useQuery({ limit: 100 });
  const postActionsQuery = trpc.financialOperations.postSuccessActions.useQuery({ limit: 100 });
  const [selected, setSelected] = useState<Intent | null>(null);
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [approvalReference, setApprovalReference] = useState("");
  const [acknowledgement, setAcknowledgement] = useState("");

  const eligibleRows = useMemo(() => ((intentsQuery.data ?? []) as Intent[]).filter((intent) =>
    ["create_draft", "update_draft"].includes(intent.proposedAction)
    && ["valid", "warning"].includes(intent.validationStatus)
    && Boolean(intent.proposalHash && intent.sourceSnapshotHash && intent.rulesSnapshotHash && intent.xeroPreflightHash),
  ), [intentsQuery.data]);

  const previewMutation = trpc.financialOperations.previewExecutionApproval.useMutation({
    onSuccess: (result) => {
      setPreview(result.preview as ApprovalPreview);
      if (result.preview.approvalEligible) toast.success("Current VTiger source and Xero GET-only preflight are unchanged.");
      else toast.warning("Approval remains blocked; review the refreshed source and Xero preflight.");
    },
    onError: (error) => toast.error(error.message),
  });
  const approveMutation = trpc.financialOperations.approveExecution.useMutation({
    onSuccess: (result) => {
      toast.success(`Single-use approval ${result.approval.approvalKey} recorded. No Xero write was sent.`);
      utils.financialOperations.executionApprovals.invalidate();
      setSelected(null); setPreview(null); setApprovalReference(""); setAcknowledgement("");
    },
    onError: (error) => toast.error(error.message),
  });

  const openIntent = (intent: Intent) => {
    setSelected(intent); setPreview(null); setApprovalReference(""); setAcknowledgement("");
    previewMutation.mutate({ intentId: intent.id });
  };

  return <div className="space-y-4">
    <Card className="border-violet-200 bg-violet-50/40"><CardHeader><CardTitle className="flex items-center gap-2 text-violet-950"><ShieldCheck className="h-5 w-5" />Immutable Proposal Approval</CardTitle><p className="mt-1 text-sm text-violet-900">Approval refreshes one exact VTiger source and performs a fresh GET-only Xero duplicate/contact/item/Draft preflight. It persists the hashes being approved and expires after 20 minutes. <strong>It does not call a Xero write endpoint.</strong></p></CardHeader><CardContent className="grid gap-3 text-sm md:grid-cols-3"><div className="rounded-md border border-violet-200 bg-white/70 p-3"><strong>Source freshness</strong><p className="mt-1 text-xs text-muted-foreground">The exact VTiger record is fetched again. Changed data invalidates the proposal.</p></div><div className="rounded-md border border-violet-200 bg-white/70 p-3"><strong>Xero safeguards</strong><p className="mt-1 text-xs text-muted-foreground">Contact, item, duplicate and Draft target conditions must all be current and exact.</p></div><div className="rounded-md border border-violet-200 bg-white/70 p-3"><strong>Execution remains locked</strong><p className="mt-1 text-xs text-muted-foreground">No live route, schedule or webhook consumes this approval in the present release.</p></div></CardContent></Card>
    <Card><CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle>Eligible immutable proposals</CardTitle><p className="mt-1 text-sm text-muted-foreground">Only current valid/warning create-Draft or update-Draft proposals with persisted source, rule and preflight hashes appear here.</p></div><Button variant="outline" size="sm" onClick={() => { intentsQuery.refetch(); approvalsQuery.refetch(); }}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button></CardHeader><CardContent>{intentsQuery.isLoading ? <p className="py-8 text-sm text-muted-foreground">Loading proposals…</p> : eligibleRows.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No immutable Draft proposals are ready for an approval preview. Run a named current-source shadow test and resolve every preflight condition first.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Draft proposal</th><th className="p-3">Counterparty</th><th className="p-3">Total / GST</th><th className="p-3">Mode</th><th className="p-3">Action</th></tr></thead><tbody>{eligibleRows.map((intent) => <tr key={intent.id} className="border-b last:border-0"><td className="p-3"><p className="font-mono font-medium">{intent.proposedDocumentNumber}</p><p className="text-xs text-muted-foreground">{titleize(intent.documentType)} · run #{intent.workflowRunId}</p></td><td className="p-3">{intent.partyName ?? "Unassigned"}</td><td className="p-3">{formatCurrency(Number(intent.total))}<br /><span className="text-xs text-muted-foreground">{intent.gstTreatment}</span></td><td className="p-3"><Badge variant="outline">{titleize(intent.proposedAction)}</Badge></td><td className="p-3"><Button size="sm" onClick={() => openIntent(intent)}>Refresh & review</Button></td></tr>)}</tbody></table></div>}</CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Recorded single-use approvals</CardTitle><p className="mt-1 text-sm text-muted-foreground">Approval records are local audit evidence only until a separately approved live execution path is deployed and enabled.</p></CardHeader><CardContent>{approvalsQuery.isLoading ? <p className="py-5 text-sm text-muted-foreground">Loading approvals…</p> : (approvalsQuery.data ?? []).length === 0 ? <p className="py-5 text-sm text-muted-foreground">No financial execution approvals have been recorded.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Document</th><th className="p-3">Reference</th><th className="p-3">Status</th><th className="p-3">Approved</th></tr></thead><tbody>{approvalsQuery.data?.map((approval) => <tr key={approval.id} className="border-b last:border-0"><td className="p-3"><span className="font-mono">{approval.proposedDocumentNumber}</span><br /><span className="text-xs text-muted-foreground">{titleize(approval.workflowType)}</span></td><td className="p-3">{approval.approvalReference}</td><td className="p-3"><Badge variant="outline">{titleize(approval.status)}</Badge></td><td className="p-3 text-xs text-muted-foreground">{new Date(approval.approvedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}</td></tr>)}</tbody></table></div>}</CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Post-success action ledger</CardTitle><p className="mt-1 text-sm text-muted-foreground">After a future verified Xero Draft read-back, the system records only an internal pending VTiger note/task/end-date action. It does not update VTiger automatically in this release.</p></CardHeader><CardContent>{postActionsQuery.isLoading ? <p className="py-5 text-sm text-muted-foreground">Loading post-success actions…</p> : (postActionsQuery.data ?? []).length === 0 ? <p className="py-5 text-sm text-muted-foreground">No post-success actions are pending.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Execution</th><th className="p-3">Source</th><th className="p-3">Action</th><th className="p-3">State</th></tr></thead><tbody>{postActionsQuery.data?.map((action) => <tr key={action.id} className="border-b last:border-0"><td className="p-3">#{action.executionId}</td><td className="p-3 font-mono text-xs">{action.sourceRecordId}</td><td className="p-3">{titleize(action.actionType)}</td><td className="p-3"><Badge variant="outline">{titleize(action.status)}</Badge></td></tr>)}</tbody></table></div>}</CardContent></Card>
    <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Approve an immutable Draft proposal</DialogTitle></DialogHeader><div className="space-y-4 text-sm">{previewMutation.isPending ? <p className="py-6 text-muted-foreground">Refreshing the exact VTiger source and Xero GET-only preflight…</p> : preview ? <><div className={preview.approvalEligible ? "rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-950" : "rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950"}>{preview.approvalEligible ? <CheckCircle2 className="mr-1 inline h-4 w-4" /> : <TriangleAlert className="mr-1 inline h-4 w-4" />}<strong>{preview.approvalEligible ? "Fresh proposal is eligible for local approval" : "Fresh proposal is blocked"}</strong><p className="mt-1 text-xs">{preview.proposedDocumentNumber} · {titleize(preview.proposedAction)} · {preview.preflight.duplicateState} duplicate state · contact {preview.preflight.contactCheck.found ? "exact" : "not exact"}</p></div>{preview.blockers.length > 0 && <ul className="list-disc space-y-1 pl-5 text-amber-900">{preview.blockers.map((item) => <li key={item}>{item}</li>)}</ul>}<div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2"><div><p className="font-medium">Exact Xero state</p><p className="mt-1 text-xs">Target: {preview.preflight.status ?? "new Draft"} · existing ID: {preview.preflight.duplicateState === "found" ? "verified" : "none"}</p></div><div><p className="font-medium">Required items</p><p className="mt-1 text-xs">{preview.preflight.itemChecks.length === 0 ? "No item preflight data" : preview.preflight.itemChecks.map((item) => `${item.itemCode}: ${item.found ? "found" : "missing"}`).join(", ")}</p></div></div><div className="space-y-1.5"><Label>Approval reference</Label><Input value={approvalReference} onChange={(event) => setApprovalReference(event.target.value)} placeholder="e.g. FIN-APP-2026-001" /></div><div className="space-y-1.5"><Label>Mandatory acknowledgement</Label><Textarea value={acknowledgement} onChange={(event) => setAcknowledgement(event.target.value)} className="min-h-24" placeholder="I approve only this named Draft proposal, its counterparty, values, GST, exact source snapshot and exact Xero preflight. I understand approval alone does not write to Xero." /></div></> : <p className="text-red-700">No current approval preview was returned.</p>}</div><DialogFooter><Button variant="outline" onClick={() => setSelected(null)}>Cancel</Button><Button disabled={!preview?.approvalEligible || approvalReference.trim().length < 3 || acknowledgement.trim().length < 20 || approveMutation.isPending} onClick={() => selected && approveMutation.mutate({ intentId: selected.id, approvalReference: approvalReference.trim(), acknowledgement: acknowledgement.trim() })}>{approveMutation.isPending ? "Recording…" : "Record local approval"}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
