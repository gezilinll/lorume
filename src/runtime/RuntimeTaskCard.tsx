import { type KeyboardEvent } from "react";
import { Pill } from "@/components/data/Pill";
import { SpotlightSurface } from "@/components/surfaces/SpotlightSurface";
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

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  }

  return (
    <SpotlightSurface
      aria-label={`${item.assigneeLabel} ${fullUserMessage}`}
      aria-pressed="false"
      className="cursor-pointer px-3 py-3 text-left"
      data-state="idle"
      data-view="mail-list-item"
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      spotlight="task-card"
      tabIndex={0}
    >
      <div className="grid min-w-0 gap-2">
        <p className="truncate text-[0.82rem] font-semibold leading-4 text-foreground" data-testid="runtime-task-card-assignee">
          {item.assigneeLabel}
        </p>
        <p
          className="line-clamp-1 min-w-0 break-words text-[0.92rem] font-semibold leading-5"
          data-testid="runtime-task-card-title"
          title={fullUserMessage}
        >
          {cardTitle}
        </p>
        <p
          className="line-clamp-2 min-w-0 break-words text-xs leading-5 text-muted-foreground"
          data-testid="runtime-task-card-reply"
        >
          {agentReply}
        </p>
        <div className="flex min-w-0 items-center justify-between gap-2 overflow-visible pb-px" data-testid="runtime-task-card-footer">
          <time className="min-w-0 truncate text-[11px] leading-4 text-muted-foreground" dateTime={updatedAt}>
            {formatRuntimeTimestamp(updatedAt)}
        </time>
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 overflow-visible">
            {getRuntimeTaskCardPills(item).map((pill) => (
              <Pill
                className={cn(pill.kind === "channel" && "min-w-0 max-w-full shrink truncate")}
                key={`${pill.kind}:${pill.label}`}
                kind={pill.kind}
                title={pill.title}
                tone={pill.tone}
              >
                {pill.label}
              </Pill>
            ))}
          </div>
        </div>
      </div>
    </SpotlightSurface>
  );
}
