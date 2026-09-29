import { useState } from "react";
import { Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FAMILIES = [
  ["initial_container_control_asset", "Initial CC — Asset"],
  ["initial_container_control_customer_sale", "Initial CC — Customer Sale"],
  ["initial_container_control_for_hire", "Initial CC — For Hire"],
  ["recurring_for_hire", "Recurring For Hire"],
  ["origin_storage_activation", "Origin Storage Activation"],
  ["destination_storage_activation", "Destination Storage Activation"],
  ["recurring_storage", "Recurring Storage"],
  ["storage_finalisation_recovery", "Storage Finalisation / Recovery"],
  ["main_customer_invoice", "Main Customer Invoice"],
  ["deposit_invoice", "Deposit Invoice"],
  ["final_weight_overweight", "Final Weight — Overweight"],
  ["final_weight_underweight", "Final Weight — Underweight"],
  ["extra_hire", "Extra Hire"],
  ["warranty_customer_invoice_and_aviso_po", "Warranty/Aviso"],
] as const;

type DiscoveryCandidate = {
  recordId: string;
  sourceCategory: "deal" | "container_control";
  businessNumber: string;
  stageOrStatus: string | null;
  sourceRefreshedAt: Date | string | null;
  eligibilityReasons: string[];
  expectedDocumentNumbers: string[];
  proposalSummary: Array<{ documentNumber: string | null; documentFamily: string; accountCode: string | null; total: number; validationStatus: string }>;
  collisionState: string;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
};

type Discovery = {
  family: { familyKey: typeof FAMILIES[number][0]; displayName: string; workflowType: string; branch: string; sourceCategory: string; criteria: string[]; holdReasons: string[] };
  outcome: "found" | "no_current_candidate" | "blocked";
  searchedAt: Date | string;
  candidates: DiscoveryCandidate[];
  message: string;
  discoveryId: number;
};

function displayDate(value: Date | string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
}

function statusClass(outcome: Discovery["outcome"]) {
  return outcome === "found" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : outcome === "no_current_candidate" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-800";
}

/** Existing Candidate Roster companion: discovery returns review candidates only. */
export function FinancialFamilyCandidateDiscovery() {
  const utils = trpc.useUtils();
  const [familyKey, setFamilyKey] = useState<typeof FAMILIES[number][0]>("initial_container_control_asset");
  const [result, setResult] = useState<Discovery | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [periodStart, setPeriodStart] = useState("");
  const discover = trpc.financialOperations.discoverFamilyCandidates.useMutation({
    onSuccess: (next) => {
      const parsed = next as Discovery;
      setResult(parsed);
      setSelectedRecordId(null);
      toast.message(parsed.outcome === "found" ? "Review candidates loaded. Select exactly one before adding it to Candidate Roster." : parsed.message);
      utils.financialOperations.candidateDiscoveries.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const saveRoster = trpc.financialOperations.saveCandidateRosterEntry.useMutation({
    onSuccess: () => {
      toast.success("Exactly one review candidate was added to the existing Candidate Roster. It remains no-write evidence only.");
      setSelectedRecordId(null);
      utils.financialOperations.candidateRoster.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const selected = result?.candidates.find((candidate) => candidate.recordId === selectedRecordId) ?? null;
  const recurring = result?.family.workflowType === "recurring_for_hire" || result?.family.workflowType === "recurring_storage";

  return <div className="space-y-4">
    <Card className="border-sky-200 bg-sky-50/50">
      <CardHeader><CardTitle className="flex items-center gap-2 text-sky-950"><Search className="h-4 w-4" />Controlled family candidate discovery</CardTitle><p className="mt-1 text-sm text-sky-900">One administrator-invoked, bounded current-state search per family. It returns no more than 10 review candidates, uses authenticated VTiger/Xero reads only, and never creates an activation candidate or changes a source record.</p></CardHeader>
      <CardContent className="space-y-3"><div className="grid gap-3 md:grid-cols-[1fr_auto]"><div className="space-y-1.5"><Label>Financial family</Label><select value={familyKey} onChange={(event) => setFamilyKey(event.target.value as typeof familyKey)} className="h-9 w-full rounded-md border bg-background px-3 text-sm">{FAMILIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="flex items-end"><Button onClick={() => discover.mutate({ familyKey })} disabled={discover.isPending}>{discover.isPending ? "Reading current evidence…" : <><Search className="mr-2 h-4 w-4" />Discover candidates</>}</Button></div></div><p className="rounded-md border border-sky-200 bg-white/80 p-3 text-xs text-sky-950"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" /><strong>Bounded discovery:</strong> AP rejects a family if no positive current-status/stage mapping is configured rather than falling back to a broad historical VTiger scan. Storage families are sourced only from verified AP execution-state events.</p></CardContent>
    </Card>

    {result ? <Card><CardHeader><CardTitle className="flex flex-wrap items-center gap-2 text-base">{result.family.displayName}<Badge className={statusClass(result.outcome)}>{result.outcome.replaceAll("_", " ")}</Badge><Badge variant="outline">Discovery #{result.discoveryId}</Badge></CardTitle><p className="mt-1 text-sm text-muted-foreground">{result.message}</p></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-2"><div className="rounded-md border bg-muted/20 p-3 text-xs"><strong>Current eligibility criteria</strong><ul className="mt-1 list-disc space-y-1 pl-4">{result.family.criteria.map((item) => <li key={item}>{item}</li>)}</ul></div><div className="rounded-md border bg-muted/20 p-3 text-xs"><strong>Automatic hold conditions</strong><ul className="mt-1 list-disc space-y-1 pl-4">{result.family.holdReasons.map((item) => <li key={item}>{item}</li>)}</ul></div></div>{result.outcome === "no_current_candidate" ? <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"><strong>NO_CURRENT_CANDIDATE</strong> is the correct factual result. It is neither a failed search nor evidence that this family is ready.</div> : null}{result.candidates.length > 0 ? <div className="space-y-3">{result.candidates.map((candidate) => <label key={candidate.recordId} className={`block cursor-pointer rounded-lg border p-4 transition-colors ${selectedRecordId === candidate.recordId ? "border-sky-400 bg-sky-50" : "hover:bg-muted/30"}`}><div className="flex gap-3"><input type="radio" name="family-candidate" checked={selectedRecordId === candidate.recordId} onChange={() => setSelectedRecordId(candidate.recordId)} className="mt-1" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="font-mono">{candidate.businessNumber}</strong><Badge variant="outline">{candidate.recordId}</Badge><Badge variant="outline">{candidate.stageOrStatus ?? "status not mapped"}</Badge><Badge variant="outline">{candidate.collisionState.replaceAll("_", " ")}</Badge></div><p className="mt-1 text-xs text-muted-foreground">Updated {displayDate(candidate.sourceRefreshedAt)} · eligible because {candidate.eligibilityReasons.join("; ") || "current configured predicates"}</p><div className="mt-2 grid gap-2 text-xs md:grid-cols-2"><div><strong>Expected Xero refs</strong><p className="font-mono">{candidate.expectedDocumentNumbers.join(", ") || "not derivable until source mapping is complete"}</p></div><div><strong>Proposal lines</strong><p>{candidate.proposalSummary.map((proposal) => `${proposal.documentNumber ?? "reference pending"} · ${proposal.documentFamily} · ${proposal.validationStatus}`).join("; ") || "no derivable document"}</p></div></div><details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">Evidence fingerprints</summary><p className="mt-1 break-all font-mono">source {candidate.sourceSnapshotHash}<br />rules {candidate.rulesSnapshotHash}<br />Xero preflight {candidate.xeroPreflightHash ?? "not available"}</p></details></div></div></label>)}</div> : null}{selected ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4"><p className="font-medium text-emerald-950">Reviewer selection — exactly one source</p><p className="mt-1 text-xs text-emerald-900">Selected {selected.businessNumber} / {selected.recordId}. The next step creates a row in the existing Candidate Roster; it does not confirm evidence, call a writer, or enable a family.</p>{recurring ? <div className="mt-3 max-w-xs space-y-1.5"><Label>Selected billing-period start</Label><Input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /><p className="text-xs text-emerald-900">Required for a recurring selection; a later selector must still verify consecutiveness and no-catch-up rules.</p></div> : null}<Button className="mt-3" onClick={() => result && saveRoster.mutate({ familyKey: result.family.familyKey, sourceCategory: selected.sourceCategory, businessNumber: selected.businessNumber, workflowType: result.family.workflowType as any, branch: result.family.branch, businessNote: `Selected from controlled Discovery #${result.discoveryId}; source ${selected.recordId}; collision ${selected.collisionState}.`, selectedPeriodStart: periodStart ? new Date(`${periodStart}T00:00:00.000Z`) : null })} disabled={saveRoster.isPending || (recurring && !periodStart)}>{saveRoster.isPending ? "Adding roster selection…" : "Add selected source to Candidate Roster"}</Button></div> : null}</CardContent></Card> : null}
  </div>;
}
