import { AlertTriangle, ArrowRight, CheckCircle2, LockKeyhole, Warehouse, Webhook } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FinancialStorageDrafts } from "@/components/FinancialStorageDrafts";
import { StorageLivePreview } from "@/components/StorageLivePreview";
import { trpc } from "@/lib/trpc";

const handoverSteps = [
  { title: "Publish and verify the AP receiver", detail: "Deploy this checkpoint, verify the published route rejects unauthenticated calls, and use the exact Deal preview for GET-only evidence. Do not send an authenticated stage event for an old Deal as a probe; even a held event can reserve an AP suffix." },
  { title: "Agree a named, unbilled Origin or Destination pilot", detail: "Refresh the VTiger Deal and Xero tenant, contacts, JD 20/JD 40 items, accounts and exact invoice/PO numbers. Record an expiring three-document approval with prices, GST, source hash, preflight hash and reviewer." },
  { title: "Handover the shared Operations writer", detail: "With ContainerZone Operations / IT, schedule a maintenance window. Pause the shared VTiger storage action pointing to the Operations /api/webhooks/vtiger-storage endpoint, drain in-flight work and retain the old configuration for rollback. This action covers BOTH Origin and Destination." },
  { title: "Run one controlled AP pilot without redirecting all Deals", detail: "During the agreed window, submit the one approved Deal event directly to the published AP receiver with its private header. Arm only the isolated, approved storage pilot gate; keep the shared VTiger destination paused, not broadly redirected. Recheck exact Xero evidence immediately before execution." },
  { title: "Verify; restore legacy until the wider release is ready", detail: "Read back the exact customer Draft and two purchase-order Draft IDs and totals, check AP event receipts and queue the VTiger note separately. Reconcile failures, disarm AP and restore the old action if the broader release is not approved. Automatic all-Deal billing needs a separately reviewed standing policy and a second coordinated redirect." },
];

export default function StorageAutomation() {
  const readiness = trpc.financialOperations.initialStorageReadiness.useQuery();
  const status = readiness.data;
  return <div className="mx-auto max-w-6xl space-y-6 pb-12">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground"><Warehouse className="h-4 w-4" />Storage automation</div>
        <h1 className="text-2xl font-semibold tracking-tight">VTiger → Xero Storage</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Loaded-container Origin and Destination stage events, three Xero Draft receipts, and a controlled Operations handover. Separate from the other Financial Operations families.</p>
      </div>
      <Badge className="border-amber-200 bg-amber-50 text-amber-900">Automatic cutover not verified</Badge>
    </div>

    <div className="grid gap-3 md:grid-cols-3">
      <Card><CardContent className="p-4"><div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Webhook className="h-4 w-4 text-sky-600" />AP webhook receiver</div>
        <Badge className={status?.authenticationConfigured ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}>{readiness.isLoading ? "Checking" : status?.authenticationConfigured ? "Private header configured" : "Private header missing"}</Badge>
        <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{status?.endpointPath ?? "/api/webhooks/vtiger/deal-storage"}</p>
        <p className="mt-2 text-xs text-muted-foreground"><code>record_id</code> = VTiger Deal ID; <code>event</code> = <code>deal.storage-stage-changed</code>; authenticated with <code>X-Financial-Webhook-Secret</code>. The value is never displayed.</p>
        <p className="mt-2 text-xs text-muted-foreground">Configuration here does not prove a VTiger workflow points to AP.</p></CardContent></Card>
      <Card><CardContent className="p-4"><div className="mb-2 flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="h-4 w-4 text-amber-600" />Storage Draft writer</div>
        <Badge className="border-amber-200 bg-amber-50 text-amber-900">{readiness.isLoading ? "Checking" : status?.namedPilotWriteGateArmed ? "Pilot gate armed; named approval still required" : "Not armed"}</Badge>
        <p className="mt-2 text-xs text-muted-foreground">The approved D702885 invoice-only test was separate. It did not enable automatic three-document creation.</p></CardContent></Card>
      <Card><CardContent className="p-4"><div className="mb-2 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-600" />Operations writer handover</div>
        <Badge className="border-amber-200 bg-amber-50 text-amber-900">Not verified in AP</Badge>
        <p className="mt-2 text-xs text-muted-foreground">Shared Origin/Destination legacy action; coordinate with Operations / IT. No pause, redirect, schedule or VTiger record change occurs from this page.</p></CardContent></Card>
    </div>
    {readiness.error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Storage readiness could not be loaded; do not infer that the receiver or writer is enabled.</p>}

    <Card className="border-sky-200"><CardHeader><CardTitle className="text-base">Initial loaded-container flow</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm md:grid-cols-3">
      <div className="rounded-lg border p-3"><strong>1 · VTiger Deal</strong><p className="mt-1 text-muted-foreground">Origin <code>4 STORAGE at ORIGIN</code> or Destination <code>11 STORAGE at DEST</code>; AP fetches current source facts.</p></div>
      <div className="rounded-lg border p-3"><strong>2 · Exact checks</strong><p className="mt-1 text-muted-foreground">Sydney Date In, source stage, customer/vendor, account, JD item and exact Xero number preflight. Existing/ambiguous records are held.</p></div>
      <div className="rounded-lg border p-3"><strong>3 · Draft receipts</strong><p className="mt-1 text-muted-foreground">Customer ACCREC account 200; driver JD PO account 310; storage GD PO account 311. Each Draft must be read back by ID.</p></div>
    </CardContent></Card>

    <StorageLivePreview />
    <FinancialStorageDrafts />

    <Card><CardHeader><CardTitle className="text-base">Controlled cutover checklist</CardTitle><p className="text-sm text-muted-foreground">Preparation only. None of these external actions is performed by opening this page.</p></CardHeader>
      <CardContent><ol className="space-y-4">{handoverSteps.map((step, index) => <li key={step.title} className="flex gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">{index + 1}</span><div><p className="font-medium">{step.title}</p><p className="mt-1 text-sm text-muted-foreground">{step.detail}</p></div></li>)}</ol>
        <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>Do not switch the shared action yet.</strong> The legacy writer still handles both stages and the AP automatic writer is locked. A new test Deal now could trigger the old Operations writer. Recurring storage and finalisation are separate workflows, not part of this initial-stage handover.</span></div>
      </CardContent></Card>
    <p className="flex items-center gap-2 text-xs text-muted-foreground"><CheckCircle2 className="h-4 w-4" />This page is read-only; it cannot fire VTiger events, alter Operations, or create Xero documents.<ArrowRight className="h-3 w-3" /></p>
  </div>;
}
