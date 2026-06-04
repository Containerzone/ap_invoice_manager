import { describe, expect, it } from "vitest";

// ── Staff approval threshold logic (mirrors routers.ts) ──────────────────────
function isWithinStaffThreshold(total: number, diff: number): boolean {
  if (total <= 500) return diff <= 30;
  if (total <= 1000) return diff <= 50;
  if (total <= 2000) return diff <= 100;
  return false; // > $2000 always requires admin
}

describe("Staff approval thresholds", () => {
  it("allows staff to approve when invoice ≤ $500 and diff ≤ $30", () => {
    expect(isWithinStaffThreshold(400, 30)).toBe(true);
    expect(isWithinStaffThreshold(500, 30)).toBe(true);
  });

  it("rejects staff approval when invoice ≤ $500 and diff > $30", () => {
    expect(isWithinStaffThreshold(400, 31)).toBe(false);
    expect(isWithinStaffThreshold(500, 50)).toBe(false);
  });

  it("allows staff to approve when invoice $501–$1000 and diff ≤ $50", () => {
    expect(isWithinStaffThreshold(501, 50)).toBe(true);
    expect(isWithinStaffThreshold(1000, 50)).toBe(true);
  });

  it("rejects staff approval when invoice $501–$1000 and diff > $50", () => {
    expect(isWithinStaffThreshold(501, 51)).toBe(false);
    expect(isWithinStaffThreshold(1000, 100)).toBe(false);
  });

  it("allows staff to approve when invoice $1001–$2000 and diff ≤ $100", () => {
    expect(isWithinStaffThreshold(1001, 100)).toBe(true);
    expect(isWithinStaffThreshold(2000, 100)).toBe(true);
  });

  it("rejects staff approval when invoice $1001–$2000 and diff > $100", () => {
    expect(isWithinStaffThreshold(1001, 101)).toBe(false);
    expect(isWithinStaffThreshold(2000, 200)).toBe(false);
  });

  it("always requires admin approval for invoices > $2000", () => {
    expect(isWithinStaffThreshold(2001, 0)).toBe(false);
    expect(isWithinStaffThreshold(5000, 1)).toBe(false);
  });

  it("allows staff approval with zero discrepancy at any threshold level", () => {
    expect(isWithinStaffThreshold(100, 0)).toBe(true);
    expect(isWithinStaffThreshold(750, 0)).toBe(true);
    expect(isWithinStaffThreshold(1500, 0)).toBe(true);
    // > $2000 still requires admin even with zero diff
    expect(isWithinStaffThreshold(2001, 0)).toBe(false);
  });
});

// ── Multi-PO deduplication helper ────────────────────────────────────────────
function deduplicatePoNumbers(poNumbers: string[]): string[] {
  return Array.from(new Set(poNumbers.map((p) => p.trim()).filter(Boolean)));
}

describe("Multi-PO number deduplication", () => {
  it("removes empty strings", () => {
    expect(deduplicatePoNumbers(["PO-001", "", "PO-002", ""])).toEqual(["PO-001", "PO-002"]);
  });

  it("removes duplicates", () => {
    expect(deduplicatePoNumbers(["PO-001", "PO-001", "PO-002"])).toEqual(["PO-001", "PO-002"]);
  });

  it("trims whitespace", () => {
    expect(deduplicatePoNumbers(["  PO-001  ", "PO-002 "])).toEqual(["PO-001", "PO-002"]);
  });

  it("handles up to 15 POs", () => {
    const input = Array.from({ length: 15 }, (_, i) => `PO-${String(i + 1).padStart(3, "0")}`);
    expect(deduplicatePoNumbers(input)).toHaveLength(15);
  });

  it("returns empty array for all-empty input", () => {
    expect(deduplicatePoNumbers(["", "  ", ""])).toEqual([]);
  });
});

// ── Date format helpers (mirrors InvoiceDetail.tsx) ───────────────────────────
import { format, parse, isValid } from "date-fns";

function toDisplayDate(isoOrRaw: string | null | undefined): string {
  if (!isoOrRaw) return "";
  if (/^\d{2}-\d{2}-\d{2}$/.test(isoOrRaw)) return isoOrRaw;
  const d = new Date(isoOrRaw);
  if (!isNaN(d.getTime())) return format(d, "dd-MM-yy");
  return isoOrRaw;
}

function toIsoDate(ddMMyy: string): string {
  if (!ddMMyy) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(ddMMyy)) return ddMMyy;
  const parsed = parse(ddMMyy, "dd-MM-yy", new Date());
  if (isValid(parsed)) return format(parsed, "yyyy-MM-dd");
  const parsed2 = parse(ddMMyy, "dd-MM-yyyy", new Date());
  if (isValid(parsed2)) return format(parsed2, "yyyy-MM-dd");
  return ddMMyy;
}

describe("Date display helpers", () => {
  it("converts ISO date to DD-MM-YY display format", () => {
    expect(toDisplayDate("2025-06-04")).toBe("04-06-25");
  });

  it("returns already-formatted DD-MM-YY unchanged", () => {
    expect(toDisplayDate("04-06-25")).toBe("04-06-25");
  });

  it("returns empty string for null/undefined", () => {
    expect(toDisplayDate(null)).toBe("");
    expect(toDisplayDate(undefined)).toBe("");
  });

  it("converts DD-MM-YY back to ISO", () => {
    expect(toIsoDate("04-06-25")).toBe("2025-06-04");
  });

  it("returns ISO unchanged when already in YYYY-MM-DD", () => {
    expect(toIsoDate("2025-06-04")).toBe("2025-06-04");
  });

  it("handles DD-MM-YYYY format", () => {
    expect(toIsoDate("04-06-2025")).toBe("2025-06-04");
  });
});
