export type ReportColumnId = "invoice" | "supplier" | "invoiceAmount" | "poTotal" | "variance" | "approval";

export type ReportColumnDefinition = {
  id: ReportColumnId;
  label: string;
  minWidth: string;
  align?: "left" | "right";
};

export const REPORT_COLUMNS: ReportColumnDefinition[] = [
  { id: "invoice", label: "Invoice", minWidth: "minmax(10rem, 1.25fr)" },
  { id: "supplier", label: "Supplier", minWidth: "minmax(11rem, 1fr)" },
  { id: "invoiceAmount", label: "Invoice Amt", minWidth: "7.5rem", align: "right" },
  { id: "poTotal", label: "Current PO", minWidth: "7.5rem", align: "right" },
  { id: "variance", label: "Net Diff", minWidth: "8rem", align: "right" },
  { id: "approval", label: "Approval", minWidth: "7.5rem" },
];

export const DEFAULT_REPORT_COLUMN_ORDER = REPORT_COLUMNS.map((column) => column.id);

export type ReportFilterRow = {
  supplierName: string | null;
  invoiceDate: string | null;
};

export type ReportFilters = {
  supplier: string;
  fromDate: string;
  toDate: string;
};

/** Converts supported stored invoice-date values to a local YYYY-MM-DD key. */
export function reportDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const shortDate = trimmed.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (shortDate) return `20${shortDate[3]}-${shortDate[2]}-${shortDate[1]}`;
  return null;
}

export function filterReportRows<T extends ReportFilterRow>(rows: T[], filters: ReportFilters): T[] {
  const supplier = filters.supplier.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const rowDate = reportDateKey(row.invoiceDate);
    const rowSupplier = row.supplierName?.trim().toLocaleLowerCase() ?? "";
    if (supplier && rowSupplier !== supplier) return false;
    if (filters.fromDate && (!rowDate || rowDate < filters.fromDate)) return false;
    if (filters.toDate && (!rowDate || rowDate > filters.toDate)) return false;
    return true;
  });
}

export function normalizeReportColumnOrder(value: unknown): ReportColumnId[] {
  if (!Array.isArray(value)) return [...DEFAULT_REPORT_COLUMN_ORDER];
  const allowed = new Set<ReportColumnId>(DEFAULT_REPORT_COLUMN_ORDER);
  const unique = value.filter((entry): entry is ReportColumnId => typeof entry === "string" && allowed.has(entry as ReportColumnId));
  const remaining = DEFAULT_REPORT_COLUMN_ORDER.filter((id) => !unique.includes(id));
  return [...unique, ...remaining];
}

export function moveReportColumn(order: ReportColumnId[], source: ReportColumnId, destination: ReportColumnId): ReportColumnId[] {
  if (source === destination) return order;
  const next = order.filter((id) => id !== source);
  const destinationIndex = next.indexOf(destination);
  if (destinationIndex < 0) return order;
  next.splice(destinationIndex, 0, source);
  return next;
}

export function reportDateRangeForPreset(preset: "month" | "30d" | "90d", now = new Date()): Pick<ReportFilters, "fromDate" | "toDate"> {
  const format = (date: Date) => date.toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const start = new Date(end);
  if (preset === "month") start.setUTCDate(1);
  else start.setUTCDate(start.getUTCDate() - (preset === "30d" ? 29 : 89));
  return { fromDate: format(start), toDate: format(end) };
}
