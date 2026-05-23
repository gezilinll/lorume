import {
  createDeviceStateSnapshot,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
} from "./runtime-model";
import { channelKindLabels } from "./runtime-fleet-query";

export type RuntimeTaskChannelKind = NonNullable<Task["channel"]>["kind"];
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
}

/** Parsed backend query page plus pagination metadata. */
export interface RuntimeTasksQueryPage {
  /** Product Task rows for the current page. */
  tasks: Task[];
  /** Total matching rows before pagination. */
  total: number;
  /** Cursor for the next page when more rows are available. */
  nextCursor?: string;
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
  summary: Record<TaskStatus, number> & { total: number };
  visibleItems: RuntimeTaskBoardItem[];
}

export interface RuntimeTaskChannelOption {
  value: RuntimeTaskChannelKind;
  label: string;
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
  options: { cursor?: string } = {},
): URL {
  const requestUrl = new URL("/api/runtime-tasks", origin);
  requestUrl.searchParams.set("limit", "500");
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
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : undefined,
    tasks,
    total: typeof value.total === "number" ? value.total : tasks.length,
  };
}

/** Group Task rows into status lanes for the Runs / Work Board surface. */
export function createRuntimeTaskBoard(
  tasks: Task[],
  filters: RuntimeTaskBoardFilters = {},
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
  const summary = Object.fromEntries(TASK_STATUSES.map((status) => [
    status,
    tasks.filter((task) => task.status === status).length,
  ])) as Record<TaskStatus, number>;
  return {
    lanes,
    summary: {
      ...summary,
      total: tasks.length,
    },
    visibleItems,
  };
}

/** List user-facing channel kinds actually present in Task context. */
export function listRuntimeTaskChannelOptions(tasks: Task[]): RuntimeTaskChannelOption[] {
  return Array.from(
    new Set(tasks.map((task) => task.channel?.kind).filter((kind): kind is RuntimeTaskChannelKind => Boolean(kind))),
  )
    .sort()
    .map((kind) => ({ value: kind, label: channelKindLabels[kind] }));
}

function isRuntimeTasksQueryResponse(value: unknown): value is RuntimeTasksQueryResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeTasksQueryResponse>;
  return Array.isArray(candidate.items);
}

function taskBoardItem(task: Task): RuntimeTaskBoardItem {
  return {
    ...task,
    assigneeLabel: task.assignee?.name ?? task.agentId,
    channelKindLabel: task.channel?.kind ? channelKindLabels[task.channel.kind] : undefined,
    channelLabel: task.conversation?.title,
    creatorLabel: task.creator?.name ?? "未知",
    displayTitle: taskDisplayTitle(task),
    requestExcerpt: task.userMessage ?? task.conversation?.title ?? "未上报用户消息",
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
