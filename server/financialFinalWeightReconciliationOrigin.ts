import { financialSha256 } from "./financialProposalIntegrity";

/** The exact writer-verification error that creates a no-transport Xero-drift hold. */
export const FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON = "Exact Draft/contact/full-line Xero evidence changed since reservation";
const FINAL_WEIGHT_XERO_DRIFT_RECONCILIATION_HOLD_REASON = `${FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON}; reconciliation required.`;

export type FinalWeightReconciliationOriginal = {
  id: number;
  status: string;
  holdReason: string | null;
  executionId: number | null;
  invoiceNumber: string | null;
  xeroInvoiceId: string | null;
  sourceSnapshotHash: string;
  rulesSnapshotHash: string;
  xeroPreflightHash: string | null;
  sourceSnapshot: unknown;
  xeroPreflight: unknown;
  originalDraft: unknown;
  expectedDraft: unknown;
  originalDraftHash: string | null;
  expectedDraftHash: string | null;
};

export type FinalWeightReconciliationOrigin = "legacy_404" | "xero_drift";

/**
 * The hold is intentionally exact: accept the bare error class for manually
 * persisted historical evidence and the canonical sentence emitted by the
 * current writer-verification path, but no arbitrary substring or prose.
 */
export function isExactFinalWeightXeroDriftHoldReason(value: unknown): boolean {
  return value === FINAL_WEIGHT_XERO_DRIFT_HOLD_REASON || value === FINAL_WEIGHT_XERO_DRIFT_RECONCILIATION_HOLD_REASON;
}

/** Immutable subset bound into every separate recovery receipt. */
export function finalWeightReconciliationOriginalHash(event: FinalWeightReconciliationOriginal): string {
  return financialSha256({
    id: event.id,
    status: event.status,
    holdReason: event.holdReason,
    executionId: event.executionId,
    originalDraftHash: event.originalDraftHash,
    expectedDraftHash: event.expectedDraftHash,
  });
}

/** The original recovery contract's required immutable invoice identifiers and Draft hashes. */
export function hasExactFinalWeightReconciliationIdentifiers(event: FinalWeightReconciliationOriginal): boolean {
  return typeof event.invoiceNumber === "string" && event.invoiceNumber.length > 0 &&
    typeof event.xeroInvoiceId === "string" && event.xeroInvoiceId.length > 0 &&
    typeof event.originalDraftHash === "string" && event.originalDraftHash.length > 0 &&
    typeof event.expectedDraftHash === "string" && event.expectedDraftHash.length > 0;
}

/**
 * Only the immutable legacy-404 route or the exact current Xero-drift hold can
 * start a distinct recovery receipt. The two classes deliberately have opposite
 * execution-ID requirements, preventing arbitrary reconciliation holds.
 */
export function finalWeightReconciliationOrigin(event: FinalWeightReconciliationOriginal): FinalWeightReconciliationOrigin | null {
  if (event.status !== "reconciliation_required" || !hasExactFinalWeightReconciliationIdentifiers(event)) return null;
  if (/status code 404/i.test(String(event.holdReason ?? "")) && typeof event.executionId === "number" && event.executionId > 0) return "legacy_404";
  if (isExactFinalWeightXeroDriftHoldReason(event.holdReason) && event.executionId === null) return "xero_drift";
  return null;
}
