import { createDeviceStateSnapshot, type Task } from "./runtime-model";

export const RUNTIME_TASK_SYNC_SCHEMA_VERSION = "device-state-v2" as const;

export interface RuntimeTaskBatchEntry {
  task: Task;
  hash: string;
}

export interface RuntimeTaskBatch {
  schemaVersion: typeof RUNTIME_TASK_SYNC_SCHEMA_VERSION;
  deviceId: string;
  collectedAt: string;
  batchId: string;
  batchIndex: number;
  batchCount: number;
  tasks: RuntimeTaskBatchEntry[];
  removedTaskIds: string[];
}

export interface RuntimeTaskBatchOptions {
  deviceId: string;
  collectedAt: string;
  batchMaxBytes: number;
  batchMaxTasks: number;
}

export function normalizeTaskHashText(value?: string): string | null {
  const text = value?.replace(/\r\n/g, "\n").trim();
  return text ? text : null;
}

export function createRuntimeTaskHash(task: Task): string {
  return hashStableJson({
    agentId: task.agentId,
    agentReply: normalizeTaskHashText(task.agentReply),
    adapter: stableObjectOrNull(task.adapter),
    assignee: stableObjectOrNull(task.assignee),
    channel: stableObjectOrNull(task.channel),
    conversation: stableObjectOrNull(task.conversation),
    createdAt: task.createdAt ?? null,
    creator: stableObjectOrNull(task.creator),
    error: normalizeTaskHashText(task.error),
    hashVersion: 1,
    id: task.id,
    status: task.status,
    taskType: task.taskType,
    updatedAt: task.updatedAt ?? null,
    userMessage: normalizeTaskHashText(task.userMessage),
  });
}

export function createRuntimeTaskBatches(tasks: Task[], options: RuntimeTaskBatchOptions): RuntimeTaskBatch[] {
  const orderedEntries = [...tasks]
    .sort(compareTasksBySyncOrder)
    .map((task) => ({ task, hash: createRuntimeTaskHash(task) }));
  const batches: RuntimeTaskBatch[] = [];
  let current: RuntimeTaskBatchEntry[] = [];

  for (const entry of orderedEntries) {
    const next = [...current, entry];
    if (
      current.length > 0 &&
      (next.length > options.batchMaxTasks || byteLength(taskBatchDraft(options, batches.length, next)) > options.batchMaxBytes)
    ) {
      batches.push(finalizeTaskBatch(options, batches.length, current));
      current = [entry];
    } else {
      current = next;
    }
  }

  if (current.length > 0) batches.push(finalizeTaskBatch(options, batches.length, current));
  return batches.map((batch) => ({ ...batch, batchCount: batches.length }));
}

export function normalizeRuntimeTaskBatch(value: unknown): RuntimeTaskBatch | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RuntimeTaskBatch>;
  if (candidate.schemaVersion !== RUNTIME_TASK_SYNC_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(candidate.deviceId) || !isNonEmptyString(candidate.collectedAt) || !isNonEmptyString(candidate.batchId)) {
    return null;
  }
  const batchIndex = candidate.batchIndex;
  const batchCount = candidate.batchCount;
  if (
    typeof batchIndex !== "number" ||
    typeof batchCount !== "number" ||
    !Number.isInteger(batchIndex) ||
    !Number.isInteger(batchCount)
  ) {
    return null;
  }
  if (!Array.isArray(candidate.tasks)) return null;
  const tasks = candidate.tasks.map((entry) => normalizeRuntimeTaskBatchEntry(entry)).filter((entry): entry is RuntimeTaskBatchEntry => Boolean(entry));
  if (tasks.length !== candidate.tasks.length) return null;
  const removedTaskIds = normalizeRemovedTaskIds(candidate.removedTaskIds);
  return {
    batchCount,
    batchId: candidate.batchId,
    batchIndex,
    collectedAt: candidate.collectedAt,
    deviceId: candidate.deviceId,
    removedTaskIds,
    schemaVersion: RUNTIME_TASK_SYNC_SCHEMA_VERSION,
    tasks,
  };
}

function finalizeTaskBatch(
  options: RuntimeTaskBatchOptions,
  batchIndex: number,
  tasks: RuntimeTaskBatchEntry[],
): RuntimeTaskBatch {
  const draft = taskBatchDraft(options, batchIndex, tasks);
  return {
    ...draft,
    batchId: createBatchId(options, batchIndex, tasks),
  };
}

function taskBatchDraft(
  options: RuntimeTaskBatchOptions,
  batchIndex: number,
  tasks: RuntimeTaskBatchEntry[],
): RuntimeTaskBatch {
  return {
    batchCount: 0,
    batchId: "",
    batchIndex,
    collectedAt: options.collectedAt,
    deviceId: options.deviceId,
    removedTaskIds: [],
    schemaVersion: RUNTIME_TASK_SYNC_SCHEMA_VERSION,
    tasks,
  };
}

function createBatchId(
  options: RuntimeTaskBatchOptions,
  batchIndex: number,
  tasks: RuntimeTaskBatchEntry[],
): string {
  return hashStableJson({
    batchIndex,
    collectedAt: options.collectedAt,
    deviceId: options.deviceId,
    tasks: tasks.map((entry) => ({ hash: entry.hash, id: entry.task.id })),
  });
}

function compareTasksBySyncOrder(left: Task, right: Task): number {
  const rightTime = taskSyncTimestamp(right);
  const leftTime = taskSyncTimestamp(left);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return left.id.localeCompare(right.id);
}

function taskSyncTimestamp(task: Task): number {
  for (const value of [task.updatedAt, task.createdAt]) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function normalizeRuntimeTaskBatchEntry(value: unknown): RuntimeTaskBatchEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RuntimeTaskBatchEntry>;
  if (!isNonEmptyString(candidate.hash)) return null;
  const task = createDeviceStateSnapshot({
    collectedAt: new Date(0).toISOString(),
    device: { id: "task-batch", hostname: "task-batch", os: "unknown" },
    runtimes: [],
    agents: [],
    tasks: [candidate.task],
  }).tasks[0];
  if (!task?.id || !task.agentId || !task.adapter?.kind) return null;
  return {
    hash: candidate.hash,
    task,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRemovedTaskIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function stableObjectOrNull(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  return stableValue(value);
}

function hashStableJson(value: unknown): string {
  return fnv1a64(JSON.stringify(stableValue(value)));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) output[key] = stableValue(child);
  }
  return output;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
