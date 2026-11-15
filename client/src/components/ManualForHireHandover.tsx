import { useRef, useState, type FormEvent } from "react";
import { AlertTriangle, ClipboardCheck, LockKeyhole } from "lucide-react";
import { BusinessText } from "@/components/BusinessReferenceDisplay";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatSydneyDate } from "@/lib/dateFormat";
import { trpc } from "@/lib/trpc";

type HandoverInput = {
  exactContainerControl: string;
  manualPoNumber: string;
  coveredThrough: string;
  effectiveFrom: string;
  confirmedLatestCoverage: boolean;
  confirmedNoOtherFutureCoverage: boolean;
};

const emptyInput: HandoverInput = {
  exactContainerControl: "",
  manualPoNumber: "",
  coveredThrough: "",
  effectiveFrom: "",
  confirmedLatestCoverage: false,
  confirmedNoOtherFutureCoverage: false,
};

// Bind all four exact field values and the Accounts attestation. The revision
// also rejects an old response when a user changes a value and changes it back.
const inputKey = (input: HandoverInput) =>
  JSON.stringify([
    input.exactContainerControl,
    input.manualPoNumber,
    input.coveredThrough,
    input.effectiveFrom,
    input.confirmedLatestCoverage,
    input.confirmedNoOtherFutureCoverage,
  ]);
