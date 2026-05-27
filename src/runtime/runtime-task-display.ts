import type { PillKind, PillTone } from "@/components/data/Pill";
import type { TaskChannelKind, TaskStatus } from "./runtime-model";
import type { RuntimeTaskBoardItem } from "./runtime-work-query-api";

export const agentReplyFallback = "暂无 Agent 答复";
const cardTitleMaxLength = 16;
const detailTitleMaxLength = 24;

export interface RuntimeTaskPillDescriptor {
  kind: PillKind;
  label: string;
  title?: string;
  tone: PillTone;
}

export function getRuntimeTaskStatusTone(status: TaskStatus): PillTone {
  if (status === "done") return "success";
  if (status === "failed" || status === "blocked" || status === "unknown") return "danger";
  if (status === "in_progress" || status === "review") return "info";
  if (status === "todo") return "warning";
  return "neutral";
}

export function getRuntimeTaskCardPills(
  item: RuntimeTaskBoardItem,
  options: { maxVisible?: number } = {},
): RuntimeTaskPillDescriptor[] {
  const pills: RuntimeTaskPillDescriptor[] = [];
  if (item.channelKindLabel) {
    pills.push({
      kind: "channel",
      label: item.channelKindLabel,
      tone: channelPillTone(item.channel?.kind),
    });
  }
  const maxVisible = options.maxVisible ?? 4;
  if (pills.length <= maxVisible) return pills;
  const visible = pills.slice(0, maxVisible);
  visible.push({
    kind: "count",
    label: `+${pills.length - maxVisible}`,
    tone: "muted",
  });
  return visible;
}

function channelPillTone(kind?: TaskChannelKind): PillTone {
  if (kind === "dingtalk") return "blue";
  if (kind === "slock") return "purple";
  if (kind === "webchat") return "green";
  return "cyan";
}

export function formatRuntimeTaskCardTitle(item: RuntimeTaskBoardItem): string {
  return truncateTaskText(taskTitleSource(item), cardTitleMaxLength);
}

export function formatRuntimeTaskDetailTitle(item: RuntimeTaskBoardItem): string {
  return truncateTaskText(taskTitleSource(item), detailTitleMaxLength);
}

export function formatRuntimeTaskAgentReply(item: RuntimeTaskBoardItem): string {
  return item.agentReply?.trim() || agentReplyFallback;
}

export function formatRuntimeTaskChannelDetail(item: RuntimeTaskBoardItem): string {
  const channelKindLabel = item.channelKindLabel?.trim();
  const conversationLabel = getReadableConversationLabel(item);
  if (channelKindLabel && conversationLabel) {
    if (labelsReferToSameChannel(channelKindLabel, conversationLabel)) return conversationLabel;
    return `${channelKindLabel} ${conversationLabel}`;
  }
  return conversationLabel || channelKindLabel || "未上报";
}

export function getRuntimeTaskFullUserMessage(item: RuntimeTaskBoardItem): string {
  return item.userMessage?.trim() || item.displayTitle || "未命名任务";
}

function taskTitleSource(item: RuntimeTaskBoardItem): string {
  return getRuntimeTaskFullUserMessage(item);
}

function truncateTaskText(value: string, maxLength: number): string {
  const text = value.trim();
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  return `${chars.slice(0, maxLength).join("").trimEnd()}...`;
}

function getReadableConversationLabel(item: RuntimeTaskBoardItem): string | undefined {
  if (item.channel?.kind === "slock" && item.channel.externalId?.trim().startsWith("#")) {
    return item.channel.externalId.trim();
  }
  const label = item.channelLabel?.trim();
  if (!label || isOpaqueConversationId(label)) return undefined;
  return label;
}

function labelsReferToSameChannel(channelKindLabel: string, conversationLabel: string): boolean {
  return conversationLabel.toLowerCase().startsWith(channelKindLabel.toLowerCase());
}

function isOpaqueConversationId(value: string): boolean {
  return value.toLowerCase().startsWith("cid");
}
