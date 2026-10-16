import { BusinessText } from "@/components/BusinessReferenceDisplay";
import { useState } from "react";
import { AlertCircle, FileSearch, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";

const money = (value: number | null | undefined) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value ?? 0));

/** Admin-only, GET-only Deal → Quote → Service evidence preview. */
export function MainCustomerInvoicePreview() {
  const [deal, setDeal] = useState("");
  const [result, setResult] = useState<any>(null);
  const preview = trpc.financialOperations.previewMainCustomerInvoice.useMutation({ onSuccess: setResult });
  const canPreview = /^(D\d+|\d+x\d+)$/i.test(deal.trim());
  const document = result?.preview?.document;
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileSearch className="h-4 w-4" />Current Deal / Quote preflight</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <p className="text-sm text-muted-foreground">Enter one exact Deal number or VTiger ID. This performs authenticated VTiger and Xero <strong>GET-only</strong> evidence checks and records a local preview/hold. It cannot create an invoice.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={deal} onChange={(event) => { setDeal(event.target.value); setResult(null); }} placeholder="D702877" className="font-mono" />
        <Button disabled={!canPreview || preview.isPending} onClick={() => preview.mutate({ exactDeal: deal.trim().toUpperCase() })}>
          {preview.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Check current evidence
        </Button>
      </div>
      {preview.error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"><BusinessText value={preview.error.message} /></p> : null}
      {result ? <div className="rounded-lg border p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium"><BusinessText value={result.facts?.dealNumber || result.facts?.dealId} /> · <BusinessText value={result.facts?.quoteNumber || "Quote pending"} /></p><p className="text-xs text-muted-foreground"><BusinessText value={result.facts?.customerKind || "customer"} />: <BusinessText value={result.facts?.customerName || "not resolved"} /></p></div><Badge variant={result.state === "previewed" ? "default" : "destructive"}><BusinessText value={result.state === "previewed" ? "Preview ready" : "Held"} /></Badge></div>
        {result.holdReason ? <p className="mt-3 flex gap-2 rounded-md bg-amber-50 p-3 text-amber-900"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><BusinessText value={result.holdReason} /></p> : null}
        {result.customerContactPlan ? <div className="mt-4 rounded-md bg-muted/50 p-3 text-xs"><p className="font-medium">Customer contact decision · <BusinessText value={String(result.customerContactPlan.outcome).replaceAll("_", " ")} /></p><p className="mt-1">Billing kind <BusinessText value={result.customerContactPlan.source?.billingKind ?? "unresolved"} /> · lookup <BusinessText value={Array.isArray(result.customerContactPlan.lookupOrder) ? result.customerContactPlan.lookupOrder.join(" → ") : "not recorded"} /></p><p className="mt-1 text-muted-foreground">Resolved party <BusinessText value={result.customerContactPlan.source?.name ?? "unavailable"} /> · source email <BusinessText value={result.customerContactPlan.source?.email ? "available" : "not available"} /> · <BusinessText value={result.customerContactPlan.status === "would_create" ? "Preview only — no Xero Contact will be created." : result.customerContactPlan.contactId ? `Immutable ContactID ${result.customerContactPlan.contactId}` : "No ContactID bound."} /></p></div> : null}
        {document ? <div className="mt-4 grid gap-3 md:grid-cols-3"><div><p className="text-xs uppercase text-muted-foreground">Draft reference</p><p className="font-mono font-medium"><BusinessText value={document.proposedDocumentNumber} /></p></div><div><p className="text-xs uppercase text-muted-foreground">Proposed total</p><p className="font-medium"><BusinessText value={money(document.total)} /> incl. GST</p></div><div><p className="text-xs uppercase text-muted-foreground">Xero evidence</p><p><BusinessText value={result.preflight?.duplicateState === "not_found" ? "No exact invoice found" : result.preflight?.duplicateState ?? "Pending"} /></p></div></div> : null}
        {document?.lineItems?.length ? <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b text-muted-foreground"><tr><th className="p-2">Service</th><th className="p-2">Qty</th><th className="p-2">Unit ex GST</th><th className="p-2">Account</th></tr></thead><tbody>{document.lineItems.map((line: any, index: number) => <tr className="border-b last:border-0" key={`${line.description}-${index}`}><td className="p-2"><BusinessText value={line.description} /></td><td className="p-2"><BusinessText value={line.quantity} /></td><td className="p-2"><BusinessText value={money(line.unitAmount)} /></td><td className="p-2 font-mono"><BusinessText value={line.accountCode} /></td></tr>)}</tbody></table></div> : null}
      </div> : null}
    </CardContent>
  </Card>;
}
