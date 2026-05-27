import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type PillKind = "status" | "channel" | "assignee" | "execution" | "runtime" | "role" | "count";

export type PillTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "inverse"
  | "muted"
  | "brand"
  | "blue"
  | "cyan"
  | "orange"
  | "green"
  | "pink"
  | "yellow"
  | "purple";

const toneClass: Record<PillTone, string> = {
  neutral: "border-border bg-background text-foreground",
  info: "border-[var(--status-info-border)] bg-[var(--status-info)] text-[var(--status-info-foreground)]",
  success: "border-[var(--status-success-border)] bg-[var(--status-success)] text-[var(--status-success-foreground)]",
  warning: "border-[var(--status-warning-border)] bg-[var(--status-warning)] text-[var(--status-warning-foreground)]",
  danger: "border-[var(--status-danger-border)] bg-[var(--status-danger)] text-[var(--status-danger-foreground)]",
  inverse: "border-foreground bg-foreground text-background",
  muted: "border-border bg-muted text-muted-foreground",
  brand: "border-[var(--brand-border)] bg-[var(--brand-soft)] text-[var(--brand-foreground)]",
  blue: "border-[var(--blue-border)] bg-[var(--blue-soft)] text-[var(--blue-foreground)]",
  cyan: "border-[var(--cyan-border)] bg-[var(--cyan-soft)] text-[var(--cyan-foreground)]",
  orange: "border-[var(--orange-border)] bg-[var(--orange-soft)] text-[var(--orange-foreground)]",
  green: "border-[var(--green-border)] bg-[var(--green-soft)] text-[var(--green-foreground)]",
  pink: "border-[var(--pink-border)] bg-[var(--pink-soft)] text-[var(--pink-foreground)]",
  yellow: "border-[var(--yellow-border)] bg-[var(--yellow-soft)] text-[var(--yellow-foreground)]",
  purple: "border-[var(--purple-border)] bg-[var(--purple-soft)] text-[var(--purple-foreground)]",
};

export function Pill({
  children,
  className,
  icon,
  kind = "status",
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  kind?: PillKind;
  title?: string;
  tone?: PillTone;
}) {
  return (
    <Badge
      className={cn(
        "h-6 min-w-0 max-w-full justify-start gap-1 rounded-full px-2 text-xs leading-4 whitespace-nowrap truncate",
        toneClass[tone],
        className,
      )}
      data-pill-kind={kind}
      data-pill-tone={tone}
      title={title}
      variant="outline"
    >
      {icon ? <span className="grid shrink-0 place-items-center [&>svg]:size-3" data-pill-icon="true">{icon}</span> : null}
      <span className="min-w-0 truncate">{children}</span>
    </Badge>
  );
}