const money = (value: number) =>
  new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
  }).format(value);
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export function ManualForHireHandover() {
  const readiness = trpc.manualForHireHandover.readiness.useQuery();
  const records = trpc.manualForHireHandover.list.useQuery({ limit: 100 });
  const preview = trpc.manualForHireHandover.preview.useMutation();
  const approve = trpc.manualForHireHandover.approve.useMutation();
  const [input, setInput] = useState<HandoverInput>(emptyInput);
  const currentInput = useRef(input);
  const revision = useRef(0);
  const [verified, setVerified] = useState<{
    key: string;
    revision: number;
    data: NonNullable<typeof preview.data>;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [manualCreationStopped, setManualCreationStopped] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const key = inputKey(input);
  const result =
    verified?.key === key && verified.revision === revision.current
      ? verified.data
      : null;
  const plan = result?.plan;
  const enrollmentEnabled =
    readiness.data?.implementationReady === true &&
    readiness.data.enrollmentEnabled === true &&
    !readiness.error;
  const canApprove = Boolean(
    enrollmentEnabled &&
      !readiness.isFetching &&
      result?.enrollmentEnabled === true &&
      result.state === "ready" &&
      result.noFinancialWrites === true &&
      plan?.planHash &&
      input.confirmedLatestCoverage &&
      input.confirmedNoOtherFutureCoverage &&
      manualCreationStopped &&
      !checking &&
      !approve.isPending &&
      !saved
  );
  const hasInputs = [
    input.exactContainerControl,
    input.manualPoNumber,
    input.coveredThrough,
    input.effectiveFrom,
  ].every(value => value.trim().length > 0);

  function changeInput<K extends keyof HandoverInput>(
    field: K,
    value: HandoverInput[K]
  ) {
    if (approve.isPending) return;
    const next = { ...currentInput.current, [field]: value };
    if (
      field !== "confirmedLatestCoverage" &&
      field !== "confirmedNoOtherFutureCoverage"
    ) {
      next.confirmedLatestCoverage = false;
      next.confirmedNoOtherFutureCoverage = false;
    }
    currentInput.current = next;
    revision.current += 1;
    setInput(next);
    setVerified(null);
    setManualCreationStopped(false);
    setConfirmationOpen(false);
    setPreviewError(null);
    setApprovalError(null);
    setSaved(false);
    setChecking(false);
    preview.reset();
    approve.reset();
  }

  async function previewHandover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasInputs || checking || approve.isPending) return;
    const submitted = { ...currentInput.current };
    const submittedKey = inputKey(submitted);
    const submittedRevision = ++revision.current;
    setVerified(null);
    setManualCreationStopped(false);
    setConfirmationOpen(false);
    setPreviewError(null);
    setApprovalError(null);
    setSaved(false);
    setChecking(true);
    preview.reset();
    approve.reset();
    const isCurrent = () =>
      revision.current === submittedRevision &&
      inputKey(currentInput.current) === submittedKey;
    try {
      const data = await preview.mutateAsync(submitted);
      if (isCurrent())
        setVerified({ key: submittedKey, revision: submittedRevision, data });
    } catch (error) {
      if (isCurrent())
        setPreviewError(
          errorMessage(
            error,
            "Manual handover preview could not be checked. No PO was created."
          )
        );
    } finally {
      if (isCurrent()) setChecking(false);
    }
  }

  async function saveHandover() {
    // Re-check at the confirmation action, including the synchronous input ref.
    if (
      !canApprove ||
      !confirmationOpen ||
      !verified ||
      !plan ||
      !currentInput.current.confirmedLatestCoverage ||
      !currentInput.current.confirmedNoOtherFutureCoverage ||
      verified.revision !== revision.current ||
      verified.key !== inputKey(currentInput.current)
    )
      return;
    const submittedRevision = revision.current;
    setApprovalError(null);
    try {
      await approve.mutateAsync({
        ...currentInput.current,
        confirmedLatestCoverage: true,
        confirmedNoOtherFutureCoverage: true,
        expectedPlanHash: plan.planHash,
        manualCreationStopped: true,
        acknowledgement: "FUTURE_ONLY_MANUAL_PO_HANDOVER",
      });
      if (revision.current === submittedRevision) {
        setSaved(true);
        setManualCreationStopped(false);
        setConfirmationOpen(false);
        setVerified(null);
      }
      // A successful enrollment is a local handover record, not a Xero receipt.
      void records.refetch();
      void readiness.refetch();
    } catch (error) {
      if (revision.current === submittedRevision) {
        setApprovalError(
          errorMessage(
            error,
            "The handover was not saved. Preview again before retrying."
          )
        );
        setConfirmationOpen(false);
        setVerified(null);
        setManualCreationStopped(false);
        preview.reset();
      }
    }
  }

  return (
    <Card className="border-sky-200 bg-sky-50/30">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4" />
            Manual / Operations For Hire handover
          </CardTitle>
          <Badge
            variant="outline"
            className={
              enrollmentEnabled
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-900"
            }
          >
            {readiness.isLoading
              ? "Default-off — checking enrollment"
              : enrollmentEnabled
                ? "Default-off gate — enrollment enabled"
                : "Default-off — enrollment disabled"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Verify an existing manually created / Operations PO and record a
          future-only handover. This is a separate manual handover record, not
          AP-created PO history; historical POs remain unmodified.
        </p>
        <p className="text-sm text-muted-foreground">
          Preview re-reads current source data and performs read-only Xero
          checks. No Xero writes, no PO creation and no recurring activation
          occur when previewing or saving. Future recurring activation is
          separate.
        </p>
        <p className="text-sm text-muted-foreground">
          The app checks the exact PO, supplier and dates. The PurchaseOrders
          API cannot reliably prove the full container PO series: Accounts must
          provide two separate attestations: this is the latest manual hire PO
          and no later or overlapping period already exists. These are explicit
          human attestations, not automatic proof of complete coverage history.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {readiness.isLoading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading manual handover readiness… Preview remains read-only;
            approval is unavailable until readiness is verified.
          </p>
        )}
        {readiness.error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <p>
              Manual handover readiness could not be loaded. Approval is
              disabled; do not infer that enrollment or recurring creation is
              enabled.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void readiness.refetch()}
              disabled={readiness.isFetching}
            >
              Retry readiness
            </Button>
          </div>
        )}
        {!readiness.isLoading && !enrollmentEnabled && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
            Enrollment is default-off and controlled by the server. You may
            check a read-only preview, but saving a handover is disabled. Saving
            does not enable the separately controlled recurring writer.
          </p>
        )}

        <form onSubmit={previewHandover} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm font-medium">
              Container Control (C number or VTiger wsid)
              <Input
                type="text"
                className="mt-1 font-mono"
                value={input.exactContainerControl}
                onChange={event =>
                  changeInput("exactContainerControl", event.target.value)
                }
                placeholder="C1911"
                autoComplete="off"
                maxLength={40}
                disabled={approve.isPending}
                required
              />
            </label>
            <label className="text-sm font-medium">
              Last manual PO number (HC# or HC#-N)
              <Input
                type="text"
                className="mt-1 font-mono"
                value={input.manualPoNumber}
                onChange={event =>
                  changeInput("manualPoNumber", event.target.value)
                }
                placeholder="HC1911-2"
                autoComplete="off"
                maxLength={60}
                disabled={approve.isPending}
                required
              />
            </label>
            <label className="text-sm font-medium">
              Manual coverage through (DD/MM/YY)
              <Input
                type="text"
                className="mt-1 font-mono"
                value={input.coveredThrough}
                onChange={event =>
                  changeInput("coveredThrough", event.target.value)
                }
                placeholder="30/11/26"
                aria-describedby="manual-handover-date-help"
                autoComplete="off"
                maxLength={32}
                disabled={approve.isPending}
                required
              />
            </label>
            <label className="text-sm font-medium">
              Effective from (DD/MM/YY)
              <Input
                type="text"
                className="mt-1 font-mono"
                value={input.effectiveFrom}
                onChange={event =>
                  changeInput("effectiveFrom", event.target.value)
                }
                placeholder="01/12/26"
                aria-describedby="manual-handover-date-help"
                autoComplete="off"
                maxLength={32}
                disabled={approve.isPending}
                required
              />
            </label>
          </div>
          <p
            id="manual-handover-date-help"
            className="text-xs text-muted-foreground"
          >
            Australian date order: DD/MM/YY or DD/MM/YYYY; ISO YYYY-MM-DD is
            also accepted. Enter the last date already covered by the manual PO.
            All four inputs must be verified together.
          </p>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={input.confirmedLatestCoverage}
              onCheckedChange={checked =>
                changeInput("confirmedLatestCoverage", checked === true)
              }
              disabled={approve.isPending}
            />
            <span>
              I confirm this is the latest manual hire PO for this container.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={input.confirmedNoOtherFutureCoverage}
              onCheckedChange={checked =>
                changeInput("confirmedNoOtherFutureCoverage", checked === true)
              }
              disabled={approve.isPending}
            />
            <span>
              I confirm no later or overlapping hire period has already been
              created for this container.
            </span>
          </label>
          <p className="text-xs text-muted-foreground">
            Both Accounts attestations are required to save. You may preview
            unchecked to inspect the held result. Changing either confirmation
            invalidates the preview; changing any of the four inputs also clears
            both confirmations and the separate manual-creation-stopped
            acknowledgement.
          </p>
          <Button
            type="submit"
            variant="outline"
            disabled={!hasInputs || checking || approve.isPending}
          >
            {checking
              ? "Checking manual handover…"
              : "Preview verified handover — read only"}
          </Button>
        </form>
        {checking && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking the exact container, manual PO, coverage and future period.
            No financial writes.
          </p>
        )}
        {previewError && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <BusinessText value={previewError} />
          </p>
        )}
        {approvalError && (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <BusinessText value={approvalError} /> Re-check all four inputs with
            a fresh preview before saving.
          </p>
        )}
        {saved && (
          <p
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
          >
            Verified handover saved as a separate manual history record. No PO
            was created, no historical PO was changed, and future recurring
            activation remains separate.
          </p>
        )}
        {!result && !checking && !previewError && !approvalError && !saved && (
          <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No current verified preview. Enter all four values and preview
            before acknowledging or saving.
          </p>
        )}

        {result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={
                  result.state === "ready"
                    ? "border-sky-200 bg-sky-50 text-sky-800"
                    : "border-amber-200 bg-amber-50 text-amber-900"
                }
              >
                {result.state === "ready"
                  ? "Verified preview — no financial writes"
                  : "Held — handover cannot be saved"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Manual history only · Future activation separate
              </span>
            </div>
            {result.holdReason && (
              <div
                role="alert"
                className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
              >
                <p className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Handover held
                </p>
                <p className="mt-1">
                  <BusinessText value={result.holdReason} />
                </p>
              </div>
            )}
            {plan && (
              <dl className="grid gap-3 rounded-lg border bg-background p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Exact Container Control
                  </dt>
                  <dd className="font-mono font-medium">
                    <BusinessText value={plan.containerControlNumber} />
                  </dd>
                  <dd className="text-xs text-muted-foreground">
                    <BusinessText value={plan.containerNumber} /> ·{" "}
                    <BusinessText value={plan.containerType} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Existing manual PO / status
                  </dt>
                  <dd className="font-mono font-medium">
                    <BusinessText value={plan.manualPoNumber} />
                  </dd>
                  <dd className="text-xs text-muted-foreground">
                    <BusinessText value={plan.manualPoStatus} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Supplier</dt>
                  <dd>
                    <BusinessText value={plan.supplierName} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Last manually covered date
                  </dt>
                  <dd className="font-medium">
                    <BusinessText
                      value={formatSydneyDate(plan.coveredThrough)}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    First future period / next billing
                  </dt>
                  <dd className="font-medium">
                    <BusinessText
                      value={formatSydneyDate(plan.nextPeriodStart)}
                    />
                    –
                    <BusinessText
                      value={formatSydneyDate(plan.nextPeriodEnd)}
                    />
                  </dd>
                  <dd className="text-xs text-muted-foreground">
                    Effective from{" "}
                    <BusinessText
                      value={formatSydneyDate(plan.effectiveFrom)}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Next future PO number (not created)
                  </dt>
                  <dd className="font-mono font-medium">
                    <BusinessText value={plan.nextPoNumber} />
                  </dd>
                </div>
              </dl>
            )}
            {result.proposal && (
              <div className="rounded-lg border bg-background p-4 text-sm">
                <p className="font-medium">
                  Indicative next-period amount at the current checked purchase
                  rate
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Read-only illustration, not a fixed future price or a created
                  PO. The separately activated recurring writer must re-check
                  the current rate and eligibility when a period is due.
                </p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
                  {result.proposal.lineItems.map((line, index) => (
                    <p key={index}>
                      <BusinessText value={line.itemCode} /> · Qty{" "}
                      <BusinessText value={line.quantity} /> ×{" "}
                      <BusinessText value={money(line.unitAmount)} />
                    </p>
                  ))}
                </div>
                <p className="mt-2 tabular-nums">
                  Ex GST{" "}
                  <BusinessText value={money(result.proposal.subtotal)} /> · GST{" "}
                  <BusinessText value={money(result.proposal.taxAmount)} /> ·
                  Indicative total{" "}
                  <strong>
                    <BusinessText value={money(result.proposal.total)} />
                  </strong>
                </p>
              </div>
            )}
            {result.state === "ready" && plan && (
              <div className="space-y-3 rounded-lg border p-4">
                {!result.enrollmentEnabled && (
                  <p className="text-sm text-amber-900">
                    This preview reports enrollment disabled. It cannot be
                    saved; request a fresh preview after the server-controlled
                    gate changes.
                  </p>
                )}
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={manualCreationStopped}
                    onCheckedChange={checked => {
                      setManualCreationStopped(checked === true);
                      setConfirmationOpen(false);
                    }}
                    disabled={approve.isPending || checking}
                  />
                  <span>
                    I have stopped manual/Operations recurring creation for this
                    container; leave older POs untouched.
                  </span>
                </label>
                <p className="text-xs text-muted-foreground">
                  Changing any input clears the preview and both attestations.
                  This record establishes future coverage only; it neither
                  adopts old POs into the AP-created ledger nor starts recurring
                  creation.
                </p>
                <Button
                  type="button"
                  disabled={!canApprove}
                  onClick={() => setConfirmationOpen(true)}
                >
                  Save verified handover — no PO creation
                </Button>
                {!manualCreationStopped && (
                  <p className="text-xs text-muted-foreground">
                    Confirm that manual / Operations recurring creation has
                    stopped before saving.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <AlertDialog
          open={confirmationOpen && Boolean(plan)}
          onOpenChange={open => {
            if (!approve.isPending) setConfirmationOpen(open);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Confirm future-only manual handover
              </AlertDialogTitle>
              <AlertDialogDescription>
                Save only the verified handover record below. Older manual /
                Operations POs stay untouched. No PO is created and future
                recurring activation remains separate. Accounts has provided two
                separate human attestations: this is the latest manual hire PO,
                and no later or overlapping period already exists. These are not
                automatic proof of the full PO series.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {plan && (
              <dl className="space-y-2 rounded-lg border p-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Exact Container Control
                  </dt>
                  <dd className="font-mono font-semibold">
                    <BusinessText value={plan.containerControlNumber} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Last manual PO
                  </dt>
                  <dd className="font-mono">
                    <BusinessText value={plan.manualPoNumber} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Last covered date
                  </dt>
                  <dd>
                    <BusinessText
                      value={formatSydneyDate(plan.coveredThrough)}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    First future period
                  </dt>
                  <dd>
                    <BusinessText
                      value={formatSydneyDate(plan.nextPeriodStart)}
                    />
                    –
                    <BusinessText
                      value={formatSydneyDate(plan.nextPeriodEnd)}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Effective from
                  </dt>
                  <dd>
                    <BusinessText
                      value={formatSydneyDate(plan.effectiveFrom)}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    Next future PO number — not created
                  </dt>
                  <dd className="font-mono">
                    <BusinessText value={plan.nextPoNumber} />
                  </dd>
                </div>
              </dl>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={approve.isPending}>
                Cancel
              </AlertDialogCancel>
              <Button
                type="button"
                disabled={!canApprove}
                onClick={() => void saveHandover()}
              >
                {approve.isPending
                  ? "Saving handover record…"
                  : "Confirm save — no PO creation"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <div className="space-y-3 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">
                Separate manual handover records
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Not AP-created PO receipts. Historical manual / Operations POs
                remain unmodified.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={records.isFetching}
              onClick={() => void records.refetch()}
            >
              {records.isFetching ? "Refreshing…" : "Refresh records"}
            </Button>
          </div>
          {records.isLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading manual handover records…
            </p>
          ) : records.error ? (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              Manual handover records could not be loaded. Use Refresh records
              to retry.
            </p>
          ) : !records.data?.length ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No verified manual handover records have been saved.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-3">Container Control</th>
                    <th className="p-3">Last manual PO</th>
                    <th className="p-3">Covered through</th>
                    <th className="p-3">Next billing</th>
                    <th className="p-3">State</th>
                    <th className="p-3">Approved</th>
                  </tr>
                </thead>
                <tbody>
                  {records.data.map(row => (
                    <tr
                      key={row.id}
                      className="border-b align-top last:border-0"
                    >
                      <td className="p-3 font-mono font-medium">
                        <BusinessText value={row.containerControlNumber} />
                      </td>
                      <td className="p-3 font-mono">
                        <BusinessText value={row.manualPoNumber} />
                      </td>
                      <td className="p-3">
                        <BusinessText
                          value={formatSydneyDate(row.coveredThrough)}
                        />
                      </td>
                      <td className="p-3">
                        <BusinessText
                          value={formatSydneyDate(row.nextBillingDate)}
                        />
                      </td>
                      <td className="p-3">
                        <Badge variant="outline">
                          <BusinessText
                            value={row.status.replaceAll("_", " ")}
                          />
                        </Badge>
                        {row.holdReason && (
                          <p className="mt-2 max-w-72 text-xs text-muted-foreground">
                            <BusinessText value={row.holdReason} />
                          </p>
                        )}
                      </td>
                      <td className="p-3">
                        <BusinessText
                          value={formatSydneyDate(
                            row.approvedAt,
                            "Not approved"
                          )}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
