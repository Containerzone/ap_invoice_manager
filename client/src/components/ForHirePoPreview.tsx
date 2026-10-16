import { BusinessText } from "@/components/BusinessReferenceDisplay";
import { useState } from "react";
import { AlertTriangle, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const money = (value: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(value);
const normalize = (value: string) => value.trim().replace(/^c/i, "C").replace(/^([0-9]+)X/i, "$1x");

export function ForHirePoPreview() {
  const [control, setControl] = useState("");
  const [requested, setRequested] = useState("");
  const [lifecycle, setLifecycle] = useState<"initial" | "recurring">("initial");
  const preview = trpc.financialOperations.previewForHire.useMutation();
  const result = requested === normalize(control) ? preview.data : null;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const named = normalize(control);
    setRequested(named);
    void preview.mutateAsync({ exactContainerControl: named, lifecycle }).catch(() => undefined);
  };
  return <Card className="border-sky-200 bg-sky-50/30">
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4" />Exact Container Control preview</CardTitle>
      <p className="text-sm text-muted-foreground">Re-reads one current Container Control and its assigned Vendor from VTiger, then performs exact GET-only Xero contact, item and PO-number checks. No event is triggered, no route is called and no PO is created.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="min-w-52 flex-1 text-sm font-medium">Container Control number or VTiger ID
          <Input className="mt-1 font-mono" value={control} onChange={(event) => { setControl(event.target.value); preview.reset(); }} placeholder="C1911" maxLength={20} autoComplete="off" />
        </label>
        <label className="text-sm font-medium">Lifecycle
          <select className="mt-1 h-9 rounded-md border bg-background px-3 text-sm" value={lifecycle} onChange={(event) => { setLifecycle(event.target.value as "initial" | "recurring"); preview.reset(); }}>
            <option value="initial">Initial Request PO</option><option value="recurring">Next extension PO</option>
          </select>
        </label>
        <Button type="submit" variant="outline" disabled={preview.isPending || !/^(?:C\d{1,12}|\d+x\d{1,12})$/i.test(normalize(control))}><BusinessText value={preview.isPending ? "Checking…" : "Preview only"} /></Button>
      </form>
      {preview.error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"><BusinessText value={preview.error.message} /></p>}
      {result && <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2"><strong className="font-mono"><BusinessText value={result.facts.controlNumber || result.facts.recordId} /></strong><span className="text-sm text-muted-foreground"><BusinessText value={result.facts.containerNumber || "Container pending"} /> · <BusinessText value={result.facts.containerType || "Type pending"} /> · <BusinessText value={result.facts.status || "Status pending"} /></span>
          <Badge variant="outline" className={result.state === "previewed" ? "border-sky-200 bg-sky-50 text-sky-800" : result.state === "dehired" ? "border-slate-200 bg-slate-100 text-slate-700" : "border-amber-200 bg-amber-50 text-amber-900"}><BusinessText value={result.state === "previewed" ? "Preflight clear — no write" : result.state.replaceAll("_", " ")} /></Badge></div>
        <p className="text-sm">Supplier <strong><BusinessText value={result.facts.supplierName || "Not resolved"} /></strong> · Collection Date <strong><BusinessText value={result.facts.collectionDate || "Not set"} /></strong>{result.preview.periodStart ? <> · Period <strong><BusinessText value={result.preview.periodStart} />–<BusinessText value={result.preview.periodEnd} /></strong></> : null}</p>
        {result.holdReason && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" />Held — no PO created</p><p className="mt-1"><BusinessText value={result.holdReason} /></p></div>}
        {result.preview.document && <div className="overflow-x-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="border-b text-xs uppercase text-muted-foreground"><tr><th className="p-3">PO / supplier</th><th className="p-3">Line items</th><th className="p-3">Xero check</th><th className="p-3 text-right">Ex GST / GST / total</th></tr></thead><tbody><tr className="align-top"><td className="p-3"><p className="font-mono font-semibold"><BusinessText value={result.preview.document.proposedDocumentNumber} /></p><p className="mt-1 text-xs text-muted-foreground"><BusinessText value={result.preview.document.partyName} /><br />Account 312 · AUD · Draft-only future payload</p></td><td className="p-3 text-xs">{result.preview.document.lineItems.map((line, index) => <div className="mb-2 last:mb-0" key={`${line.itemCode}-${index}`}><strong><BusinessText value={line.itemCode || "Fee"} /></strong> · Qty <BusinessText value={line.quantity} /> × <BusinessText value={money(line.unitAmount)} /><br /><span className="text-muted-foreground"><BusinessText value={line.description} /></span></div>)}</td><td className="p-3 text-xs"><BusinessText value={result.preflight?.duplicateState ?? "Not checked"} /><BusinessText value={result.preflight?.status ? ` · ${result.preflight.status}` : ""} /><br /><span className="text-muted-foreground"><BusinessText value={result.preflight?.contactCheck.contactId ? "Exact Xero supplier matched" : "Supplier contact pending"} /></span>{result.preflight?.xeroDocumentId ? <p className="mt-1 break-all font-mono text-muted-foreground"><BusinessText value={result.preflight.xeroDocumentId} /></p> : null}</td><td className="p-3 text-right text-xs tabular-nums"><BusinessText value={money(result.preview.document.subtotal)} /><br /><BusinessText value={money(result.preview.document.taxAmount)} /><br /><strong><BusinessText value={money(result.preview.document.total)} /></strong></td></tr></tbody></table></div>}
        <details className="rounded-lg border p-3 text-xs text-muted-foreground"><summary className="cursor-pointer font-medium">Evidence hashes and local AP status</summary><div className="mt-2 space-y-1 break-all font-mono"><p>Source: <BusinessText value={result.sourceSnapshotHash} /></p><p>Rules: <BusinessText value={result.rulesSnapshotHash} /></p><p>Xero preflight: <BusinessText value={result.xeroPreflightHash ?? "not available"} /></p></div></details>
        <p className="text-xs text-muted-foreground">A preview may become stale. The future writer must refresh source, contact, item, duplicate and hash evidence after an approved For Hire-only cutover.</p>
      </div>}
    </CardContent>
  </Card>;
}
