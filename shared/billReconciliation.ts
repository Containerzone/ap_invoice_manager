export type BillReconciliationSnapshot =
  | {
      outcome: "found";
      checkedAt: string;
      billId: string;
      billNumber: string;
      billStatus: string;
      contactName: string | null;
      currencyCode: string;
      subTotal: number;
      totalTax: number;
      total: number;
    }
  | {
      outcome: "not_found";
      checkedAt: string;
      error?: string;
    }
  | {
      outcome: "failed";
      checkedAt: string;
      error: string;
    };

export type BillReconciliationStatus =
  | "matched"
  | "amount_differs"
  | "not_pushed"
  | "needs_refresh"
  | "xero_bill_unavailable"
  | "refresh_failed";

export function parseBillReconciliationSnapshot(value: unknown): BillReconciliationSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.outcome === "found" && typeof snapshot.checkedAt === "string" && typeof snapshot.billId === "string" && typeof snapshot.billNumber === "string" && typeof snapshot.billStatus === "string" && typeof snapshot.total === "number") {
    return {
      outcome: "found",
      checkedAt: snapshot.checkedAt,
      billId: snapshot.billId,
      billNumber: snapshot.billNumber,
      billStatus: snapshot.billStatus,
      contactName: typeof snapshot.contactName === "string" ? snapshot.contactName : null,
      currencyCode: typeof snapshot.currencyCode === "string" ? snapshot.currencyCode : "AUD",
      subTotal: typeof snapshot.subTotal === "number" ? snapshot.subTotal : 0,
      totalTax: typeof snapshot.totalTax === "number" ? snapshot.totalTax : 0,
      total: snapshot.total,
    };
  }
  if (snapshot.outcome === "not_found" && typeof snapshot.checkedAt === "string") {
    return { outcome: "not_found", checkedAt: snapshot.checkedAt, error: typeof snapshot.error === "string" ? snapshot.error : undefined };
  }
  if (snapshot.outcome === "failed" && typeof snapshot.checkedAt === "string" && typeof snapshot.error === "string") {
    return { outcome: "failed", checkedAt: snapshot.checkedAt, error: snapshot.error };
  }
  return null;
}

export function getBillReconciliationState(input: {
  invoiceTotal: number | null;
  xeroFinalBillId: string | null;
  snapshot: BillReconciliationSnapshot | null;
}): { status: BillReconciliationStatus; difference: number | null } {
  if (!input.xeroFinalBillId) return { status: "not_pushed", difference: null };
  if (!input.snapshot) return { status: "needs_refresh", difference: null };
  if (input.snapshot.outcome === "not_found") return { status: "xero_bill_unavailable", difference: null };
  if (input.snapshot.outcome === "failed") return { status: "refresh_failed", difference: null };
  if (input.invoiceTotal === null || !Number.isFinite(input.invoiceTotal)) return { status: "amount_differs", difference: null };
  const difference = Math.round((input.invoiceTotal - input.snapshot.total) * 100) / 100;
  return { status: Math.abs(difference) <= 0.01 ? "matched" : "amount_differs", difference };
}
