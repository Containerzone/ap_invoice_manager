import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPORT_COLUMN_ORDER,
  filterReportRows,
  moveReportColumn,
  normalizeReportColumnOrder,
  reportDateKey,
  reportDateRangeForPreset,
} from "../client/src/lib/reportCustomisation";

describe("report customization helpers", () => {
  const rows = [
    { supplierName: "Vic Freight", invoiceDate: "2026-09-14" },
    { supplierName: "Pacific National", invoiceDate: "2026-08-31" },
    { supplierName: "Vic Freight", invoiceDate: "14-07-26" },
    { supplierName: "Vic Freight", invoiceDate: null },
  ];

  it("filters report rows by exact supplier and inclusive invoice date range", () => {
    expect(filterReportRows(rows, {
      supplier: "vic freight",
      fromDate: "2026-08-01",
      toDate: "2026-09-30",
    })).toEqual([{ supplierName: "Vic Freight", invoiceDate: "2026-09-14" }]);
  });

  it("treats legacy DD-MM-YY dates as filterable issue dates", () => {
    expect(reportDateKey("14-07-26")).toBe("2026-07-14");
    expect(filterReportRows(rows, { supplier: "", fromDate: "2026-07-01", toDate: "2026-07-31" })).toEqual([
      { supplierName: "Vic Freight", invoiceDate: "14-07-26" },
    ]);
  });

  it("normalizes saved column preferences and retains every known column", () => {
    expect(normalizeReportColumnOrder(["variance", "supplier", "removed"]))
      .toEqual(["variance", "supplier", "invoice", "invoiceAmount", "poTotal", "approval"]);
    expect(normalizeReportColumnOrder(null)).toEqual(DEFAULT_REPORT_COLUMN_ORDER);
  });

  it("reorders a column without losing other columns", () => {
    expect(moveReportColumn(DEFAULT_REPORT_COLUMN_ORDER, "variance", "invoice"))
      .toEqual(["variance", "invoice", "supplier", "invoiceAmount", "poTotal", "approval"]);
  });

  it("creates an inclusive last-30-days range", () => {
    expect(reportDateRangeForPreset("30d", new Date("2026-09-18T12:00:00Z")))
      .toEqual({ fromDate: "2026-08-20", toDate: "2026-09-18" });
  });
});
