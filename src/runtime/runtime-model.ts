export const COLLECTION_STATUSES = ["syncing", "online", "offline", "error"] as const;

export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const RUNTIME_KINDS = ["openclaw", "slock", "multica", "codex"] as const;

export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Device {
  id: string;
  hostname: string;
  os: string;
  architecture?: string;
  collectionStatus: CollectionStatus;
  lastSeenAt?: string;
  user?: {
    username?: string;
  };
  network?: {
    publicIp?: string;
    localIps?: string[];
  };
  collector?: {
    version: string;
    installPath?: string;
    lastError?: string;
  };
}

export interface Runtime {
  id: string;
  deviceId: string;
  kind: RuntimeKind;
  name: string;
  version?: string;
  collectionStatus: CollectionStatus;
  lastSeenAt?: string;
  diagnostics?: {
    paths?: Array<{ label: string; path: string }>;
    lastError?: string;
  };
}

export interface Agent {
  id: string;
  runtimeId: string;
  name: string;
  collectionStatus: CollectionStatus;
  lastSeenAt?: string;
  diagnostics?: {
    paths?: Array<{ label: string; path: string }>;
    lastError?: string;
  };
}

export interface Task {
  id: string;
  agentId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  source?: {
    externalId?: string;
  };
  channel?: {
    kind: "dingtalk" | "telegram" | "slack" | "slock" | "multica" | "openclaw" | "other";
    name?: string;
    externalId?: string;
  };
  conversation?: {
    title?: string;
    externalId?: string;
    lastActivityAt?: string;
  };
  assignee?: {
    name?: string;
  };
  creator?: {
    name?: string;
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
}

export interface DeviceStateSnapshot {
  observedAt: string;
  device: Device;
  runtimes: Runtime[];
  agents: Agent[];
  tasks: Task[];
  diagnostics?: {
    warnings?: string[];
  };
}

type LooseRecord = Record<string, any>;

export function createDeviceStateSnapshot(input: LooseRecord): DeviceStateSnapshot {
  return {
    observedAt: input.observedAt,
    device: cleanDevice(input.device || {}),
    runtimes: Array.isArray(input.runtimes) ? input.runtimes.map(cleanRuntime) : [],
    agents: Array.isArray(input.agents) ? input.agents.map(cleanAgent) : [],
    tasks: Array.isArray(input.tasks) ? input.tasks.map(cleanTask) : [],
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  };
}

export function normalizeDeviceStateSnapshot(input: unknown): DeviceStateSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const snapshot = createDeviceStateSnapshot(input as LooseRecord);
  if (!isNonEmptyString(snapshot.observedAt)) return null;
  if (!isNonEmptyString(snapshot.device.id) || !isNonEmptyString(snapshot.device.hostname) || !isNonEmptyString(snapshot.device.os)) return null;
  if (snapshot.runtimes.some((runtime) =>
    !isNonEmptyString(runtime.id) ||
    !isNonEmptyString(runtime.deviceId) ||
    !isNonEmptyString(runtime.name)
  )) return null;
  if (snapshot.agents.some((agent) =>
    !isNonEmptyString(agent.id) ||
    !isNonEmptyString(agent.runtimeId) ||
    !isNonEmptyString(agent.name)
  )) return null;
  if (snapshot.tasks.some((task) =>
    !isNonEmptyString(task.id) ||
    !isNonEmptyString(task.agentId) ||
    !isNonEmptyString(task.title)
  )) return null;
  return snapshot;
}

export function normalizeTaskStatus(value: string): TaskStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized === "queued" || normalized === "pending" || normalized === "todo") return "todo";
  if (normalized === "running" || normalized === "active" || normalized === "in_progress") return "in_progress";
  if (normalized === "review" || normalized === "in_review") return "review";
  if (normalized === "succeeded" || normalized === "completed" || normalized === "done") return "done";
  if (normalized === "blocked" || normalized === "waiting_on_dependency") return "blocked";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "unknown";
}

function cleanDevice(value: LooseRecord): Device {
  return {
    id: value.id,
    hostname: value.hostname,
    os: value.os,
    ...(value.architecture ? { architecture: value.architecture } : {}),
    collectionStatus: normalizeCollectionStatus(value.collectionStatus),
    ...(value.lastSeenAt ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(value.user ? { user: { username: value.user.username } } : {}),
    ...(value.network ? { network: cleanNetwork(value.network) } : {}),
    ...(value.collector ? { collector: cleanCollector(value.collector) } : {}),
  };
}

function cleanRuntime(value: LooseRecord): Runtime {
  return {
    id: value.id,
    deviceId: value.deviceId,
    kind: normalizeRuntimeKind(value.kind),
    name: value.name,
    ...(value.version ? { version: value.version } : {}),
    collectionStatus: normalizeCollectionStatus(value.collectionStatus),
    ...(value.lastSeenAt ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(value.diagnostics ? { diagnostics: value.diagnostics } : {}),
  };
}

function cleanAgent(value: LooseRecord): Agent {
  return {
    id: value.id,
    runtimeId: value.runtimeId,
    name: value.name,
    collectionStatus: normalizeCollectionStatus(value.collectionStatus),
    ...(value.lastSeenAt ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(value.diagnostics ? { diagnostics: value.diagnostics } : {}),
  };
}

function cleanTask(value: LooseRecord): Task {
  return {
    id: value.id,
    agentId: value.agentId,
    title: value.title,
    ...(value.description ? { description: value.description } : {}),
    status: normalizeTaskStatus(String(value.status ?? "")),
    ...(value.source ? { source: { externalId: value.source.externalId } } : {}),
    ...(value.channel ? { channel: value.channel } : {}),
    ...(value.conversation ? { conversation: value.conversation } : {}),
    ...(value.assignee ? { assignee: { name: value.assignee.name } } : {}),
    ...(value.creator ? { creator: { name: value.creator.name } } : {}),
    ...(value.error ? { error: value.error } : {}),
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
    ...(value.lastSeenAt ? { lastSeenAt: value.lastSeenAt } : {}),
  };
}

function normalizeCollectionStatus(value: string | undefined): CollectionStatus {
  if (value === "syncing" || value === "online" || value === "offline" || value === "error") return value;
  return "syncing";
}

function normalizeRuntimeKind(value: string | undefined): RuntimeKind {
  if (value === "openclaw" || value === "slock" || value === "multica" || value === "codex") return value;
  return "openclaw";
}

function cleanNetwork(value: LooseRecord): Device["network"] {
  return {
    ...(value.publicIp ? { publicIp: value.publicIp } : {}),
    ...(Array.isArray(value.localIps) ? { localIps: value.localIps } : {}),
  };
}

function cleanCollector(value: LooseRecord): NonNullable<Device["collector"]> {
  return {
    version: value.version,
    ...(value.installPath ? { installPath: value.installPath } : {}),
    ...(value.lastError ? { lastError: value.lastError } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
