import { useState } from "react";
import { AlertTriangle, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const money = (amount: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(amount);
const normalizeDeal = (value: string) => value.trim().replace(/^d/, "D").replace(/^5X/, "5x");

export function StorageLivePreview() {
  const [exactDeal, setExactDeal] = useState("");
  const [requestedDeal, setRequestedDeal] = useState("");
  const preview = trpc.financialOperations.previewInitialStorage.useMutation();
  const result = requestedDeal === normalizeDeal(exactDeal) ? preview.data : null;
  return <Card className="border-sky-200">
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4" />Exact Deal release preview</CardTitle>
      <p className="text-sm text-muted-foreground">Administrator-invoked VTiger and CONTAINERZONE Xero reads only. No suffix is reserved, approval granted, webhook triggered or Draft created.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); const named = normalizeDeal(exactDeal); setRequestedDeal(named); void preview.mutateAsync({ exactDeal: named }).catch(() => undefined); }}>
        <label className="min-w-48 flex-1 text-sm font-medium">Exact Deal number or VTiger ID
          <Input className="mt-1 font-mono" placeholder="D702885 or 5x484050" value={exactDeal} onChange={(event) => { setExactDeal(event.target.value); preview.reset(); }} maxLength={16} autoComplete="off" />
        </label>
        <Button disabled={preview.isPending || !/^(?:D\d{1,12}|5x\d{1,12})$/.test(normalizeDeal(exactDeal))} type="submit" variant="outline">{preview.isPending ? "Checking…" : "Preview only"}</Button>
      </form>
      {preview.error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{preview.error.message}</p>}
      {result && <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><strong className="font-mono">{result.dealNumber}</strong><span className="text-sm text-muted-foreground">{result.location} · {result.containerNumber} · {result.containerType}</span>
          <Badge className={result.eligibleForApproval ? "border-sky-200 bg-sky-50 text-sky-800" : "border-amber-200 bg-amber-50 text-amber-900"}>{result.eligibleForApproval ? "Preflight clear — not approved" : "Held for review"}</Badge></div>
        <p className="text-sm">Customer <strong>{result.customer}</strong> · Driver <strong>{result.driver}</strong> · {result.period.start}–{result.period.end} ({result.period.days} days) · suffix {result.suffix}</p>
        {result.reasons.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="mb-1 flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />No release approval</p><ul className="list-disc space-y-1 pl-5">{result.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b text-xs uppercase text-muted-foreground"><tr><th className="p-2">Draft / account</th><th className="p-2">Contact / item</th><th className="p-2">Date / due</th><th className="p-2 text-right">Ex GST / GST / total</th><th className="p-2">Exact Xero number</th></tr></thead><tbody>{result.documents.map(doc => <tr key={doc.number} className="border-b last:border-0"><td className="p-2"><span className="font-mono font-semibold">{doc.number}</span><br /><span className="text-xs text-muted-foreground">{doc.type} · {doc.accountCode}</span><br /><span className="text-xs text-muted-foreground">{doc.lineDescription}</span></td><td className="p-2">{doc.party}<br /><span className="text-xs text-muted-foreground">{doc.contactId ? "Contact matched" : "Contact missing"}{doc.itemCode ? ` · ${doc.itemCode}` : ""}</span></td><td className="p-2 text-xs">{doc.issueDate}<br />{doc.dueDate ?? "—"}</td><td className="p-2 text-right tabular-nums text-xs">{money(doc.subtotal)} / {money(doc.taxAmount)} / <strong>{money(doc.total)}</strong></td><td className="p-2 text-xs">{doc.xeroNumberState}{doc.xeroStatus ? ` · ${doc.xeroStatus}` : ""}{doc.xeroDocumentId ? <div className="break-all font-mono text-muted-foreground">{doc.xeroDocumentId}</div> : null}</td></tr>)}</tbody></table></div>
        <details className="rounded-lg border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Evidence fingerprints (for a future named approval)</summary><div className="mt-2 space-y-1 break-all font-mono"><p>Source: {result.sourceHash}</p><p>Rules and proposed documents: {result.documentsHash}</p><p>Xero preflight: {result.preflightHash}</p></div></details>
        <p className="text-xs text-muted-foreground">The preview can become stale at any time. A writer must revalidate VTiger, Xero and hashes after Operations handover; this screen cannot approve or start a write.</p>
      </div>}
    </CardContent>
  </Card>;
}
