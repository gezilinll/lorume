import type { ReactNode } from "react";
import { DetailSurface } from "@/components/surfaces/DetailSurface";
import { formatRuntimeTimestamp } from "./runtime-fleet-query";
import {
  formatRuntimeTaskAgentReply,
  formatRuntimeTaskDetailTitle,
  getRuntimeTaskFullUserMessage,
} from "./runtime-task-display";
import type { RuntimeTaskBoardItem } from "./runtime-work-query-api";

export function RuntimeTaskDetailDialog({
  item,
  open,
  onOpenChange,
}: {
  item: RuntimeTaskBoardItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!item) return null;
  const fullUserMessage = getRuntimeTaskFullUserMessage(item);
  const detailTitle = formatRuntimeTaskDetailTitle(item);
  const agentReply = formatRuntimeTaskAgentReply(item);
  const updatedAt = item.updatedAt ?? item.createdAt;

  return (
    <DetailSurface
      bodyClassName="space-y-3"
      bodyTestId="runtime-task-detail-body"
      className="sm:max-w-[640px]"
      depth="modal-3d"
      depthIntensity="modal-3d"
      layout="task-detail-simple"
      title={(
        <span className="block max-w-full truncate" data-testid="runtime-task-detail-title" title={fullUserMessage}>
          {detailTitle}
        </span>
      )}
      open={open}
      onOpenChange={onOpenChange}
      surface="task-detail"
    >
      <TaskSidePanel title="任务信息">
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <DetailPair label="发起人" value={item.creatorLabel} />
          <DetailPair label="承接 Agent" value={item.assigneeLabel} />
          <DetailPair label="更新时间" value={formatRuntimeTimestamp(updatedAt)} />
          <DetailPair label="渠道" value={item.channelKindLabel ?? "未上报"} />
        </div>
      </TaskSidePanel>
      <TaskMessageSection title="用户消息">
        {fullUserMessage}
      </TaskMessageSection>
      <TaskMessageSection testId="runtime-task-detail-agent-reply" title="Agent 回复">
        {agentReply}
      </TaskMessageSection>
    </DetailSurface>
  );
}

function TaskMessageSection({
  children,
  testId,
  title,
}: {
  children: string;
  testId?: string;
  title: string;
}) {
  return (
    <section className="rounded-[var(--radius)] border border-border bg-card p-3 shadow-sm" data-testid={testId}>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-5 text-muted-foreground">{children}</p>
    </section>
  );
}

function TaskSidePanel({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-[var(--radius)] border border-border bg-muted/20 p-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2.5 grid gap-2 text-xs">{children}</div>
    </section>
  );
}

function DetailPair({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-words font-medium text-foreground">{value}</span>
    </div>
  );
}
