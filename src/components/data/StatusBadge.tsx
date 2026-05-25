import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

const toneClass: Record<StatusTone, string> = {
  neutral: "border-border bg-secondary text-secondary-foreground",
  success: "border-[var(--status-success-border)] bg-[var(--status-success)] text-[var(--status-success-foreground)]",
  warning: "border-[var(--status-warning-border)] bg-[var(--status-warning)] text-[var(--status-warning-foreground)]",
  danger: "border-[var(--status-danger-border)] bg-[var(--status-danger)] text-[var(--status-danger-foreground)]",
  info: "border-[var(--status-info-border)] bg-[var(--status-info)] text-[var(--status-info-foreground)]",
};

export function StatusBadge({
  children,
  className,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  tone?: StatusTone;
}) {
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap", toneClass[tone], className)}>
      {children}
    </Badge>
  );
}
