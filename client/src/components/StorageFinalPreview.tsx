import { BusinessText } from "@/components/BusinessReferenceDisplay";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function StorageFinalPreview() {
  const [deal, setDeal] = useState("");
  const [location, setLocation] = useState<"origin" | "destination">("destination");
  const preview = trpc.financialOperations.previewStorageFinalisation.useMutation();
  const [requested, setRequested] = useState("");
  const result = requested === `${deal}:${location}` ? preview.data : null;
  return <Card><CardHeader><CardTitle className="text-base">Finalisation reference check</CardTitle><p className="text-sm text-muted-foreground">Reads an existing Deal and exact Xero references. Does not import history, reserve a period or amend documents.</p></CardHeader><CardContent>
    <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); setRequested(`${deal}:${location}`); preview.mutate({ exactDeal: deal, location }); }}>
      <Input aria-label="Exact finalisation Deal" className="max-w-64" value={deal} placeholder="D702885" onChange={e => { setDeal(e.target.value.trim().replace(/^d/, "D")); preview.reset(); }} />
      <select className="rounded-md border bg-background px-3 text-sm" aria-label="Storage location" value={location} onChange={e => { setLocation(e.target.value as "origin" | "destination"); preview.reset(); }}><option value="origin">Origin</option><option value="destination">Destination</option></select>
      <Button variant="outline" disabled={preview.isPending || !/^(D\d+|5x\d+)$/.test(deal)}><BusinessText value={preview.isPending ? "Checking…" : "Reference only"} /></Button>
    </form>
    {preview.error && <p role="alert" className="mt-3 text-sm text-red-700"><BusinessText value={preview.error.message} /></p>}
    {result && <div className="mt-4 space-y-2 text-sm"><p><strong><BusinessText value={result.dealNumber} /></strong> · <BusinessText value={result.location} /> · <BusinessText value={result.period.start} />–<BusinessText value={result.period.end} /> (<BusinessText value={result.period.days} /> inclusive days)</p>{result.documents.map(doc => <p key={doc.number} className="rounded-md border p-3"><strong className="font-mono"><BusinessText value={doc.number} /></strong> · $<BusinessText value={doc.subtotal.toFixed(2)} /> ex GST + $<BusinessText value={doc.tax.toFixed(2)} /> GST = $<BusinessText value={doc.total.toFixed(2)} /> · Xero <BusinessText value={doc.xeroState} /> <BusinessText value={doc.xeroStatus ?? ""} /></p>)}<p className="text-xs text-muted-foreground">Reference only. Existing/ambiguous/non-Draft documents are not permission to execute.</p></div>}
  </CardContent></Card>;
}
