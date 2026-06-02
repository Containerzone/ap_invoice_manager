import { cn } from "@/lib/utils";
import { STATUS_CONFIG, type InvoiceStatus } from "@/lib/invoiceUtils";
import {
  Upload, Loader2, FileText, CheckCircle, AlertTriangle,
  MessageSquare, CheckCircle2,
} from "lucide-react";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Upload, Loader2, FileText, CheckCircle, AlertTriangle, MessageSquare, CheckCircle2,
};

interface StatusBadgeProps {
  status: InvoiceStatus | string;
  size?: "sm" | "md";
  className?: string;
}

export function StatusBadge({ status, size = "md", className }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status as InvoiceStatus] ?? {
    label: status,
    color: "text-gray-700",
    bg: "bg-gray-50 border-gray-200",
    icon: "FileText",
    step: 0,
  };

  const Icon = ICONS[config.icon] ?? FileText;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs",
        config.bg,
        config.color,
        className
      )}
    >
      <Icon className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5", status === "extracting" && "animate-spin")} />
      {config.label}
    </span>
  );
}
