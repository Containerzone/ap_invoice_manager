import { useState } from "react";
import { FileSearch, FileText, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

type Direction = "overweight" | "underweight";
export default function FinalWeightAdjustments() {
  const [deal, setDeal] = useState("");
  const [selected, setSelected] = useState("");
  const [direction, setDirection] = useState<Direction>("overweight");
  const readiness = trpc.financialOperations.finalWeightReadiness.useQuery();
  const events = trpc.financialOperations.finalWeightEvents.useQuery({ limit: 100 });
  const preview = trpc.financialOperations.previewFinalWeightAdjustment.useQuery({ exactDeal: selected, direction }, { enabled: Boolean(selected), retry: false, refetchOnWindowFocus: false });
  const result = preview.data;
  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-12">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="flex items-center gap-2 text-2xl font-semibold"><FileText className="h-6 w-6" />Final Weight Adjustments</h1><p className="mt-2 text-sm text-muted-foreground">Exact named Deal → current Draft main invoice amendment readiness.</p></div>
        <Badge variant="outline">{readiness.data?.branches.every(branch => branch.writerEnabled) ? "Independent receiver released" : "Default off — no amendments"}</Badge>
      </header>
      <Card><CardContent className="space-y-3 p-5 text-sm"><p className="flex items-center gap-2 font-semibold"><LockKeyhole className="h-4 w-4" />Read-only workspace. No write, release or invoice-creation button.</p><p>Only the exact current <code>INV-&lt;Deal digits&gt;</code> AUD GST-exclusive ACCREC Draft is eligible. Missing, ambiguous, paid, allocated, authorised, voided or deleted invoices hold. Both branches share an exclusive one-time document claim, separate from Main Invoice release.</p><p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">Overweight replaces all existing SER70 duplicates with one positive excess-weight line, retaining every other full line. Underweight changes only the verified Full Container Pickup DATE due date; never a negative line or invented fallback. Neither branch creates an invoice or changes CRM.</p></CardContent></Card>
      <div className="grid gap-4 md:grid-cols-2">
        {(["overweight", "underweight"] as const).map(branch => {
          const status = readiness.data?.branches.find(row => row.direction === branch);
          return <Card key={branch}><CardHeader><CardTitle className="text-base">{branch === "overweight" ? "Overweight — SER70 update" : "Underweight — due-date update"}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><Badge variant="outline">{status?.writerEnabled ? "Approved dedicated gate" : "Disabled / unverified"}</Badge><p className="break-all font-mono text-xs">{status?.webhookPath ?? `/api/webhooks/vtiger/final-weight-${branch}`}</p><p>{branch === "overweight" ? "Actual > Estimated · positive Per Extra Tonne · exactly one SER70." : "Actual < Estimated · exact mapped pickup date · unchanged line items."}</p><p className="text-xs text-amber-900">{status?.releaseHoldReason ?? (readiness.error ? "Readiness unavailable; treat as unreleased." : "Loading release evidence…")}</p></CardContent></Card>;
        })}
      </div>
      <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileSearch className="h-4 w-4" />Read-only exact named Deal preview</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">One exact D-number or webservice ID only. Current metadata, Deal, linked customer and exact Xero full invoice lines are re-read. No preview evidence is saved; no Xero/VTiger record is written.</p>
        <div className="flex flex-col gap-2 sm:flex-row"><Input aria-label="Exact final-weight Deal" placeholder="D702877 or 5x12345" value={deal} onChange={event => { setDeal(event.target.value); setSelected(""); }} className="font-mono" /><select aria-label="Final weight direction" className="rounded-md border bg-background p-2 text-sm" value={direction} onChange={event => { setDirection(event.target.value as Direction); setSelected(""); }}><option value="overweight">Overweight</option><option value="underweight">Underweight</option></select><Button disabled={!/^(D\d{1,12}|\d+x\d{1,12})$/i.test(deal.trim()) || preview.isFetching} onClick={() => { const value = deal.trim().replace(/^d/i, "D"); if (value === selected) void preview.refetch(); else setSelected(value); }}>{preview.isFetching ? "Reading…" : "Preview evidence"}</Button></div>
        {selected && preview.error ? <p role="alert" className="text-sm text-red-700">{preview.error.message}</p> : null}
        {selected && result ? <div className="space-y-3 rounded-lg border p-4 text-sm"><div className="flex justify-between gap-2"><p className="font-medium">{result.facts.dealNumber} · {result.facts.dealName} · {result.facts.customerName || "Unresolved customer"}</p><Badge variant={result.state === "held" ? "destructive" : "outline"}>{result.state === "held" ? "Held — no write" : "Evidence only"}</Badge></div>{result.holdReason ? <p className="rounded-md bg-amber-50 p-3 text-amber-900">{result.holdReason}</p> : null}<div className="grid gap-3 md:grid-cols-3"><p>Estimated / actual tonnes<br /><strong>{result.facts.estimatedWeight ?? "missing"} / {result.facts.actualWeight ?? "missing"}</strong></p><p>Per extra tonne / pickup date<br /><strong>{result.facts.perExtraTonne ?? "missing"} / {result.facts.requiredDueDate ?? "not required / missing"}</strong></p><p className="break-all">Exact invoice<br /><strong>{result.preview.invoiceNumber ?? "held"}</strong><br /><span className="text-xs">{result.preview.invoiceId ?? "No exact Draft ID"}</span></p></div><details><summary>Verified mappings, source/preflight hashes and complete original / expected Draft payloads</summary><pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify({ mappings: result.facts.mappingEvidence, sourceHash: result.sourceSnapshotHash, preflightHash: result.xeroPreflightHash, originalDraft: result.preview.originalDraft, expectedDraft: result.preview.expectedDraft }, null, 2)}</pre></details></div> : null}
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">AP immutable event / hold tracking</CardTitle><p className="text-sm text-muted-foreground">Protected-receiver receipts only. Browser previews and disabled receivers persist nothing.</p></CardHeader><CardContent>
        {events.isLoading ? <p className="text-sm">Loading local tracking…</p> : events.error ? <p role="alert" className="text-sm text-red-700">Final-weight ledger unavailable. The generated migration requires separate review/application; no execution state is assumed.</p> : !events.data?.length ? <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">No final-weight event or amendment receipt recorded.</p> : <div className="space-y-3">{events.data.map(row => <div key={row.id} className="grid gap-3 rounded-lg border p-4 text-sm md:grid-cols-3"><div><p className="font-medium">{row.dealNumber} · {row.direction}</p><p className="font-mono">{row.invoiceNumber ?? "Unresolved invoice"}</p><p className="break-all text-xs text-muted-foreground">{row.xeroInvoiceId ?? "No exact ID"}</p></div><div><Badge variant="outline">{row.status.replaceAll("_", " ")}</Badge>{row.holdReason ? <p className="mt-2 text-xs text-amber-900">{row.holdReason}</p> : null}</div><div className="text-xs text-muted-foreground"><p>Event #{row.id} · execution {row.executionId ?? "none"}</p><p>Source {row.sourceSnapshotHash.slice(0, 12)}…</p><p>Preflight {row.xeroPreflightHash?.slice(0, 12) ?? "none"}…</p><p>{row.authorisedPayload ? "Immutable payload bound" : "No payload authorised"} · {row.claimedInvoiceId ? "Exclusive claim retained" : "Unclaimed"}</p></div></div>)}</div>}
      </CardContent></Card>
    </div>
  );
}
