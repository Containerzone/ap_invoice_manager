import { useState } from "react";
import { AlertCircle, Eye, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const money = (value: unknown) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(value ?? 0));

export function AssetPurchasePoPreview() {
  const [control, setControl] = useState("");
  const [lastRequested, setLastRequested] = useState("");
  const preview = trpc.financialOperations.previewAssetPurchase.useMutation({
    onSuccess: (_, input) => setLastRequested(input.exactContainerControl.trim().toUpperCase()),
    onError: (error) => toast.error(error.message),
  });
  const result = preview.data;
  const document = result?.preview.document;

  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base"><Eye className="h-4 w-4" />Current Asset PO preview</CardTitle>
      <p className="text-sm text-muted-foreground">Enter one exact Container Control number (for example <code>C1860</code>) or VTiger ID. AP re-reads the current source and makes GET-only Xero checks; this control cannot create a Draft.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); const value = control.trim(); if (!value) return toast.error("Enter an exact Container Control number or VTiger ID."); preview.mutate({ exactContainerControl: value }); }}>
        <Input value={control} onChange={(event) => setControl(event.target.value)} placeholder="C1860 or 24x123" className="max-w-xs font-mono" aria-label="Exact Container Control" />
        <Button type="submit" disabled={preview.isPending}><Search className="mr-2 h-4 w-4" />{preview.isPending ? "Checking current records…" : "Preview Asset PO"}</Button>
      </form>
      {preview.isPending && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Retrieving the current Container Control, Supplier and Xero evidence…</p>}
      {result && <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-medium">{result.facts.controlNumber || lastRequested}</p><p className="text-xs text-muted-foreground">{result.facts.containerNumber} · {result.facts.containerType || "Type missing"} · Supplier: {result.facts.supplierName || "missing"}</p></div><Badge variant="outline" className={result.state === "previewed" ? "border-sky-200 bg-sky-50 text-sky-800" : "border-amber-200 bg-amber-50 text-amber-900"}>{result.state === "previewed" ? "Ready for review — no Draft created" : "Held"}</Badge></div>
        {document ? <div className="grid gap-3 rounded-md bg-background p-3 text-sm md:grid-cols-3"><div><p className="text-xs uppercase text-muted-foreground">Draft PO</p><p className="font-mono font-medium">{document.proposedDocumentNumber}</p><p className="text-xs text-muted-foreground">{document.partyName}</p></div><div><p className="text-xs uppercase text-muted-foreground">Amount</p><p className="font-medium">{money(document.total)} incl. GST</p><p className="text-xs text-muted-foreground">{money(document.subtotal)} + {money(document.taxAmount)} GST</p></div><div><p className="text-xs uppercase text-muted-foreground">Line</p><p className="text-xs">{document.lineItems[0]?.itemCode} · account {document.lineItems[0]?.accountCode}</p><p className="mt-1 text-xs text-muted-foreground">{document.lineItems[0]?.description}</p></div></div> : null}
        {result.holdReason ? <p className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><AlertCircle className="h-4 w-4 shrink-0" />{result.holdReason}</p> : null}
        <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2"><p>Source hash: <code>{result.sourceSnapshotHash.slice(0, 16)}…</code></p><p>Xero preflight: <code>{result.xeroPreflightHash ? `${result.xeroPreflightHash.slice(0, 16)}…` : "not available"}</code></p></div>
      </div>}
    </CardContent>
  </Card>;
}
