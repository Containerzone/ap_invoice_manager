import { useMemo, useState } from "react";
import { AlertTriangle, Download, FileCheck2, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type ReleaseFamily = {
  id: number;
  familyKey: string;
  displayName: string;
  workflowType: string;
  branch: string;
  releaseStatus: "included" | "held" | "excluded";
  statusReason: string;
  expectedReferencePattern: string;
  firstExpectedTrigger: string;
  apEndpointIdentifier: string;
  apScheduleDefinition: string | null;
  shadowTestId: number | null;
  candidateRosterEntryId: number | null;
  sourceRecordNumber: string | null;
  legacyWriterIdentifier: string | null;
  legacyWriterOwner: string | null;
  legacyDisableAction: string | null;
  currentDocumentSummary: unknown;
  conditionPayloadContract: string;
  rollbackPlan: string;
};

type ReleaseManifestDetail = {
  manifest: {
    id: number;
    releaseId: string;
    status: string;
    implementationVersion: string;
    frozenRuleVersion: string;
    includedFamilyCount: number;
    heldFamilyCount: number;
    excludedFamilyCount: number;
    maintenanceWindow: string | null;
    releaseOwner: string | null;
    preparedAt: Date | string;
    xeroReadiness: { outcome?: string; message?: string; organisationName?: string | null; tokenState?: string | null };
    vtigerReadiness: { outcome?: string; message?: string };
    currentDocumentManifest: unknown;
  };
  families: ReleaseFamily[];
  audits: Array<{ id: number; action: string; outcome: string; createdAt: Date | string }>;
};

function stateBadge(state: string) {
  const className = state === "included"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : state === "held"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-red-200 bg-red-50 text-red-800";
  return <Badge variant="outline" className={className}>{state.replace(/_/g, " ")}</Badge>;
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function downloadManifest(manifest: ReleaseManifestDetail) {
  const headings = ["Family", "Workflow", "Branch", "Release status", "Reference pattern", "Shadow evidence", "Source", "Legacy writer", "Legacy owner", "Disable action", "Reason"];
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [headings, ...manifest.families.map((family) => [
    family.displayName,
    family.workflowType,
    family.branch,
    family.releaseStatus,
    family.expectedReferencePattern,
    family.shadowTestId ?? "",
    family.sourceRecordNumber ?? "",
    family.legacyWriterIdentifier ?? "",
    family.legacyWriterOwner ?? "",
    family.legacyDisableAction ?? "",
    family.statusReason,
  ])].map((row) => row.map(escape).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${manifest.manifest.releaseId}-family-manifest.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FinancialReleaseReadiness() {
  const utils = trpc.useUtils();
  const [maintenanceWindow, setMaintenanceWindow] = useState("");
  const [releaseOwner, setReleaseOwner] = useState("");
  const [selectedManifestId, setSelectedManifestId] = useState<number | null>(null);
  const [inventoryFamilyId, setInventoryFamilyId] = useState<number | null>(null);
  const [writerIdentifier, setWriterIdentifier] = useState("");
  const [writerOwner, setWriterOwner] = useState("");
  const [disableAction, setDisableAction] = useState("");
  const manifests = trpc.financialOperations.releaseManifests.useQuery({ limit: 25 });
  const latestManifest = (manifests.data?.[0] ?? null) as ReleaseManifestDetail | null;
  const activeManifestId = selectedManifestId ?? latestManifest?.manifest.id ?? null;
  const manifest = trpc.financialOperations.releaseManifest.useQuery(
    { manifestId: activeManifestId ?? 0 },
    { enabled: Boolean(activeManifestId) },
  );
  const active = manifest.data as ReleaseManifestDetail | undefined;
  const prepare = trpc.financialOperations.prepareAllFamilyReleaseManifest.useMutation({
    onSuccess: async (result) => {
      toast.success(`Release manifest ${result.manifest.releaseId} prepared. No financial writer, source setting or schedule changed.`);
      setSelectedManifestId(result.manifest.id);
      await utils.financialOperations.releaseManifests.invalidate();
      await utils.financialOperations.releaseManifest.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const recordInventory = trpc.financialOperations.recordReleaseLegacyInventory.useMutation({
    onSuccess: async () => {
      toast.success("Legacy writer inventory recorded locally. It did not change the writer or release status.");
      setInventoryFamilyId(null);
      setWriterIdentifier("");
      setWriterOwner("");
      setDisableAction("");
      await utils.financialOperations.releaseManifest.invalidate();
      await utils.financialOperations.releaseManifests.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const selectedFamily = useMemo(() => active?.families.find((family) => family.id === inventoryFamilyId) ?? null, [active?.families, inventoryFamilyId]);

  return <div className="space-y-4">
    <Card className="border-red-200 bg-red-50/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-red-950"><ShieldCheck className="h-5 w-5" />All Financial Operations Go-Live — release preparation only</CardTitle>
        <p className="mt-1 text-sm text-red-900">This workbench freezes release evidence for every financial family. It is not an activation control: Xero writes remain server-disabled, no existing writer is disabled, and no schedule is registered or enabled here.</p>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm md:grid-cols-3">
        <div className="rounded-md border border-red-200 bg-white/70 p-3"><p className="font-medium">Global writer lock</p><p className="mt-1 text-xs">Active. The reserved release endpoint rejects all financial writes.</p></div>
        <div className="rounded-md border border-red-200 bg-white/70 p-3"><p className="font-medium">Source-system boundary</p><p className="mt-1 text-xs">No Operations/VTiger/Make settings, workflow URLs or existing schedules are modified.</p></div>
        <div className="rounded-md border border-red-200 bg-white/70 p-3"><p className="font-medium">Approval boundary</p><p className="mt-1 text-xs">A final activation request is unavailable until all families are included and reviewed.</p></div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><FileCheck2 className="h-4 w-4" />Prepare a fresh all-family manifest</CardTitle><p className="mt-1 text-sm text-muted-foreground">Runs current GET-only Xero and authenticated read-only VTiger checks, freezes the current AP rules, and records status for all 14 release families. It does not scan broad source history or create Xero documents.</p></CardHeader>
      <CardContent className="space-y-3"><div className="grid gap-3 md:grid-cols-2"><div className="space-y-1.5"><Label>Proposed maintenance window (optional)</Label><Input value={maintenanceWindow} onChange={(event) => setMaintenanceWindow(event.target.value)} placeholder="e.g. 12 Oct 2026, 19:00–20:00 AEST" /></div><div className="space-y-1.5"><Label>Release owner (optional)</Label><Input value={releaseOwner} onChange={(event) => setReleaseOwner(event.target.value)} placeholder="Named release owner / AP approver" /></div></div><Button onClick={() => prepare.mutate({ maintenanceWindow: maintenanceWindow.trim() || null, releaseOwner: releaseOwner.trim() || null })} disabled={prepare.isPending}>{prepare.isPending ? "Freezing evidence…" : <><RefreshCw className="mr-2 h-4 w-4" />Prepare fresh release manifest</>}</Button></CardContent>
    </Card>

    {manifests.data && manifests.data.length > 1 ? <div className="flex flex-wrap items-center gap-2 text-sm"><Label>Saved manifest</Label><select value={String(activeManifestId ?? "")} onChange={(event) => setSelectedManifestId(Number(event.target.value))} className="h-9 rounded-md border bg-background px-3"><option value="">Latest manifest</option>{(manifests.data as ReleaseManifestDetail[]).map((entry) => <option key={entry.manifest.id} value={entry.manifest.id}>{entry.manifest.releaseId} · {formatDate(entry.manifest.preparedAt)}</option>)}</select></div> : null}

    {!activeManifestId ? <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No all-family release manifest has been prepared yet.</CardContent></Card> : manifest.isLoading ? <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Loading frozen release evidence…</CardContent></Card> : active ? <>
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle>Frozen readiness summary</CardTitle><p className="mt-1 font-mono text-xs text-muted-foreground">{active.manifest.releaseId} · {active.manifest.implementationVersion} · {active.manifest.frozenRuleVersion}</p></div><Button variant="outline" size="sm" onClick={() => downloadManifest(active)}><Download className="mr-2 h-4 w-4" />Export family manifest CSV</Button></CardHeader>
        <CardContent className="space-y-3"><div className="grid gap-3 md:grid-cols-3"><div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm"><p className="font-medium text-emerald-900">Included</p><p className="mt-1 text-2xl font-semibold text-emerald-900">{active.manifest.includedFamilyCount}</p></div><div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"><p className="font-medium text-amber-900">Held</p><p className="mt-1 text-2xl font-semibold text-amber-900">{active.manifest.heldFamilyCount}</p></div><div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm"><p className="font-medium text-red-900">Excluded</p><p className="mt-1 text-2xl font-semibold text-red-900">{active.manifest.excludedFamilyCount}</p></div></div><div className="grid gap-3 md:grid-cols-2 text-sm"><div className={`rounded-md border p-3 ${active.manifest.xeroReadiness.outcome === "passed" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}><strong>Xero GET-only readiness: {active.manifest.xeroReadiness.outcome ?? "unknown"}</strong><p className="mt-1 text-xs">{active.manifest.xeroReadiness.organisationName ?? "No verified AP tenant"} · token {active.manifest.xeroReadiness.tokenState ?? "unknown"}<br />{active.manifest.xeroReadiness.message ?? "No message recorded"}</p></div><div className={`rounded-md border p-3 ${active.manifest.vtigerReadiness.outcome === "passed" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}><strong>VTiger exact-read readiness: {active.manifest.vtigerReadiness.outcome ?? "unknown"}</strong><p className="mt-1 text-xs">{active.manifest.vtigerReadiness.message ?? "No message recorded"}</p></div></div><p className="text-xs text-muted-foreground">Prepared {formatDate(active.manifest.preparedAt)} · owner {active.manifest.releaseOwner ?? "not designated"} · maintenance window {active.manifest.maintenanceWindow ?? "not scheduled"}. There is no final activation approval action in this release.</p></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>All-family release matrix</CardTitle><p className="mt-1 text-sm text-muted-foreground">Every required family is explicit. A family stays excluded until its exact source, reviewer-confirmed shadow evidence, current document preflight and legacy writer handoff are all captured.</p></CardHeader>
        <CardContent className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="p-3">Family / reference</th><th className="p-3">Status / evidence</th><th className="p-3">Current first trigger</th><th className="p-3">Legacy writer inventory</th><th className="p-3">Reason / safeguards</th></tr></thead><tbody>{active.families.map((family) => <tr key={family.id} className="border-b align-top last:border-0"><td className="p-3"><p className="font-medium">{family.displayName}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{family.expectedReferencePattern}</p><p className="mt-1 text-xs text-muted-foreground">{family.apScheduleDefinition ?? "Event-driven only"}</p></td><td className="p-3">{stateBadge(family.releaseStatus)}<p className="mt-2 text-xs">Shadow #{family.shadowTestId ?? "—"}<br />Roster #{family.candidateRosterEntryId ?? "—"}<br />Source {family.sourceRecordNumber ?? "not named"}</p></td><td className="max-w-xs p-3 text-xs text-muted-foreground">{family.firstExpectedTrigger}</td><td className="p-3 text-xs">{family.legacyWriterIdentifier ? <><p className="font-mono">{family.legacyWriterIdentifier}</p><p className="mt-1">Owner: {family.legacyWriterOwner}</p><p className="mt-1 text-muted-foreground">Disable: {family.legacyDisableAction}</p></> : <Button size="sm" variant="outline" onClick={() => { setInventoryFamilyId(family.id); setWriterIdentifier(""); setWriterOwner(""); setDisableAction(""); }}>Record inventory</Button>}</td><td className="max-w-sm p-3 text-xs"><p className="text-red-800">{family.statusReason}</p><p className="mt-2 text-muted-foreground">Draft-only: no non-Draft amendment, no source change, no enabled schedule.</p></td></tr>)}</tbody></table></CardContent>
      </Card>

      {selectedFamily ? <Card className="border-sky-200 bg-sky-50/40"><CardHeader><CardTitle className="text-base">Record legacy writer inventory — {selectedFamily.displayName}</CardTitle><p className="mt-1 text-sm text-muted-foreground">This captures an AP-owned handoff record only. It does not disable, edit or inspect the legacy workflow.</p></CardHeader><CardContent className="space-y-3"><div className="grid gap-3 md:grid-cols-2"><div className="space-y-1.5"><Label>Exact writer / schedule identifier</Label><Input value={writerIdentifier} onChange={(event) => setWriterIdentifier(event.target.value)} placeholder="Existing Operations / Make writer identifier" /></div><div className="space-y-1.5"><Label>Current owner</Label><Input value={writerOwner} onChange={(event) => setWriterOwner(event.target.value)} placeholder="Business or IT owner" /></div></div><div className="space-y-1.5"><Label>Approved disable action (documentation only)</Label><Textarea value={disableAction} onChange={(event) => setDisableAction(event.target.value)} placeholder="Exact change to be performed later, after a separate final approval." /></div><div className="flex gap-2"><Button variant="outline" onClick={() => setInventoryFamilyId(null)}>Cancel</Button><Button disabled={recordInventory.isPending || writerIdentifier.trim().length < 3 || writerOwner.trim().length < 2 || disableAction.trim().length < 8} onClick={() => active && recordInventory.mutate({ manifestId: active.manifest.id, familyId: selectedFamily.id, legacyWriterIdentifier: writerIdentifier.trim(), legacyWriterOwner: writerOwner.trim(), legacyDisableAction: disableAction.trim() })}>{recordInventory.isPending ? "Recording…" : <><Save className="mr-2 h-4 w-4" />Record local handoff evidence</>}</Button></div></CardContent></Card> : null}

      <Card><CardHeader><CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" />Release blockers and next safe action</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground"><p>Resolve only the stated evidence gaps: re-authenticate the AP Xero connection if its GET-only check is blocked, provide one exact named source per family, complete and confirm clean shadow tests, preflight the named Draft document(s), and record the legacy writer identifier and disable action. Then prepare a new manifest.</p><p className="mt-2 font-medium text-foreground">Do not disable any existing writer, update a source setting, create a schedule or send a Xero request from this screen.</p></CardContent></Card>
    </> : null}
  </div>;
}
