import { useState } from "react";
import { FileSearch, FileText, LockKeyhole } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
const money = (v: unknown) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(
    Number(v ?? 0)
  );
export default function ExtraHireInvoices() {
  const [deal, setDeal] = useState("");
  const [selected, setSelected] = useState("");
  const readiness =
    trpc.financialOperations.extraHireInvoiceReadiness.useQuery();
  const events = trpc.financialOperations.extraHireInvoiceEvents.useQuery({
    limit: 100,
  });
  const preview = trpc.financialOperations.previewExtraHireInvoice.useQuery(
    { exactDeal: selected },
    {
      enabled: Boolean(selected),
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 0,
    }
  );
  const result = preview.data;
  const document = result?.preview.document;
  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <FileText className="h-6 w-6" />
            Extra Hire Invoices
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Named current Deal → isolated Extra Hire customer Draft readiness.
            Event-driven; no recurring Heartbeat.
          </p>
        </div>
        <Badge variant="outline">
          {readiness.data?.writerEnabled
            ? "Independent receiver released"
            : "Default off — no Draft writes"}
        </Badge>
      </header>
      <Card>
        <CardContent className="space-y-3 p-5 text-sm">
          <p className="flex items-center gap-2 font-semibold">
            <LockKeyhole className="h-4 w-4" />
            Read-only administrator workspace. No browser release or write
            control.
          </p>
          <p>
            AUD · ACCREC · DRAFT · GST exclusive · 4.286 weeks · exact current{" "}
            <code>20' Hire</code> / <code>40' Hire</code> sales item evidence.
            Baseline rates 45 / 70 and account 210 are never substituted for
            missing exact evidence.
          </p>
          <p>
            <code>INV-&lt;Deal digits&gt;-EH&lt;exact AP ordinal&gt;</code>{" "}
            requires independent suffix approval. Deposit owns <code>-D</code>.
            Any exact historical collision, including deleted/voided, holds
            without adoption or suffix skipping.
          </p>
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
            Hire End Date +30 calendar days is a separate held postcondition. No
            Extra Hire CRM action is queued or written by this readiness
            migration, even if storage/global post-success is enabled.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Independent release boundary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <code className="break-all">
            {readiness.data?.webhookPath ??
              "/api/webhooks/vtiger/extra-hire-invoice"}
          </code>
          <p>
            Receiver requires its dedicated flag and approved new-events-only
            policy: Extra Hire branch, Operations writer handover, exact source
            mappings, suffix/collision scheme, isolated Draft-only and separate
            Hire End Date acknowledgment.
          </p>
          {readiness.data?.releaseHoldReason && (
            <p className="text-amber-900">{readiness.data.releaseHoldReason}</p>
          )}
          {readiness.error && (
            <p role="alert" className="text-red-700">
              Readiness unavailable. Treat the family as unreleased.
            </p>
          )}
          <details>
            <summary>Current policy and separate postcondition</summary>
            <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(readiness.data, null, 2)}
            </pre>
          </details>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSearch className="h-4 w-4" />
            Current source / Xero GET-only preview
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter one exact Deal number or webservice ID. AP re-describes
            Potentials, re-reads the named Deal and linked customer, then reads
            exact Xero contact/item/account/history and AP-only claims. Preview
            saves nothing. Missing or ambiguous mappings/date semantics remain
            held.
          </p>
          <div className="flex gap-2">
            <Input
              aria-label="Exact Extra Hire Deal"
              value={deal}
              onChange={e => {
                setDeal(e.target.value);
                setSelected("");
              }}
              placeholder="D702877 or 5x12345"
            />
            <Button
              disabled={
                !/^(D\d{1,12}|\d+x\d{1,12})$/i.test(deal.trim()) ||
                preview.isFetching
              }
              onClick={() => {
                const v = deal.trim().replace(/^d/i, "D");
                if (v === selected) void preview.refetch();
                else setSelected(v);
              }}
            >
              {preview.isFetching ? "Reading evidence…" : "Preview evidence"}
            </Button>
          </div>
          {selected && preview.error && (
            <p role="alert" className="text-sm text-red-700">
              {preview.error.message}
            </p>
          )}
          {selected && result && (
            <div className="space-y-3 rounded-lg border p-4 text-sm">
              <div className="flex justify-between gap-2">
                <strong>
                  {result.facts.dealNumber} ·{" "}
                  {result.facts.customerName || "Customer unresolved"}
                </strong>
                <Badge
                  variant={result.state === "held" ? "destructive" : "outline"}
                >
                  {result.state === "held"
                    ? "Held — no write"
                    : "Evidence only"}
                </Badge>
              </div>
              {result.holdReason && (
                <p className="rounded-md bg-amber-50 p-3 text-amber-900">
                  {result.holdReason}
                </p>
              )}
              <p>
                {result.facts.containerNumber || "No container"} ·{" "}
                {result.facts.containerType || "Type unresolved"} · duration{" "}
                {result.facts.hireDuration ?? "unresolved"} days · current end{" "}
                {result.facts.hireEndDate ?? "unresolved"}
              </p>
              {document && (
                <div className="rounded-md bg-muted p-3">
                  <strong className="font-mono">
                    {document.proposedDocumentNumber}
                  </strong>
                  <p>
                    {money(document.subtotal)} net + {money(document.taxAmount)}{" "}
                    GST = {money(document.total)} · account{" "}
                    {document.accountCode} · 4.286 ×{" "}
                    {money(document.lineItems[0]?.unitAmount)}
                  </p>
                  <p>{document.lineItems[0]?.description}</p>
                </div>
              )}
              <details>
                <summary>
                  Exact current mapping / source / preflight evidence
                </summary>
                <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Immutable AP Extra Hire lifecycle receipts
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Current protected receiver receipts only. Shadow extraHireRuns rows
            never count as live claims.
          </p>
        </CardHeader>
        <CardContent>
          {events.error ? (
            <p role="alert" className="text-sm text-red-700">
              AP ledger unavailable. The generated migration must be
              reviewed/applied separately; no lifecycle state can be assumed.
            </p>
          ) : events.isLoading ? (
            <p>Loading AP receipts…</p>
          ) : !events.data?.length ? (
            <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
              No AP Extra Hire event receipt recorded.
            </p>
          ) : (
            <div className="space-y-3">
              {events.data.map(row => (
                <div key={row.id} className="rounded-md border p-4 text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>
                      {row.dealNumber} ·{" "}
                      {row.customerName || "unresolved customer"}
                    </strong>
                    <Badge variant="outline">
                      {row.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <p className="mt-2 font-mono">
                    {row.proposedInvoiceNumber || "Suffix held"} · ordinal{" "}
                    {row.ordinal ?? "unresolved"} · source end{" "}
                    {row.sourceHireEndDate || "unresolved"}
                  </p>
                  {row.holdReason && (
                    <p className="mt-2 text-amber-900">{row.holdReason}</p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Event #{row.id} · execution {row.executionId ?? "none"} ·
                    Xero exact Draft {row.xeroInvoiceId ?? "not verified"} ·
                    source {row.sourceSnapshotHash.slice(0, 12)}… ·{" "}
                    {row.authorisedPayload
                      ? "Immutable payload bound"
                      : "No write payload"}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {row.postconditionHold}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
