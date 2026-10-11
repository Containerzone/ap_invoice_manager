import { useState } from "react";
import { FileSearch, FileText, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
export default function WarrantyAviso() {
  const [deal, setDeal] = useState(""); const [selected, setSelected] = useState("");
  const readiness = trpc.financialOperations.warrantyAvisoReadiness.useQuery();
  const events = trpc.financialOperations.warrantyAvisoEvents.useQuery({ limit: 100 });
  const preview = trpc.financialOperations.previewWarrantyAviso.useQuery({ exactDealId: selected }, { enabled: Boolean(selected), retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 0 });
  const r = readiness.data; const p = preview.data;
  return <div className="mx-auto max-w-6xl space-y-5 pb-12">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="flex items-center gap-2 text-2xl font-semibold"><FileText className="h-6 w-6" />Warranty &amp; Aviso</h1><p className="mt-2 text-sm text-muted-foreground">Isolated Added Services evidence → one existing Draft main warranty append + a new Draft Aviso PO.</p></div><Badge variant="outline">{r?.writerEnabled ? "Separately approved receiver ready" : "Default-off — held"}</Badge></header>
    <div className="grid gap-3 md:grid-cols-3">
      <Card><CardContent className="space-y-2 p-4 text-sm"><h2 className="font-medium">Added Services only</h2><p>Warranty Confirmed is deliberately ignored. Exact current metadata, one approved WAR item/native description and GST-exclusive premium are required. No free-text inference.</p></CardContent></Card>
      <Card><CardContent className="space-y-2 p-4 text-sm"><h2 className="font-medium">Draft-only contract</h2><p><code>INV-&lt;Deal digits&gt;</code>: append one line only if no WAR line exists. Preserve every other line/date/header. <code>I&lt;Deal digits&gt;</code>: new Draft PO, Aviso Broking Pty Ltd, account 313, AUD, GST exclusive.</p></CardContent></Card>
      <Card><CardContent className="space-y-2 p-4 text-sm"><h2 className="flex gap-2 font-medium"><LockKeyhole className="h-4 w-4" />No browser release/write control</h2><p>Non-Draft main and any PO collision hold. No suffix scheme implemented. No CRM mutation, adoption or uncertain retries. Coordinated warranty + main-invoice handover required.</p></CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle className="text-base">Policy readiness &amp; configuration gaps</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
      {readiness.error ? <p role="alert">Readiness unavailable. Treat receiver as held.</p> : <><p>Receiver: <code>{r?.webhookPath ?? "/api/webhooks/vtiger/warranty-aviso"}</code></p><p>{r?.holdReason ?? "Policy check pending"}</p><p>Warranty-only VTiger branch: {r?.policy.warrantyOnlyVtigerBranch ? "acknowledged" : "not acknowledged"} · Operations/Make handover: {r?.policy.operationsMakeHandoverAcknowledged ? "acknowledged" : "not acknowledged"} · Main Invoice coordination: {r?.policy.mainInvoiceCoordinationAcknowledged ? "acknowledged" : "not acknowledged"}</p><p>Draft amendment: {r?.policy.enableDraftMainAmendment && r.policy.draftAmendmentAcknowledged ? "explicitly acknowledged" : "not approved"} · New Events only: {r?.policy.migrationScope ?? "not approved"}</p><ul className="list-disc pl-5">{r?.configurationRequired.map(g => <li key={g}>{g}</li>)}</ul><p className="text-muted-foreground">{r?.migrationApplication}</p></>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><FileSearch className="h-4 w-4" />Exact current Deal preview — query only</CardTitle></CardHeader><CardContent className="space-y-4 text-sm">
      <p>Enter one exact VTiger Deal webservice ID. Fresh authenticated metadata + exact Deal/customer reads and Xero accounting GETs only; records immutable AP preview/hold. No source scans. Authentication may use identity-only login/token refresh.</p>
      <div className="flex gap-2"><Input value={deal} onChange={e => setDeal(e.target.value)} placeholder="5x12345" className="font-mono" /><Button disabled={!/^\d+x\d{1,12}$/.test(deal) || preview.isFetching} onClick={() => selected === deal ? void preview.refetch() : setSelected(deal)}>Check exact evidence</Button></div>
      {preview.error ? <p role="alert" className="text-red-700">{preview.error.message}</p> : null}
      {p ? <div className="space-y-2 rounded border p-4"><Badge variant={p.state === "held" ? "destructive" : "outline"}>{p.state}</Badge><p>{p.facts.dealNumber || p.facts.dealId} · {p.facts.customerName || "Customer unresolved"} · Added Services: {p.facts.addedServices || "Unproven"}</p><p>{p.holdReason}</p><ul className="list-disc pl-5">{p.facts.configurationRequired.map(g => <li key={g}>{g}</li>)}</ul>{p.plan ? <p>Exact candidate main {p.plan.mainNumber} · PO {p.plan.poNumber} · Existing full lines preserved; one native WAR append. This preview does not authorise release.</p> : null}</div> : null}
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Immutable AP lifecycle events</CardTitle><p className="text-sm text-muted-foreground">New AP evidence, claims, attempts and receipts only. Legacy warranty_documents is never read or imported.</p></CardHeader><CardContent>
      {events.error ? <p role="alert" className="text-sm text-red-700">Ledger unavailable; separate migration review/application may be outstanding.</p> : !events.data?.length ? <p className="rounded border border-dashed p-5 text-sm text-muted-foreground">No AP warranty events loaded.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b"><tr><th className="p-2">Deal</th><th className="p-2">State</th><th className="p-2">Immutable evidence</th><th className="p-2">Hold / receipt</th></tr></thead><tbody>{events.data.map(row => <tr className="border-b" key={row.id}><td className="p-2 font-mono">{row.dealNumber ?? row.dealId}</td><td className="p-2">{row.status.replaceAll("_", " ")}</td><td className="p-2 font-mono text-xs">#{row.id} · {row.sourceSnapshotHash?.slice(0, 12) ?? "Lifecycle entry"}</td><td className="p-2 text-xs">{row.holdReason ?? (row.receipt ? "Immutable receipt retained" : "No financial receipt")}</td></tr>)}</tbody></table></div>}
    </CardContent></Card>
  </div>;
}
