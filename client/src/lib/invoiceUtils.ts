export type InvoiceStatus =
  | "uploaded"
  | "extracting"
  | "extracted"
  | "verified"
  | "under_budget"
  | "approved"
  | "flagged"
  | "queried"
  | "queried_2nd"
  | "queried_3rd"
  | "resolved"
  | "duplicate";

export const STATUS_CONFIG: Record<
  InvoiceStatus,
  { label: string; color: string; bg: string; icon: string; step: number }
> = {
  uploaded:   { label: "Uploaded",   color: "text-blue-700",   bg: "bg-blue-50 border-blue-200",   icon: "Upload",       step: 1 },
  extracting: { label: "Extracting", color: "text-cyan-700",   bg: "bg-cyan-50 border-cyan-200",   icon: "Loader2",      step: 2 },
  extracted:  { label: "Extracted",  color: "text-teal-700",   bg: "bg-teal-50 border-teal-200",   icon: "FileText",     step: 3 },
  verified:     { label: "Verified",     color: "text-green-700",   bg: "bg-green-50 border-green-200",   icon: "CheckCircle",  step: 4 },
  under_budget: { label: "Under Budget", color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", icon: "CheckCircle2", step: 4 },
  approved:     { label: "Approved",     color: "text-sky-700",     bg: "bg-sky-50 border-sky-200",         icon: "CheckCircle2", step: 4 },
  flagged:      { label: "Flagged",      color: "text-amber-700",   bg: "bg-amber-50 border-amber-200",     icon: "AlertTriangle",step: 4 },
  queried:     { label: "1st Query Sent", color: "text-purple-700",  bg: "bg-purple-50 border-purple-200",  icon: "MessageSquare", step: 5 },
  queried_2nd: { label: "2nd Query Sent", color: "text-orange-700",  bg: "bg-orange-50 border-orange-200",  icon: "MessageSquare", step: 5 },
  queried_3rd: { label: "3rd Query Sent", color: "text-red-700",     bg: "bg-red-50 border-red-200",        icon: "MessageSquare", step: 5 },
  resolved:    { label: "Resolved",       color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200", icon: "CheckCircle2",  step: 6 },
  duplicate:   { label: "Duplicate",      color: "text-red-700",     bg: "bg-red-50 border-red-200",         icon: "AlertTriangle", step: 0 },
};

export function formatCurrency(amount: number | string | null | undefined, currency = "AUD"): string {
  if (amount == null) return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(num);
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-AU", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

export function parseContainerNumbers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}
