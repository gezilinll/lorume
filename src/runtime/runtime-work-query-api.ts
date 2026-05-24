import {
  createDeviceStateSnapshot,
  createEmptyTaskStatusCounts,
  TASK_CHANNEL_KIND_LABELS,
  TASK_STATUSES,
  type Task,
  type TaskChannelKind,
  type TaskStatus,
  type TaskStatusCounts,
} from "./runtime-model";

export type RuntimeTaskChannelKind = TaskChannelKind;
export type RuntimeTaskStatusFilter = TaskStatus | "all";

export interface RuntimeTaskTimeRangeFilter {
  start?: string;
  end?: string;
}

export interface RuntimeTaskBoardFilters {
  channelKind?: RuntimeTaskChannelKind | "all";
  search?: string;
  status?: RuntimeTaskStatusFilter;
  timeRange?: RuntimeTaskTimeRangeFilter;
}

/** Backend query response for normalized Task rows. */
export interface RuntimeTasksQueryResponse {
  /** Task rows returned after backend filtering. */
  items: unknown[];
  /** Total matching rows before pagination. */
  total: number;
  /** Cursor for the next page when more rows are available. */
  nextCursor?: string;
  /** Status summary from the backend. */
  summary?: {
    total?: number;
    byStatus?: Partial<Record<TaskStatus, number>> & { total?: number };
  };
  /** Backend facets for filters. */
  facets?: {
    channels?: Array<{ kind?: string; label?: string; count?: number }>;
  };
}

/** Parsed backend query page plus pagination metadata. */
export interface RuntimeTasksQueryPage {
  /** Product Task rows for the current page. */
  tasks: Task[];
  /** Total matching rows before pagination. */
  total: number;
  /** Cursor for the next page when more rows are available. */
  nextCursor?: string;
  /** Backend status summary for the current search/time/channel scope. */
  summary: TaskStatusCounts;
  /** Backend channel facets for the current search/time/status scope. */
  channelOptions: RuntimeTaskChannelOption[];
}

export interface RuntimeTaskBoardItem extends Task {
  displayTitle: string;
  statusLabel: string;
  channelKindLabel?: string;
  channelLabel?: string;
  creatorLabel: string;
  assigneeLabel: string;
  requestExcerpt: string;
}

export interface RuntimeTaskBoardLane {
  status: TaskStatus;
  label: string;
  items: RuntimeTaskBoardItem[];
}

export interface RuntimeTaskBoard {
  lanes: RuntimeTaskBoardLane[];
  summary: TaskStatusCounts;
  visibleItems: RuntimeTaskBoardItem[];
}

export interface RuntimeTaskChannelOption {
  value: RuntimeTaskChannelKind;
  label: string;
  count: number;
}

export const taskStatusLabels: Record<TaskStatus, string> = {
  todo: "待处理",
  in_progress: "进行中",
  review: "待验收",
  done: "已完成",
  blocked: "阻塞",
  failed: "失败",
  cancelled: "已取消",
  unknown: "未知",
};

/** Create the formal backend query URL for Runtime Tasks. */
export function createTasksQueryUrl(
  origin: string,
  filters: RuntimeTaskBoardFilters | undefined,
  options: { cursor?: string; limit?: number } = {},
): URL {
  const requestUrl = new URL("/api/runtime-tasks", origin);
  requestUrl.searchParams.set("taskType", "conversation");
  requestUrl.searchParams.set("limit", String(options.limit ?? 50));
  if (options.cursor) requestUrl.searchParams.set("cursor", options.cursor);
  if (filters?.status && filters.status !== "all") requestUrl.searchParams.set("status", filters.status);
  if (filters?.channelKind && filters.channelKind !== "all") {
    requestUrl.searchParams.set("channelKind", filters.channelKind);
  }
  if (filters?.search?.trim()) requestUrl.searchParams.set("search", filters.search.trim());
  const startAt = isoTimestampFromFilter(filters?.timeRange?.start);
  const endAt = isoTimestampFromFilter(filters?.timeRange?.end);
  if (startAt) requestUrl.searchParams.set("startAt", startAt);
  if (endAt) requestUrl.searchParams.set("endAt", endAt);
  return requestUrl;
}

/** Convert a backend Task query response into product Task rows. */
export function runtimeTasksQueryPageFromResponse(value: unknown): RuntimeTasksQueryPage | null {
  if (!isRuntimeTasksQueryResponse(value)) return null;
  const tasks = createDeviceStateSnapshot({
    collectedAt: new Date().toISOString(),
    device: { id: "query", hostname: "query", os: "unknown" },
    runtimes: [],
    agents: [],
    tasks: value.items,
  }).tasks;
  return {
    channelOptions: listRuntimeTaskChannelOptions(value.facets?.channels ?? []),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : undefined,
    summary: normalizeRuntimeTaskSummary(value.summary),
    tasks,
    total: typeof value.total === "number" ? value.total : tasks.length,
  };
}

