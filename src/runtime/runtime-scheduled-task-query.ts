import {
  createEmptyTaskStatusCounts,
  TASK_STATUSES,
  type Task,
  type TaskStatus,
  type TaskStatusCounts,
} from "./runtime-model";

export type ScheduledTaskEnabledFilter = "enabled" | "disabled";

export interface RuntimeScheduledTaskFilters {
  search?: string;
  runtimeId?: string;
  agentId?: string;
  enabled?: ScheduledTaskEnabledFilter;
  status?: TaskStatus;
}

export interface RuntimeScheduledTaskGroup {
  scheduleKey: string;
  sourceId: string;
  name: string;
  deviceId: string;
  runtimeId: string;
  runtimeKind: string;
  runtimeName: string;
  agentIds: string[];
  agentNames: string[];
  enabled: boolean;
  expression?: string;
  timezone?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  executionCount: number;
  latestExecutionAt?: string;
  latestStatus?: TaskStatus;
  summary: {
    byStatus: TaskStatusCounts;
  };
}

export interface RuntimeScheduledTasksResult {
  items: RuntimeScheduledTaskGroup[];
  total: number;
  summary: {
    total: number;
    enabledCount: number;
    disabledCount: number;
  };
}

export interface RuntimeScheduledTaskExecutionsResult {
  items: Task[];
  total: number;
  summary: {
    byStatus: TaskStatusCounts;
    total: number;
  };
}

export function createRuntimeScheduledTasksUrl(pathname: string, organizationId?: string): URL {
  const requestUrl = new URL(pathname, window.location.origin);
  if (organizationId?.trim()) requestUrl.searchParams.set("organizationId", organizationId.trim());
  return requestUrl;
}

export async function fetchRuntimeScheduledTasks({
  organizationId,
}: {
  organizationId?: string;
} = {}): Promise<RuntimeScheduledTasksResult> {
  const response = await fetch(createRuntimeScheduledTasksUrl("/api/runtime-scheduled-tasks", organizationId));
  if (!response.ok) throw new Error(`runtime scheduled tasks query failed: ${response.status}`);
  const result = runtimeScheduledTasksFromResponse(await response.json());
  if (!result) throw new Error("runtime scheduled tasks query returned an invalid payload");
  return result;
}

export async function fetchRuntimeScheduledTaskExecutions({
  limit = 50,
  organizationId,
  scheduleKey,
}: {
  limit?: number;
  organizationId?: string;
  scheduleKey: string;
}): Promise<RuntimeScheduledTaskExecutionsResult> {
  const requestUrl = createRuntimeScheduledTasksUrl(
    `/api/runtime-scheduled-tasks/${encodeURIComponent(scheduleKey)}/executions`,
    organizationId,
  );
  requestUrl.searchParams.set("limit", String(limit));
  const response = await fetch(requestUrl);
  if (!response.ok) throw new Error(`runtime scheduled task executions query failed: ${response.status}`);
  const result = runtimeScheduledTaskExecutionsFromResponse(await response.json());
  if (!result) throw new Error("runtime scheduled task executions query returned an invalid payload");
  return result;
}

export function runtimeScheduledTasksFromResponse(value: unknown): RuntimeScheduledTasksResult | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = value.items
    .map(normalizeScheduledTaskGroup)
    .filter((item): item is RuntimeScheduledTaskGroup => Boolean(item));
  return {
    items,
    summary: normalizeScheduledSummary(value.summary, items),
    total: readNumber(value.total, items.length),
  };
}

export function runtimeScheduledTaskExecutionsFromResponse(value: unknown): RuntimeScheduledTaskExecutionsResult | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = value.items
    .map(normalizeTask)
    .filter((item): item is Task => Boolean(item));
  return {
    items,
    summary: {
      byStatus: normalizeTaskStatusCounts((isRecord(value.summary) ? value.summary.byStatus : undefined), items),
      total: readNumber(isRecord(value.summary) ? value.summary.total : undefined, items.length),
    },
    total: readNumber(value.total, items.length),
  };
}

export function filterRuntimeScheduledTaskGroups(
  items: RuntimeScheduledTaskGroup[],
  filters: RuntimeScheduledTaskFilters,
): RuntimeScheduledTaskGroup[] {
  const search = normalizeSearch(filters.search);
  return items.filter((item) => {
    if (search && !scheduledTaskSearchText(item).includes(search)) return false;
    if (filters.runtimeId && item.runtimeId !== filters.runtimeId) return false;
    if (filters.agentId && !item.agentIds.includes(filters.agentId)) return false;
    if (filters.enabled === "enabled" && !item.enabled) return false;
    if (filters.enabled === "disabled" && item.enabled) return false;
    if (filters.status && item.latestStatus !== filters.status) return false;
    return true;
  });
}

export function scheduledTaskNeedsAttention(item: RuntimeScheduledTaskGroup): boolean {
  return item.latestStatus === "failed" || item.latestStatus === "unknown";
}

