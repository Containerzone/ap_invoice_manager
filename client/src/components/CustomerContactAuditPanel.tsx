import { BusinessText } from "@/components/BusinessReferenceDisplay";
import { ContactRound, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { formatSydneyDateTime } from "@/lib/dateFormat";

function displayOutcome(value: string | null) {
  return (value ?? "legacy contact record").replaceAll("_", " ");
}

export function CustomerContactAuditPanel() {
  const events = trpc.financialOperations.customerContactEvents.useQuery({ limit: 50 });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ContactRound className="h-4 w-4" />Customer contact resolution audit</CardTitle>
        <p className="text-sm text-muted-foreground">Cross-family evidence for exact VTiger customer resolution and Xero Contact decisions. It never exposes credentials, webhook secrets or raw Xero responses.</p>
      </CardHeader>
      <CardContent>
        {events.isLoading ? <p className="text-sm text-muted-foreground">Loading customer-contact decisions…</p> : null}
        {events.error ? <p role="alert" className="text-sm text-red-700">Customer-contact audit evidence could not be loaded.</p> : null}
        {!events.isLoading && !events.error && !events.data?.length ? <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No automatic customer-contact decision has been recorded. Read-only previews remain non-persistent.</p> : null}
        {events.data?.length ? <div className="space-y-3">{events.data.map(event => {
          const source = event.sourceSummary as any;
          const lookup = event.lookupSummary as any;
          return <div key={event.id} className="rounded-lg border p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium"><BusinessText value={source?.dealId ?? "Legacy contact decision"} /> · <BusinessText value={source?.billingKind ?? "customer"} /></p><p className="mt-1 text-xs text-muted-foreground">Family <BusinessText value={event.workflowFamily ?? "Main/Deposit legacy"} /> · event #<BusinessText value={event.id} /></p></div><Badge variant={event.status === "created" || event.status === "matched" ? "outline" : "destructive"}><BusinessText value={displayOutcome(event.outcome)} /></Badge></div>
            <div className="mt-3 grid gap-3 md:grid-cols-3"><div><p className="text-xs text-muted-foreground">Resolved billing party</p><p><BusinessText value={source?.organisationName ?? source?.contactName ?? "not retained in legacy evidence"} /></p><p className="mt-1 text-xs text-muted-foreground">Account <BusinessText value={source?.linkedAccountId ?? "—"} /> · Contact <BusinessText value={source?.linkedContactId ?? "—"} /></p></div><div><p className="text-xs text-muted-foreground">Xero lookup</p><p><BusinessText value={Array.isArray(lookup?.lookupOrder) ? lookup.lookupOrder.join(" → ") : "legacy exact-match evidence"} /></p><p className="mt-1 text-xs text-muted-foreground">Name matches <BusinessText value={lookup?.nameMatchCount ?? "—"} /> · email matches <BusinessText value={lookup?.emailMatchCount ?? "—"} /></p></div><div><p className="text-xs text-muted-foreground">Immutable outcome</p><p className="break-all font-mono text-xs"><BusinessText value={event.xeroContactId ?? "No ContactID bound"} /></p><p className="mt-1 text-xs text-muted-foreground"><BusinessText value={lookup?.includeEmailOnCreate ? "Email permitted on create" : "No email added on create"} /></p></div></div>
            {Array.isArray(source?.sourceFieldsUsed) ? <p className="mt-3 text-xs text-muted-foreground">VTiger source fields: <BusinessText value={source.sourceFieldsUsed.join(", ")} /></p> : null}
            {event.holdReason ? <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-900"><BusinessText value={event.holdReason} /></p> : null}
            <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" />Updated <BusinessText value={formatSydneyDateTime(event.updatedAt)} /></p>
          </div>;
        })}</div> : null}
      </CardContent>
    </Card>
  );
}