/** Group Task rows into status lanes for the Runs conversation task surface. */
export function createRuntimeTaskBoard(
  tasks: Task[],
  filters: RuntimeTaskBoardFilters = {},
  backendSummary?: TaskStatusCounts,
): RuntimeTaskBoard {
  const query = normalizeSearch(filters.search ?? "");
  const visibleTasks = tasks.filter((task) =>
    matchesStatus(task, filters.status) &&
    matchesChannel(task, filters.channelKind) &&
    matchesSearch(task, query) &&
    matchesTimeRange(task, filters.timeRange)
  );
  const visibleItems = visibleTasks.map(taskBoardItem);
  const lanes = TASK_STATUSES.map((status) => ({
    items: visibleItems.filter((item) => item.status === status),
    label: taskStatusLabels[status],
    status,
  }));
  const summary = backendSummary ?? countTasksByStatus(tasks);
  return {
    lanes,
    summary,
    visibleItems,
  };
}

/** Normalize backend channel facets into user-facing filter options. */
export function listRuntimeTaskChannelOptions(
  facets: Array<{ kind?: string; value?: string; label?: string; count?: number }>,
): RuntimeTaskChannelOption[] {
  return facets
    .map((facet) => ({ ...facet, kind: facet.kind ?? facet.value }))
    .filter((facet): facet is { kind: RuntimeTaskChannelKind; label?: string; count?: number } =>
      isRuntimeTaskChannelKind(facet.kind)
    )
    .map((facet) => ({
      count: Number.isFinite(Number(facet.count)) ? Number(facet.count) : 0,
      label: facet.label || TASK_CHANNEL_KIND_LABELS[facet.kind],
      value: facet.kind,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function isRuntimeTasksQueryResponse(value: unknown): value is RuntimeTasksQueryResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeTasksQueryResponse>;
  return Array.isArray(candidate.items);
}

function taskBoardItem(task: Task): RuntimeTaskBoardItem {
  return {
    ...task,
    assigneeLabel: task.assignee?.name ?? "未上报",
    channelKindLabel: task.channel?.kind ? TASK_CHANNEL_KIND_LABELS[task.channel.kind] : undefined,
    channelLabel: conversationDisplayLabel(task),
    creatorLabel: task.creator?.name ?? "未知",
    displayTitle: taskDisplayTitle(task),
    requestExcerpt: task.userMessage ?? conversationDisplayLabel(task) ?? "未上报用户消息",
    statusLabel: taskStatusLabels[task.status],
  };
}

export function taskDisplayTitle(task: Task): string {
  const message = task.userMessage?.replace(/\s+/g, " ").trim();
  if (message) return message.length > 32 ? `${message.slice(0, 32)}...` : message;
  return task.conversation?.title ?? "未命名任务";
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesStatus(task: Task, status?: RuntimeTaskStatusFilter): boolean {
  return !status || status === "all" || task.status === status;
}

function matchesChannel(task: Task, channelKind?: RuntimeTaskChannelKind | "all"): boolean {
  return !channelKind || channelKind === "all" || task.channel?.kind === channelKind;
}

function matchesSearch(task: Task, query: string): boolean {
  if (!query) return true;
  return [
    task.id,
    task.agentId,
    task.userMessage,
    task.agentReply,
    task.status,
    task.channel?.kind,
    task.conversation?.title,
    task.creator?.name,
    task.assignee?.name,
    task.error,
  ].some((value) => value?.toLowerCase().includes(query));
}

function matchesTimeRange(task: Task, timeRange?: RuntimeTaskTimeRangeFilter): boolean {
  if (!timeRange?.start && !timeRange?.end) return true;
  const timestamp = Date.parse(task.updatedAt ?? task.createdAt ?? "");
  if (!Number.isFinite(timestamp)) return false;
  const start = timeRange.start ? Date.parse(timeRange.start) : Number.NEGATIVE_INFINITY;
  const end = timeRange.end ? Date.parse(timeRange.end) : Number.POSITIVE_INFINITY;
  return timestamp >= start && timestamp <= end;
}

function countTasksByStatus(tasks: Task[]): TaskStatusCounts {
  const summary = createEmptyTaskStatusCounts();
  for (const task of tasks) {
    summary[task.status] += 1;
    summary.total += 1;
  }
  return summary;
}

function normalizeRuntimeTaskSummary(value: RuntimeTasksQueryResponse["summary"]): TaskStatusCounts {
  const counts = createEmptyTaskStatusCounts();
  const byStatus = value?.byStatus;
  if (byStatus && typeof byStatus === "object") {
    for (const status of TASK_STATUSES) counts[status] = normalizeCount(byStatus[status]);
  }
  counts.total = normalizeCount(value?.total ?? byStatus?.total) || TASK_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  return counts;
}

function conversationDisplayLabel(task: Task): string | undefined {
  if (task.conversation?.title) return task.conversation.title;
  if (task.adapter.kind === "codex") return "本地 Codex 会话";
  if (task.adapter.kind === "slock") return "Slock 会话";
  return undefined;
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function isRuntimeTaskChannelKind(value: unknown): value is RuntimeTaskChannelKind {
  return value === "dingtalk" || value === "webchat" || value === "slock";
}

function isoTimestampFromFilter(value: string | undefined): string | undefined {
  const date = parseDateTimeLocal(value ?? "");
  return date ? date.toISOString() : undefined;
}

function parseDateTimeLocal(value: string): Date | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}