export function countActiveScheduledTaskFilters(filters: RuntimeScheduledTaskFilters): number {
  return Number(Boolean(filters.runtimeId)) +
    Number(Boolean(filters.agentId)) +
    Number(Boolean(filters.enabled)) +
    Number(Boolean(filters.status));
}

function normalizeScheduledTaskGroup(value: unknown): RuntimeScheduledTaskGroup | null {
  if (!isRecord(value)) return null;
  const scheduleKey = readString(value.scheduleKey);
  const sourceId = readString(value.sourceId);
  const name = readString(value.name);
  const runtimeId = readString(value.runtimeId);
  if (!scheduleKey || !sourceId || !name || !runtimeId) return null;
  const latestStatus = readTaskStatus(value.latestStatus);
  const group: RuntimeScheduledTaskGroup = {
    agentIds: normalizeStringList(value.agentIds),
    agentNames: normalizeStringList(value.agentNames),
    deviceId: readString(value.deviceId),
    enabled: value.enabled !== false,
    executionCount: readNumber(value.executionCount, 0),
    name,
    runtimeId,
    runtimeKind: readString(value.runtimeKind),
    runtimeName: readString(value.runtimeName) || readString(value.runtimeKind) || runtimeId,
    scheduleKey,
    sourceId,
    summary: {
      byStatus: normalizeTaskStatusCounts(isRecord(value.summary) ? value.summary.byStatus : undefined),
    },
    ...(readString(value.expression) ? { expression: readString(value.expression) } : {}),
    ...(readString(value.timezone) ? { timezone: readString(value.timezone) } : {}),
    ...(readIsoTimestamp(value.nextRunAt) ? { nextRunAt: readIsoTimestamp(value.nextRunAt) } : {}),
    ...(readIsoTimestamp(value.lastRunAt) ? { lastRunAt: readIsoTimestamp(value.lastRunAt) } : {}),
    ...(readIsoTimestamp(value.latestExecutionAt) ? { latestExecutionAt: readIsoTimestamp(value.latestExecutionAt) } : {}),
    ...(latestStatus ? { latestStatus } : {}),
  };
  return group;
}

function normalizeScheduledSummary(value: unknown, items: RuntimeScheduledTaskGroup[]) {
  const summary = isRecord(value) ? value : {};
  return {
    disabledCount: readNumber(summary.disabledCount, items.filter((item) => !item.enabled).length),
    enabledCount: readNumber(summary.enabledCount, items.filter((item) => item.enabled).length),
    total: readNumber(summary.total, items.length),
  };
}

function normalizeTask(value: unknown): Task | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const agentId = readString(value.agentId);
  const status = readTaskStatus(value.status);
  if (!id || !agentId || !status) return null;
  return {
    adapter: isRecord(value.adapter) && readString(value.adapter.kind)
      ? { kind: readString(value.adapter.kind) as Task["adapter"]["kind"] }
      : { kind: "openclaw" },
    agentId,
    id,
    status,
    taskType: "scheduled",
    ...(readString(value.userMessage) ? { userMessage: readString(value.userMessage) } : {}),
    ...(readString(value.agentReply) ? { agentReply: readString(value.agentReply) } : {}),
    ...(readString(value.error) ? { error: readString(value.error) } : {}),
    ...(readIsoTimestamp(value.createdAt) ? { createdAt: readIsoTimestamp(value.createdAt) } : {}),
    ...(readIsoTimestamp(value.updatedAt) ? { updatedAt: readIsoTimestamp(value.updatedAt) } : {}),
  };
}

function normalizeTaskStatusCounts(value: unknown, fallbackTasks: Task[] = []): TaskStatusCounts {
  const counts = createEmptyTaskStatusCounts();
  if (isRecord(value)) {
    for (const status of TASK_STATUSES) counts[status] = readNumber(value[status], 0);
    counts.total = readNumber(value.total, TASK_STATUSES.reduce((sum, status) => sum + counts[status], 0));
    return counts;
  }
  for (const task of fallbackTasks) {
    counts[task.status] += 1;
    counts.total += 1;
  }
  return counts;
}

function scheduledTaskSearchText(item: RuntimeScheduledTaskGroup): string {
  return normalizeSearch([
    item.name,
    item.runtimeName,
    item.runtimeKind,
    item.expression,
    item.timezone,
    ...item.agentNames,
  ].filter(Boolean).join(" "));
}

function normalizeSearch(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(readString).filter(Boolean)));
}

function readTaskStatus(value: unknown): TaskStatus | "" {
  const text = readString(value);
  return TASK_STATUSES.includes(text as TaskStatus) ? text as TaskStatus : "";
}

function readIsoTimestamp(value: unknown): string {
  const text = readString(value);
  if (!text) return "";
  const timestamp = new Date(text);
  return Number.isNaN(timestamp.getTime()) ? "" : timestamp.toISOString();
}

function readNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
