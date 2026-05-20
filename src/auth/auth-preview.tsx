import type { ReactNode } from "react";
import { PixelBadge } from "../ui/PixelBadge";
import { PixelIcon, type PixelIconName } from "../ui/PixelIcon";

/** Static operational preview for the auth entry screen. */
export function AuthOperationsPreview() {
  return (
    <section className="auth-preview" aria-label="运营概览">
      <div className="auth-preview__header">
        <span className="auth-preview__prompt">运营概览</span>
      </div>
      <AuthPreviewRow
        command="$ runtimes list --all"
        icon="server"
        label="Runtime Fleet"
        metric={<><span className="metricTextSuccess">在线 5</span><span>离线 0</span><span>异常 0</span></>}
        status={<PixelBadge tone="success">在线</PixelBadge>}
      />
      <AuthPreviewRow
        command="$ runs stats --window=24h"
        icon="chart"
        label="Runs"
        metric={<><span>总数 1,248</span><span className="metricTextSuccess">成功 96.3%</span><span className="metricTextDanger">失败 3.7%</span></>}
        status={<PixelBadge tone="warning">工作中</PixelBadge>}
      />
      <AuthPreviewRow
        command="$ collectors health"
        icon="shield"
        label="采集健康"
        metric={<><span className="metricTextSuccess">健康 23</span><span>警告 1</span><span>异常 0</span></>}
        status={<PixelBadge tone="success">健康</PixelBadge>}
      />
    </section>
  );
}

function AuthPreviewRow({
  command,
  icon,
  label,
  metric,
  status,
}: {
  command: string;
  icon: PixelIconName;
  label: string;
  metric: ReactNode;
  status: ReactNode;
}) {
  return (
    <div className="auth-preview__row">
      <PixelPreviewIcon icon={icon} />
      <div className="auth-preview__copy">
        <h2>{label}</h2>
        <p className="auth-preview__command">{command}</p>
        <p className="auth-preview__metric">{metric}</p>
      </div>
      {status}
    </div>
  );
}

function PixelPreviewIcon({ icon }: { icon: PixelIconName }) {
  return (
    <span className={`auth-preview__icon auth-preview__icon--${icon}`} aria-hidden="true">
      <PixelIcon className="auth-preview__iconSvg" name={icon} size={36} />
    </span>
  );
}
