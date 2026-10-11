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
        <Input value={deal} onChange={(event) => { setDeal(event.target.value); setResult(null); }} placeholder="D702877 or 5x12345" className="font-mono" />
        <Button disabled={!canPreview || preview.isPending} onClick={() => preview.mutate({ exactDeal: deal.trim().toUpperCase() })}>
          {preview.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Check current evidence
        </Button>
      </div>
      {preview.error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{preview.error.message}</p> : null}
      {result ? <div className="rounded-lg border p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{result.facts?.dealNumber || result.facts?.dealId} · {result.facts?.quoteNumber || "Quote pending"}</p><p className="text-xs text-muted-foreground">{result.facts?.customerKind || "customer"}: {result.facts?.customerName || "not resolved"}</p></div><Badge variant={result.state === "previewed" ? "default" : "destructive"}>{result.state === "previewed" ? "Preview ready" : "Held"}</Badge></div>
        {result.holdReason ? <p className="mt-3 flex gap-2 rounded-md bg-amber-50 p-3 text-amber-900"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{result.holdReason}</p> : null}
        {document ? <div className="mt-4 grid gap-3 md:grid-cols-3"><div><p className="text-xs uppercase text-muted-foreground">Draft reference</p><p className="font-mono font-medium">{document.proposedDocumentNumber}</p></div><div><p className="text-xs uppercase text-muted-foreground">Proposed total</p><p className="font-medium">{money(document.total)} incl. GST</p></div><div><p className="text-xs uppercase text-muted-foreground">Xero evidence</p><p>{result.preflight?.duplicateState === "not_found" ? "No exact invoice found" : result.preflight?.duplicateState ?? "Pending"}</p></div></div> : null}
        {document?.lineItems?.length ? <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="border-b text-muted-foreground"><tr><th className="p-2">Service</th><th className="p-2">Qty</th><th className="p-2">Unit ex GST</th><th className="p-2">Account</th></tr></thead><tbody>{document.lineItems.map((line: any, index: number) => <tr className="border-b last:border-0" key={`${line.description}-${index}`}><td className="p-2">{line.description}</td><td className="p-2">{line.quantity}</td><td className="p-2">{money(line.unitAmount)}</td><td className="p-2 font-mono">{line.accountCode}</td></tr>)}</tbody></table></div> : null}
      </div> : null}
    </CardContent>
  </Card>;
}
