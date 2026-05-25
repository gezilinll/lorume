import type { ReactNode } from "react";
import { Bot, Server, ShieldCheck, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/data/StatusBadge";

/** Static operational preview for the auth entry screen. */
export function AuthOperationsPreview() {
  return (
    <section className="auth-preview" aria-label="运营概览">
      <div className="auth-preview__header">
        <span className="auth-preview__prompt">运营概览</span>
      </div>
      <AuthPreviewRow
        command="$ runtimes list --all"
        Icon={Server}
        label="Runtime Fleet"
        metric={<><span className="metricTextSuccess">在线 5</span><span>离线 0</span><span>异常 0</span></>}
        status={<StatusBadge tone="success">在线</StatusBadge>}
      />
      <AuthPreviewRow
        command="$ runs stats --window=24h"
        Icon={Bot}
        label="Runs"
        metric={<><span>总数 1,248</span><span className="metricTextSuccess">成功 96.3%</span><span className="metricTextDanger">失败 3.7%</span></>}
        status={<StatusBadge tone="warning">工作中</StatusBadge>}
      />
      <AuthPreviewRow
        command="$ collectors health"
        Icon={ShieldCheck}
        label="采集健康"
        metric={<><span className="metricTextSuccess">健康 23</span><span>警告 1</span><span>异常 0</span></>}
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
    <div className="auth-preview__row">
      <PreviewIcon Icon={Icon} />
      <div className="auth-preview__copy">
        <h2>{label}</h2>
        <p className="auth-preview__command">{command}</p>
        <p className="auth-preview__metric">{metric}</p>
      </div>
      <div className="auth-preview__status">{status}</div>
    </div>
  );
}

function PreviewIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <span className="auth-preview__icon" aria-hidden="true">
      <Icon className="auth-preview__iconSvg" />
    </span>
  );
}
