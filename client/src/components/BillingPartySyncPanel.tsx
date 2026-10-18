import { useState } from "react";
import { BusinessText } from "@/components/BusinessReferenceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown, fallback = "not recorded") => typeof value === "string" && value ? value : fallback;

/** Read-only inspector. No sync/create/retry/activation mutation is exposed. */
export function BillingPartySyncPanel() {
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState("");
  const readiness = trpc.financialOperations.billingPartySyncReadiness.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const events = trpc.financialOperations.billingPartySyncEvents.useQuery({ limit: 25 }, { retry: false, refetchOnWindowFocus: false });
  const preview = trpc.financialOperations.previewBillingPartySync.useQuery({ exactDeal: selected }, { enabled: Boolean(selected), retry: false, refetchOnWindowFocus: false, staleTime: 0 });
  const ready = record(readiness.data);
  const data = record(preview.data);
  const source = record(data.source);
  const plan = record(data.contactPlan);
  const invoice = record(data.invoice);
  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">Latest Deal billing party</CardTitle>
        <Badge variant="outline">{ready.writerEnabled === true ? "Independent Draft-only sync released" : "Sync not activated"}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">Organisation on the current Deal takes priority; otherwise use its current contact. Name/email matching and missing-contact creation follow the existing Xero contact protocol.</p>
    </CardHeader>
    <CardContent className="space-y-4 text-sm">
      <p className="rounded-md bg-muted/50 p-3">Qualifying Deposit and main-finalisation events can separately synchronize only the billing ContactID on an AP-owned main Draft. Quote descriptions, item codes, quantities, amounts, GST, dates and reference are preserved. Authorised/paid invoices and uncertain prior writes cannot be overridden. This inspector never creates a contact or changes an invoice.</p>
      {readiness.error ? <p role="alert" className="text-red-700">Billing-sync readiness unavailable; treat it as disabled.</p> : ready.releaseHoldReason ? <p className="text-amber-900"><BusinessText value={label(ready.releaseHoldReason)} /></p> : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input aria-label="Exact billing-party Deal" className="font-mono" placeholder="D702941" value={input} onChange={event => { setInput(event.target.value); setSelected(""); }} />
        <Button variant="outline" disabled={!/^(D\d{1,12}|\d+x\d{1,12})$/i.test(input.trim()) || preview.isFetching} onClick={() => { const next = input.trim().replace(/^d/i, "D"); if (selected === next) void preview.refetch(); else setSelected(next); }}>{preview.isFetching ? "Reading billing evidence…" : "Preview billing party — no writes"}</Button>
      </div>
      {selected && preview.error ? <p role="alert" className="text-red-700"><BusinessText value={preview.error.message} /></p> : null}
      {selected && preview.data ? <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap justify-between gap-2"><p className="font-medium"><BusinessText value={label(data.dealNumber, selected)} /></p><Badge variant="outline"><BusinessText value={label(data.state, "Evidence only")} /> · no writes</Badge></div>
        <div className="grid gap-4 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Current invoice billing party</p><p><BusinessText value={label(invoice.contactName, "See exact invoice evidence")} /></p><p className="break-all font-mono text-xs"><BusinessText value={label(invoice.contactId, "No exact main invoice")} /></p><p className="text-xs text-muted-foreground"><BusinessText value={label(invoice.invoiceNumber, "Not found")} /> · <BusinessText value={label(invoice.status)} /></p></div><div><p className="text-xs text-muted-foreground">Latest Deal billing party</p><p><BusinessText value={label(source.name, label(plan.contactName, "Unresolved"))} /> · <BusinessText value={label(source.billingKind, "unresolved")} /></p><p className="break-all font-mono text-xs"><BusinessText value={label(plan.contactId, label(data.contactId, "Contact not yet bound"))} /></p></div></div>
        {data.holdReason ? <p className="rounded-md bg-amber-50 p-3 text-amber-900"><BusinessText value={label(data.holdReason)} /></p> : null}
        <details><summary className="cursor-pointer text-xs">Current source, matching decision and preservation evidence</summary><pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs"><BusinessText value={JSON.stringify(preview.data, null, 2)} /></pre></details>
      </div> : null}
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-medium">Billing-party synchronization audit</summary>
        {events.isLoading ? <p className="mt-3 text-muted-foreground">Loading audit…</p> : events.error ? <p role="alert" className="mt-3 text-red-700">Billing-sync audit unavailable; no outcome can be assumed.</p> : !events.data?.length ? <p className="mt-3 text-muted-foreground">No billing-party synchronization event recorded.</p> : <div className="mt-3 space-y-3">{events.data.map((event, index) => {
          const row = record(event);
          return <div key={String(row.id ?? index)} className="rounded-md bg-muted/30 p-3"><div className="flex flex-wrap justify-between gap-2"><p className="font-mono"><BusinessText value={label(row.dealNumber)} /> · <BusinessText value={label(row.invoiceNumber)} /></p><Badge variant="outline"><BusinessText value={label(row.status).replaceAll("_", " ")} /></Badge></div>{row.holdReason ? <p className="mt-2 text-xs text-amber-900"><BusinessText value={label(row.holdReason)} /></p> : null}<details className="mt-2 text-xs"><summary className="cursor-pointer">Immutable change / read-back evidence</summary><pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2"><BusinessText value={JSON.stringify(event, null, 2)} /></pre></details></div>;
        })}</div>}
      </details>
    </CardContent>
  </Card>;
}
