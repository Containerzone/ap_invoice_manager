import { useState } from "react";
import { FileSearch, FileText, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";

const money = (value: unknown) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(
    Number(value ?? 0)
  );
const date = (value: unknown) =>
  value ? new Date(String(value)).toISOString().slice(0, 10) : "not supplied";
export default function DepositInvoices() {
  const [deal, setDeal] = useState("");
  const [selectedDeal, setSelectedDeal] = useState("");
  const readiness = trpc.financialOperations.depositInvoiceReadiness.useQuery();
  const events = trpc.financialOperations.depositInvoiceEvents.useQuery({
    limit: 100,
  });
  const preview = trpc.financialOperations.previewDepositInvoice.useQuery(
    { exactDeal: selectedDeal },
    {
      enabled: Boolean(selectedDeal),
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 0,
    }
  );
  const active = readiness.data?.writerEnabled === true;
  const result = preview.data;
  const document = result?.preview.document;
  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <FileText className="h-6 w-6" />
            Deposit Invoices
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Current named VTiger Deal → isolated exact Xero Deposit Draft
            readiness and tracking.
          </p>
        </div>
        <Badge variant="outline">
          {active
            ? "Independent receiver released"
            : "Default off — no Draft writes"}
        </Badge>
      </header>
      <Card>
        <CardContent className="space-y-3 p-5 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <LockKeyhole className="h-4 w-4" />
            This workspace is strictly read-only. There is no invoice creation
            or release control.
          </p>
          <p>
            Contract: <code>INV-&lt;Deal digits&gt;-D</code> · ACCREC · DRAFT ·
            AUD · GST inclusive · one positive <code>Deposit Required</code>{" "}
            line. Any exact collision, including deleted/voided history, is
            held. AP never adopts or suffixes it.
          </p>
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
            Main-invoice negative deposit deductions remain a separate held
            postcondition. This family never changes a main invoice (Draft or
            otherwise), never marks Deposit Status paid, and never queues a CRM
            update.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Independent release boundary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Deposit writer:{" "}
            <strong>
              {active
                ? "enabled only on protected receiver with approved current policy"
                : "disabled / not verified"}
            </strong>{" "}
            · scope: <code>new_events_only</code>.
          </p>
          <p className="break-all font-mono text-xs">
            {readiness.data?.webhookPath ??
              "/api/webhooks/vtiger/deposit-invoice"}
          </p>
          <p>
            Dedicated Deposit branch:{" "}
            {readiness.data?.policy.depositOnlyVtigerBranch
              ? "confirmed"
              : "not confirmed"}{" "}
            · Operations Deposit handoff:{" "}
            {readiness.data?.policy.operationsDepositHandoff
              ? "confirmed"
              : "not confirmed"}{" "}
            · source mappings:{" "}
            {readiness.data?.policy.sourceMappingsConfirmed
              ? "approved"
              : "not approved"}
            .
          </p>
          <p className="text-muted-foreground">
            Global financial flags and other invoice/PO families cannot enable
            Deposit. Disabled receivers hold before any source/Xero/DB call.
          </p>
          {readiness.data?.releaseHoldReason ? (
            <p className="text-amber-900">{readiness.data.releaseHoldReason}</p>
          ) : null}
          {readiness.error ? (
            <p role="alert" className="text-red-700">
              Readiness unavailable. Treat the receiver as unreleased until
              independently verified.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSearch className="h-4 w-4" />
            Read-only current Deal preview
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter one exact Deal number or webservice ID. AP re-reads the exact
            current Deal, metadata-confirmed Deposit/date fields and Deal
            customer (organisation before contact), then performs Xero
            accounting GET-only preflight. This preview saves nothing and writes
            no Xero/VTiger record.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label="Exact Deposit Deal"
              value={deal}
              onChange={event => {
                setDeal(event.target.value);
                setSelectedDeal("");
              }}
              placeholder="D702877 or 5x12345"
              className="font-mono"
            />
            <Button
              disabled={
                !/^(D\d{1,12}|\d+x\d{1,12})$/i.test(deal.trim()) ||
                preview.isFetching
              }
              onClick={() => {
                const value = deal.trim().replace(/^d/i, "D");
                if (value === selectedDeal) void preview.refetch();
                else setSelectedDeal(value);
              }}
            >
              {preview.isFetching
                ? "Reading current evidence…"
                : "Preview current evidence"}
            </Button>
          </div>
          {selectedDeal && preview.error ? (
            <p role="alert" className="text-sm text-red-700">
              {preview.error.message}
            </p>
          ) : null}
          {selectedDeal && result ? (
            <div className="space-y-3 rounded-lg border p-4 text-sm">
              <div className="flex justify-between gap-2">
                <p className="font-medium">
                  {result.facts.dealNumber} ·{" "}
                  {result.facts.customerName || "Customer unresolved"}
                </p>
                <Badge
                  variant={result.state === "held" ? "destructive" : "outline"}
                >
                  {result.state === "held"
                    ? "Held — no write"
                    : "Evidence preview only"}
                </Badge>
              </div>
              {result.holdReason ? (
                <p className="rounded-md bg-amber-50 p-3 text-amber-900">
                  {result.holdReason}
                </p>
              ) : null}
              {result.customerContactPlan ? <div className="rounded-md bg-muted/50 p-3 text-xs"><p className="font-medium">Customer contact decision · {String(result.customerContactPlan.outcome).replaceAll("_", " ")}</p><p className="mt-1">Billing kind {result.customerContactPlan.source?.billingKind ?? "unresolved"} · lookup {Array.isArray(result.customerContactPlan.lookupOrder) ? result.customerContactPlan.lookupOrder.join(" → ") : "not recorded"}</p><p className="mt-1 text-muted-foreground">Resolved party {result.customerContactPlan.source?.name ?? "unavailable"} · source email {result.customerContactPlan.source?.email ? "available" : "not available"} · {result.customerContactPlan.status === "would_create" ? "Preview only — no Xero Contact will be created." : result.customerContactPlan.contactId ? `Immutable ContactID ${result.customerContactPlan.contactId}` : "No ContactID bound."}</p></div> : null}
              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Deposit Status / required inclusive
                  </p>
                  <p>
                    {result.facts.depositStatus || "blank"} ·{" "}
                    {result.facts.depositAmountRequiredInclusive === null
                      ? "not resolved"
                      : money(result.facts.depositAmountRequiredInclusive)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Supply / collection date
                  </p>
                  <p>
                    {result.facts.emptyContainerSupplyDate || "blank"} /{" "}
                    {result.facts.fullContainerCollectionDate || "blank"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Due-date evidence:{" "}
                    {result.preview.dueDateSource ?? "held / unresolved"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Exact Xero -D preflight
                  </p>
                  <p>
                    {result.preflight?.duplicateState ?? "not checked"}{" "}
                    {result.preflight?.status ?? ""}
                  </p>
                </div>
              </div>
              {document ? (
                <div className="rounded-md bg-muted/40 p-3">
                  <p className="font-mono font-semibold">
                    {document.proposedDocumentNumber}
                  </p>
                  <p>
                    {money(document.total)} inclusive ={" "}
                    {money(document.subtotal)} net + {money(document.taxAmount)}{" "}
                    GST · due {date(document.dueDate)} · account{" "}
                    {document.accountCode || "unresolved"}.
                  </p>
                </div>
              ) : null}
              <details className="text-xs">
                <summary>
                  Current confirmed field names and source evidence
                </summary>
                <pre className="mt-2 overflow-auto rounded-md bg-muted p-3">
                  {JSON.stringify(
                    {
                      mappings: result.facts.mappingEvidence,
                      dealId: result.facts.dealId,
                      customerId: result.facts.customerVtigerId,
                      customerKind: result.facts.customerKind,
                      sourceRefreshedAt: result.facts.sourceRefreshedAt,
                      sourceHash: result.sourceSnapshotHash,
                      preflightHash: result.xeroPreflightHash,
                    },
                    null,
                    2
                  )}
                </pre>
              </details>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            AP immutable Deposit event / execution receipts
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Protected-receiver source/preflight receipts and execution states
            only. Browser previews and disabled receipts are not persisted.
          </p>
        </CardHeader>
        <CardContent>
          {events.isLoading ? (
            <p className="text-sm">Loading local Deposit tracking…</p>
          ) : events.error ? (
            <p role="alert" className="text-sm text-red-700">
              Local Deposit ledger unavailable. The generated migration must be
              reviewed/applied separately; no execution state can be assumed.
            </p>
          ) : !events.data?.length ? (
            <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              No AP Deposit event or Draft execution has been recorded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-3">Deal / customer</th>
                    <th className="p-3">Exact invoice</th>
                    <th className="p-3">State / hold</th>
                    <th className="p-3">Immutable evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {events.data.map(row => {
                    const proposal = row.proposal as any;
                    return (
                      <tr key={row.id} className="border-b align-top">
                        <td className="p-3">
                          <p className="font-mono">{row.dealNumber}</p>
                          <p className="text-xs text-muted-foreground">
                            {row.customerName || "not resolved"}
                          </p>
                        </td>
                        <td className="p-3">
                          <p className="font-mono">
                            {row.proposedInvoiceNumber}
                          </p>
                          <p className="text-xs">
                            {proposal ? money(proposal.total) : "Held source"} ·
                            inclusive
                          </p>
                          <p className="break-all text-xs text-muted-foreground">
                            {row.xeroInvoiceId || "No verified Xero receipt"}
                          </p>
                        </td>
                        <td className="p-3">
                          <Badge variant="outline">
                            {row.status.replaceAll("_", " ")}
                          </Badge>
                          {row.holdReason ? (
                            <p className="mt-2 max-w-80 text-xs text-amber-900">
                              {row.holdReason}
                            </p>
                          ) : null}
                          <p className="mt-2 max-w-80 text-xs text-muted-foreground">
                            {row.postconditionHold}
                          </p>
                        </td>
                        <td className="p-3 text-xs text-muted-foreground">
                          <p>
                            Event #{row.id} · execution{" "}
                            {row.executionId ?? "none"}
                          </p>
                          <p>Source {row.sourceSnapshotHash.slice(0, 12)}…</p>
                          <p>
                            Preflight{" "}
                            {row.xeroPreflightHash?.slice(0, 12) ?? "none"}…
                          </p>
                          <p>
                            {row.authorisedPayload
                              ? "Immutable payload bound"
                              : "No write payload bound"}
                          </p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
