import { type CSSProperties, type KeyboardEvent } from "react";
import { Pill } from "@/components/data/Pill";
import { cn } from "@/lib/utils";
import { formatRuntimeTimestamp } from "./runtime-fleet-query";
import {
  formatRuntimeTaskAgentReply,
  formatRuntimeTaskCardTitle,
  getRuntimeTaskCardPills,
  getRuntimeTaskFullUserMessage,
} from "./runtime-task-display";
import type { RuntimeTaskBoardItem } from "./runtime-work-query-api";

export function RuntimeTaskCard({
  item,
  onSelect,
}: {
  item: RuntimeTaskBoardItem;
  onSelect: () => void;
}) {
  const fullUserMessage = getRuntimeTaskFullUserMessage(item);
  const cardTitle = formatRuntimeTaskCardTitle(item);
  const agentReply = formatRuntimeTaskAgentReply(item);
  const updatedAt = item.updatedAt ?? item.createdAt;
  const cardColor = taskCardColor(item.status);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  }

  return (
    <article
      aria-label={`${item.assigneeLabel} ${fullUserMessage}`}
      aria-pressed="false"
      className="relative cursor-pointer overflow-hidden rounded-[11px] border border-border bg-card py-3 pl-[17px] pr-3 text-left shadow-[0_12px_26px_rgba(15,23,42,0.035)] transition-[box-shadow,transform] duration-200 before:absolute before:left-0 before:top-[34px] before:bottom-[34px] before:w-[3px] before:rounded-r-[7px] before:bg-[var(--card-color)] hover:-translate-y-0.5 hover:shadow-[0_12px_26px_rgba(15,23,42,0.07)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      data-state="idle"
      data-spotlight="task-card"
      data-view="mail-list-item"
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      style={{ "--card-color": cardColor } as CSSProperties}
      tabIndex={0}
    >
      <div className="grid min-w-0 gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {getRuntimeTaskCardPills(item).slice(0, 2).map((pill) => (
            <Pill
              className={cn("h-[19px] rounded-[5px] px-[7px] text-[9.5px] font-bold", pill.kind === "channel" && "min-w-0 max-w-full shrink truncate")}
              key={`${pill.kind}:${pill.label}`}
              kind={pill.kind}
              title={pill.title}
              tone={pill.tone}
            >
              {pill.label}
            </Pill>
          ))}
        </div>
        <h3
          className="line-clamp-2 min-w-0 break-words text-[13.5px] font-bold leading-[1.25] tracking-normal text-foreground"
          data-testid="runtime-task-card-title"
          title={fullUserMessage}
        >
          {cardTitle}
        </h3>
        <p
          className="line-clamp-2 min-w-0 break-words text-[11.5px] leading-[1.42] text-muted-foreground"
          data-testid="runtime-task-card-reply"
        >
          {agentReply}
        </p>
        <div className="grid gap-1.5 text-[11.5px] text-foreground/80">
          <span className="truncate">发起人：{item.creatorLabel}</span>
          <span className="truncate">承接：{item.assigneeLabel}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center justify-between gap-2 overflow-visible border-t border-border pt-2.5" data-testid="runtime-task-card-footer">
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground" data-testid="runtime-task-card-assignee">
            {item.assigneeLabel}
          </span>
          <time className="shrink-0 truncate text-[11px] leading-4 text-muted-foreground" dateTime={updatedAt}>
            {formatRuntimeTimestamp(updatedAt)}
          </time>
        </div>
      </div>
    </article>
  );
}

function taskCardColor(status: RuntimeTaskBoardItem["status"]): string {
  if (status === "in_progress") return "var(--orange)";
  if (status === "review") return "var(--blue)";
  if (status === "done") return "var(--green)";
  if (status === "failed" || status === "unknown") return "var(--red)";
  if (status === "cancelled") return "var(--muted-2)";
  return "var(--brand)";
}
