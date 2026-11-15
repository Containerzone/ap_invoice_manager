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
  confirmedCoveredThrough: boolean;
  legacyRentalLineNumber: string;
  legacyRentalNetAmount: string;
  confirmedLegacyRental: boolean;
};

const emptyInput: HandoverInput = {
  exactContainerControl: "",
  manualPoNumber: "",
  coveredThrough: "",
  effectiveFrom: "",
  confirmedLatestCoverage: false,
  confirmedNoOtherFutureCoverage: false,
  confirmedCoveredThrough: false,
  legacyRentalLineNumber: "",
  legacyRentalNetAmount: "",
  confirmedLegacyRental: false,
};

// Bind every exact field value and Accounts attestation. The revision
// also rejects an old response when a user changes a value and changes it back.
const inputKey = (input: HandoverInput) =>
  JSON.stringify([
    input.exactContainerControl,
    input.manualPoNumber,
    input.coveredThrough,
    input.effectiveFrom,
    input.confirmedLatestCoverage,
    input.confirmedNoOtherFutureCoverage,
    input.confirmedCoveredThrough,
    input.legacyRentalLineNumber,
    input.legacyRentalNetAmount,
    input.confirmedLegacyRental,
  ]);
const legacyRentalAcknowledgement = (
  input: HandoverInput
): { confirmed: true; lineIndex: number; amount: number } | undefined => {
  if (!input.confirmedLegacyRental) return undefined;
  const lineNumber = Number(input.legacyRentalLineNumber);
  const amount = Number(input.legacyRentalNetAmount);
  if (
    !Number.isInteger(lineNumber) ||
    lineNumber < 1 ||
    lineNumber > 200 ||
    !Number.isFinite(amount) ||
    amount <= 0
  )
    return undefined;
  return { confirmed: true, lineIndex: lineNumber - 1, amount };
};
const toRequest = (input: HandoverInput) => {
  const lumpSumManual = legacyRentalAcknowledgement(input);
  return {
    exactContainerControl: input.exactContainerControl,
    manualPoNumber: input.manualPoNumber,
    coveredThrough: input.coveredThrough,
    effectiveFrom: input.effectiveFrom,
    confirmedLatestCoverage: input.confirmedLatestCoverage,
    confirmedNoOtherFutureCoverage: input.confirmedNoOtherFutureCoverage,
    confirmedCoveredThrough: input.confirmedCoveredThrough,
    ...(lumpSumManual ? { lumpSumManual } : {}),
  };
};
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
  const lumpSumManual = legacyRentalAcknowledgement(input);
  const hasValidLegacyInputs =
    !input.confirmedLegacyRental || Boolean(lumpSumManual);
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
      input.confirmedCoveredThrough &&
      hasValidLegacyInputs &&
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
      field !== "confirmedNoOtherFutureCoverage" &&
      field !== "confirmedCoveredThrough" &&
      field !== "confirmedLegacyRental"
    ) {
      next.confirmedLatestCoverage = false;
      next.confirmedNoOtherFutureCoverage = false;
      next.confirmedCoveredThrough = false;
      next.confirmedLegacyRental = false;
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
    if (!hasInputs || !hasValidLegacyInputs || checking || approve.isPending)
      return;
    const submitted = { ...currentInput.current };
    if (
      submitted.confirmedLegacyRental &&
      !legacyRentalAcknowledgement(submitted)
    )
      return;
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
      const data = await preview.mutateAsync(toRequest(submitted));
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
      !currentInput.current.confirmedCoveredThrough ||
      (currentInput.current.confirmedLegacyRental &&
        !legacyRentalAcknowledgement(currentInput.current)) ||
      verified.revision !== revision.current ||
      verified.key !== inputKey(currentInput.current)
    )
      return;
    const submittedRevision = revision.current;
    setApprovalError(null);
    try {
      await approve.mutateAsync({
        ...toRequest(currentInput.current),
        confirmedLatestCoverage: true,
        confirmedNoOtherFutureCoverage: true,
        confirmedCoveredThrough: true,
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
          an AP import or adoption of old POs. Mixed history is supported: an
          existing AP-created initial receipt remains immutable, while the
          latest manual extension may bridge coverage into a future period.
          Historical POs and AP receipts remain unmodified.
        </p>
        <p className="text-sm text-muted-foreground">
          Preview re-reads current source data and performs read-only Xero
          checks. No Xero writes, no PO creation and no recurring activation
          occur when previewing or saving. Future recurring activation is
          separate.
        </p>
        <p className="text-sm text-muted-foreground">
          The app checks the exact PO, supplier and any native hire dates. The
          PurchaseOrders API cannot reliably prove the full container PO series;
          unknown coverage or missing native description dates are not proof of
          a paid hire period. Accounts must explicitly provide the
          covered-through date and three separate attestations: this is the
          latest manual hire PO, no later or overlapping period already exists,
          and covered-through is the last hire date already paid/billed under
          that PO, not its issue date. These are human attestations, not
          automatic proof of complete history.
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
                placeholder="HC1911-1"
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
            also accepted. Accounts must enter the last hire date already
            paid/billed under the selected manual PO, even when its native
            description has no hire dates. Do not infer coverage from the PO
            issue date. All four inputs must be verified together.
          </p>
          <fieldset className="space-y-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">
              Optional — original fixed-sum rental acknowledgment
            </legend>
            <p
              id="manual-handover-legacy-help"
              className="text-xs text-muted-foreground"
            >
              Use only after reviewing the exact original rental line on the
              selected manual PO. Preserve the old fixed sum: enter its original
              line number and historical net amount (excluding GST), not a
              current or future amount or daily rate. This does not infer hire
              dates or a paid period, rewrite the old PO, or create a PO. Leave
              unchecked for the native hire-date flow.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">
                Original rental line number (1–200, starting at 1)
                <Input
                  type="number"
                  className="mt-1 font-mono"
                  value={input.legacyRentalLineNumber}
                  onChange={event =>
                    changeInput("legacyRentalLineNumber", event.target.value)
                  }
                  min={input.confirmedLegacyRental ? 1 : undefined}
                  max={input.confirmedLegacyRental ? 200 : undefined}
                  step={input.confirmedLegacyRental ? 1 : "any"}
                  aria-describedby="manual-handover-legacy-help"
                  autoComplete="off"
                  disabled={approve.isPending}
                  required={input.confirmedLegacyRental}
                />
              </label>
              <label className="text-sm font-medium">
                Historical fixed-sum rental net amount (AUD, excluding GST)
                <Input
                  type="number"
                  className="mt-1 font-mono"
                  value={input.legacyRentalNetAmount}
                  onChange={event =>
                    changeInput("legacyRentalNetAmount", event.target.value)
                  }
                  min={input.confirmedLegacyRental ? 0 : undefined}
                  step="any"
                  aria-describedby="manual-handover-legacy-help"
                  autoComplete="off"
                  disabled={approve.isPending}
                  required={input.confirmedLegacyRental}
                />
              </label>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={input.confirmedLegacyRental}
                onCheckedChange={checked =>
                  changeInput("confirmedLegacyRental", checked === true)
                }
                disabled={approve.isPending}
              />
              <span>
                I have reviewed this exact original fixed-sum rental line and
                amount; this is not the future daily rate.
              </span>
            </label>
            {!hasValidLegacyInputs && (
              <p role="alert" className="text-xs text-red-800">
                To preview or save with this acknowledgment, enter a whole line
                number from 1 to 200 and a finite historical net amount greater
                than zero. Otherwise, leave the optional acknowledgment
                unchecked.
              </p>
            )}
          </fieldset>
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
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={input.confirmedCoveredThrough}
              onCheckedChange={checked =>
                changeInput("confirmedCoveredThrough", checked === true)
              }
              disabled={approve.isPending}
            />
            <span>
              I confirm the covered-through date is the last hire date already
              paid/billed under the selected manual PO; it is not inferred from
              the PO issue date.
            </span>
          </label>
          <p className="text-xs text-muted-foreground">
            All three Accounts attestations are required to save. You may
            preview unchecked to inspect the held result. Changing any
            confirmation invalidates the preview and clears the separate
            manual-creation-stopped acknowledgement. Changing any text or
            numeric input also clears all three coverage confirmations and the
            optional legacy rental confirmation.
          </p>
          <Button
            type="submit"
            variant="outline"
            disabled={
              !hasInputs ||
              !hasValidLegacyInputs ||
              checking ||
              approve.isPending
            }
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
                  <dt className="text-xs text-muted-foreground">
                    Current checked supplier for the planned future period
                  </dt>
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
                    Manual coverage source
                  </dt>
                  <dd className="font-medium">
                    {plan.coverageSource === "native_description"
                      ? "Existing manual PO native description"
                      : "Accounts-attested covered-through date"}
                  </dd>
                  <dd className="text-xs text-muted-foreground">
                    {plan.manualPeriodStart ? (
                      <>
                        Native hire period starts{" "}
                        <BusinessText
                          value={formatSydneyDate(plan.manualPeriodStart)}
                        />
                      </>
                    ) : (
                      "No native hire-period start; Accounts supplies covered-through, not the PO issue date."
                    )}
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
            {plan && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {plan.coverageSource === "accounts_attested" && (
                  <>
                    Native description dates do not establish this coverage;
                    Accounts is accountable for the supplied covered-through
                    date.{" "}
                  </>
                )}
                Existing manual PO native descriptions and historical amounts
                are not rewritten to match the planned future period. Any
                historical description or amount mismatch must be reviewed, not
                treated as permission to edit old POs. An existing AP-created
                initial receipt remains immutable; the latest manual extension
                may bridge future coverage without AP import or adoption.
              </p>
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
                  Changing any confirmation invalidates the preview. Changing
                  any text or numeric input also clears all three Accounts
                  coverage attestations and the optional legacy rental
                  confirmation. This record establishes future coverage only; it
                  neither adopts old POs into the AP-created ledger nor starts
                  recurring creation. Existing AP-created initial receipts and
                  historical manual POs remain immutable.
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
                Operations POs and any existing AP-created initial receipt stay
                untouched; a latest manual extension may bridge future coverage
                without AP import or adoption. No PO is created and future
                recurring activation remains separate. Accounts has provided
                three separate human attestations: this is the latest manual
                hire PO, no later or overlapping period already exists, and
                covered-through is the last hire date already paid/billed under
                the selected manual PO, not inferred from its issue date. These
                are not automatic proof of the full PO series.
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
                {lumpSumManual && (
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      Explicit original fixed-sum rental acknowledgment
                    </dt>
                    <dd>
                      Original line{" "}
                      <BusinessText value={lumpSumManual.lineIndex + 1} /> ·
                      Historical net amount (excluding GST){" "}
                      <BusinessText value={money(lumpSumManual.amount)} />
                    </dd>
                    <dd className="text-xs text-muted-foreground">
                      Original fixed sum only, not the current or future daily
                      rate. The historical PO stays unchanged; no PO is created.
                    </dd>
                  </div>
                )}
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
                    Coverage source
                  </dt>
                  <dd>
                    {plan.coverageSource === "native_description"
                      ? "Existing manual PO native description"
                      : "Accounts-attested covered-through date"}
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
