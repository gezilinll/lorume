import type { ReactNode } from "react";
import { Pill, type PillTone } from "./Pill";

type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export function StatusBadge({
  children,
  className,
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  tone?: StatusTone;
}) {
  return (
    <Pill className={className} kind="status" title={title} tone={tone as PillTone}>
      {children}
    </Pill>
  );
}
