import type { ReactNode } from "react";
import { Bot, Server, ShieldCheck, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/data/StatusBadge";

/** Static operational preview for the auth entry screen. */
export function AuthOperationsPreview() {
  return (
    <section className="grid gap-5" aria-label="运营概览">
      <div className="border-b border-border pb-4">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">运营概览</span>
      </div>
      <AuthPreviewRow
        command="$ runtimes list --all"
        Icon={Server}
        label="Runtime Fleet"
        metric={<><span className="text-[var(--status-success-foreground)]">在线 5</span><span>离线 0</span><span>异常 0</span></>}
        status={<StatusBadge tone="success">在线</StatusBadge>}
      />
      <AuthPreviewRow
        command="$ runs stats --window=24h"
        Icon={Bot}
        label="Runs"
        metric={<><span>总数 1,248</span><span className="text-[var(--status-success-foreground)]">成功 96.3%</span><span className="text-destructive">失败 3.7%</span></>}
        status={<StatusBadge tone="warning">工作中</StatusBadge>}
      />
      <AuthPreviewRow
        command="$ collectors health"
        Icon={ShieldCheck}
        label="采集健康"
        metric={<><span className="text-[var(--status-success-foreground)]">健康 23</span><span>警告 1</span><span>异常 0</span></>}
        status={<StatusBadge tone="success">健康</StatusBadge>}
      />
    </section>
  );
}

function AuthPreviewRow({
  command,
  Icon,
  label,
  metric,
  status,
}: {
  command: string;
  Icon: LucideIcon;
  label: string;
  metric: ReactNode;
  status: ReactNode;
}) {
  return (
    <div className="grid items-center gap-4 rounded-lg border border-border bg-muted/30 p-4 sm:grid-cols-[4rem_minmax(0,1fr)_auto]">
      <PreviewIcon Icon={Icon} />
      <div className="min-w-0">
        <h2 className="mb-1 text-lg font-semibold text-foreground">{label}</h2>
        <p className="font-mono text-xs text-muted-foreground">{command}</p>
        <p className="mt-2 flex flex-wrap gap-2 text-sm text-muted-foreground">{metric}</p>
      </div>
      <div className="justify-self-start sm:justify-self-end">{status}</div>
    </div>
  );
}

function PreviewIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <span className="flex size-14 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-sm" aria-hidden="true">
      <Icon className="size-7" />
    </span>
  );
}
