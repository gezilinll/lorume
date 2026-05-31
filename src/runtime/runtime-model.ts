export const COLLECTION_STATUSES = ["syncing", "online", "offline", "error"] as const;

export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const AGENT_COLLECTION_STATUSES = [...COLLECTION_STATUSES, "invisible"] as const;

export type AgentCollectionStatus = (typeof AGENT_COLLECTION_STATUSES)[number];

export const COLLECTION_DIAGNOSTIC_SEVERITIES = ["debug", "info", "warning", "error"] as const;

export type CollectionDiagnosticSeverity = (typeof COLLECTION_DIAGNOSTIC_SEVERITIES)[number];

export interface CollectionDiagnosticItem {
  code: string;
  severity: CollectionDiagnosticSeverity;
  count: number;
  message: string;
  source?: string;
  target?: "adapter" | "collector" | "snapshot" | "task";
  action?: "ignored" | "task_dropped" | "task_ingested_with_gap" | "ingestion_failed";
  sampleRefs?: string[];
}

export interface CollectionDiagnostics {
  items: CollectionDiagnosticItem[];
}

export const RUNTIME_KINDS = ["openclaw", "codex"] as const;

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

export const RUNTIME_TASK_BOARD_VISIBLE_STATUSES = [
  "todo",
  "in_progress",
  "review",
  "done",
  "failed",
  "unknown",
] as const satisfies readonly TaskStatus[];

export type TaskStatusCounts = Record<TaskStatus, number> & {
  total: number;
};

export interface RuntimeFleetTaskSummary {
  byAgentId: Record<string, TaskStatusCounts>;
  byRuntimeId: Record<string, TaskStatusCounts>;
  byDeviceId: Record<string, TaskStatusCounts>;
  lastActiveAtByAgentId?: Record<string, string>;
  lastActiveAtByRuntimeId?: Record<string, string>;
  lastActiveAtByDeviceId?: Record<string, string>;
}

export const TASK_TYPES = ["conversation", "scheduled"] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_ADAPTER_KINDS = ["openclaw", "slock", "codex"] as const;

export type TaskAdapterKind = (typeof TASK_ADAPTER_KINDS)[number];

export const TASK_CHANNEL_KINDS = ["dingtalk", "webchat", "slock"] as const;

export type TaskChannelKind = (typeof TASK_CHANNEL_KINDS)[number];

export const TASK_CHANNEL_KIND_LABELS: Record<TaskChannelKind, string> = {
  dingtalk: "DingTalk",
  slock: "Slock",
  webchat: "Web Chat",
};

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
  collectionStatus: AgentCollectionStatus;
  lastSeenAt?: string;
  diagnostics?: {
    paths?: Array<{ label: string; path: string }>;
    lastError?: string;
  };
}

export interface Task {
  id: string;
  agentId: string;
  taskType: TaskType;
  status: TaskStatus;
  userMessage?: string;
  agentReply?: string;
  adapter: {
    kind: TaskAdapterKind;
  };
  channel?: {
    kind: TaskChannelKind;
    externalId?: string;
  };
  conversation?: {
    title?: string;
    externalId?: string;
    lastActivityAt?: string;
  };
  assignee?: {
    name: string;
    externalId?: string;
  };
  creator?: {
    name?: string;
    externalId?: string;
  };
  raw?: {
    openclaw?: {
      status?: string;
      statusSource?: "session" | "trajectory" | "tasks_list";
      sessionId?: string;
      sessionKey?: string;
      messageId?: string;
      trajectoryRunId?: string;
      scheduleId?: string;
      scheduleName?: string;
    };
    slock?: {
      status?: string;
      taskNumber?: string;
      messageId?: string;
      channelTarget?: string;
      threadTarget?: string;
      taskClaimedAt?: string;
      taskCompletedAt?: string;
    };
    codex?: {
      threadId?: string;
      rolloutPath?: string;
      source?: string;
      model?: string;
      cwdKind?: "codex-native-or-other";
      tokensUsed?: number;
      git?: {
        branch?: string;
        sha?: string;
        origin?: string;
      };
    };
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DeviceStateSnapshot {
  collectedAt: string;
  device: Device;
  runtimes: Runtime[];
  agents: Agent[];
  tasks: Task[];
  diagnostics?: CollectionDiagnostics;
}

type LooseRecord = Record<string, any>;

export function createDeviceStateSnapshot(input: LooseRecord): DeviceStateSnapshot {
  const diagnostics = cleanCollectionDiagnostics(input.diagnostics);
  return {
    collectedAt: input.collectedAt,
    device: cleanDevice(input.device || {}),
    runtimes: Array.isArray(input.runtimes) ? input.runtimes.map(cleanRuntime).filter((runtime): runtime is Runtime => Boolean(runtime)) : [],
    agents: Array.isArray(input.agents) ? input.agents.map(cleanAgent) : [],
    tasks: Array.isArray(input.tasks) ? input.tasks.map(cleanTask) : [],
    ...(diagnostics.items.length ? { diagnostics } : {}),
  };
}

export function normalizeDeviceStateSnapshot(input: unknown): DeviceStateSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const snapshot = createDeviceStateSnapshot(input as LooseRecord);
  if (!isNonEmptyString(snapshot.collectedAt)) return null;
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
    !isTaskAdapterKind(task.adapter?.kind)
  )) return null;
  return snapshot;
}

export function normalizeTaskStatus(value: string): TaskStatus {
  const normalized = value.trim().toLowerCase();
  if (normalized === "queued" || normalized === "pending" || normalized === "todo") return "todo";
  if (normalized === "running" || normalized === "active" || normalized === "in_progress") return "in_progress";
  if (normalized === "review" || normalized === "in_review") return "review";
  if (normalized === "succeeded" || normalized === "completed" || normalized === "done" || normalized === "success") return "done";
  if (normalized === "blocked" || normalized === "waiting_on_dependency") return "blocked";
  if (normalized === "failed" || normalized === "error" || normalized === "timed_out" || normalized === "timeout" || normalized === "lost") return "failed";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "interrupted") return "cancelled";
  return "unknown";
}

export function createEmptyTaskStatusCounts(): TaskStatusCounts {
  return {
    blocked: 0,
    cancelled: 0,
    done: 0,
    failed: 0,
    in_progress: 0,
    review: 0,
    todo: 0,
    total: 0,
    unknown: 0,
  };
}

export function createEmptyRuntimeFleetTaskSummary(): RuntimeFleetTaskSummary {
  return {
    byAgentId: {},
    byDeviceId: {},
    byRuntimeId: {},
    lastActiveAtByAgentId: {},
    lastActiveAtByDeviceId: {},
    lastActiveAtByRuntimeId: {},
  };
}

export function normalizeTaskType(value: string | undefined): TaskType {
  return value === "scheduled" ? "scheduled" : "conversation";
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

function cleanRuntime(value: LooseRecord): Runtime | undefined {
  const kind = normalizeRuntimeKind(value.kind);
  if (!kind) return undefined;

  return {
    id: value.id,
    deviceId: value.deviceId,
    kind,
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
    collectionStatus: normalizeAgentCollectionStatus(value.collectionStatus),
    ...(value.lastSeenAt ? { lastSeenAt: value.lastSeenAt } : {}),
    ...(value.diagnostics ? { diagnostics: value.diagnostics } : {}),
  };
}

function cleanTask(value: LooseRecord): Task {
  const adapter = cleanTaskAdapter(value.adapter);
  const channel = cleanTaskChannel(value.channel);
  const conversation = channel ? cleanTaskConversation(value.conversation) : undefined;
  const raw = cleanTaskRaw(value.raw);
  const task = {
    id: value.id,
    agentId: value.agentId,
    taskType: normalizeTaskType(value.taskType),
    status: normalizeTaskStatus(String(value.status ?? "")),
    ...(adapter ? { adapter } : {}),
    ...(value.userMessage ? { userMessage: value.userMessage } : {}),
    ...(value.agentReply ? { agentReply: value.agentReply } : {}),
    ...(channel ? { channel } : {}),
    ...(conversation ? { conversation } : {}),
    ...(value.assignee?.name ? { assignee: cleanTaskAssignee(value.assignee) } : {}),
    ...(value.creator ? { creator: cleanTaskActor(value.creator) } : {}),
    ...(raw ? { raw } : {}),
    ...(value.error ? { error: value.error } : {}),
    ...(value.createdAt ? { createdAt: value.createdAt } : {}),
    ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}),
  };
  return task as Task;
}

function cleanTaskAdapter(value: LooseRecord | undefined): Task["adapter"] | undefined {
  if (!value || typeof value !== "object" || !isTaskAdapterKind(value.kind)) return undefined;
  return { kind: value.kind };
}

function cleanTaskChannel(value: LooseRecord | undefined): Task["channel"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!isTaskChannelKind(value.kind)) return undefined;
  return {
    kind: value.kind,
    ...(value.externalId ? { externalId: value.externalId } : {}),
  };
}

function cleanTaskActor(value: LooseRecord): NonNullable<Task["creator"]> {
  return {
    ...(value.name ? { name: value.name } : {}),
    ...(value.externalId ? { externalId: value.externalId } : {}),
  };
}

function cleanTaskAssignee(value: LooseRecord): NonNullable<Task["assignee"]> {
  return {
    name: String(value.name),
    ...(value.externalId ? { externalId: String(value.externalId) } : {}),
  };
}

function cleanTaskRaw(value: LooseRecord | undefined): Task["raw"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const openclaw = cleanOpenClawRaw(value.openclaw);
  const slock = cleanSlockRaw(value.slock);
  const codex = cleanCodexRaw(value.codex);
  return openclaw || slock || codex ? {
    ...(openclaw ? { openclaw } : {}),
    ...(slock ? { slock } : {}),
    ...(codex ? { codex } : {}),
  } : undefined;
}

function cleanOpenClawRaw(value: LooseRecord | undefined): NonNullable<NonNullable<Task["raw"]>["openclaw"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const output = {
    ...(value.status ? { status: String(value.status) } : {}),
    ...(value.statusSource === "session" || value.statusSource === "trajectory" || value.statusSource === "tasks_list" ? { statusSource: value.statusSource } : {}),
    ...(value.sessionId ? { sessionId: String(value.sessionId) } : {}),
    ...(value.sessionKey ? { sessionKey: String(value.sessionKey) } : {}),
    ...(value.messageId ? { messageId: String(value.messageId) } : {}),
    ...(value.trajectoryRunId ? { trajectoryRunId: String(value.trajectoryRunId) } : {}),
    ...(value.scheduleId ? { scheduleId: String(value.scheduleId) } : {}),
    ...(value.scheduleName ? { scheduleName: String(value.scheduleName) } : {}),
  };
  return Object.keys(output).length ? output : undefined;
}

function cleanSlockRaw(value: LooseRecord | undefined): NonNullable<NonNullable<Task["raw"]>["slock"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const output = {
    ...(value.status ? { status: String(value.status) } : {}),
    ...(value.taskNumber ? { taskNumber: String(value.taskNumber) } : {}),
    ...(value.messageId ? { messageId: String(value.messageId) } : {}),
    ...(value.channelTarget ? { channelTarget: String(value.channelTarget) } : {}),
    ...(value.threadTarget ? { threadTarget: String(value.threadTarget) } : {}),
    ...(value.taskClaimedAt ? { taskClaimedAt: String(value.taskClaimedAt) } : {}),
    ...(value.taskCompletedAt ? { taskCompletedAt: String(value.taskCompletedAt) } : {}),
  };
  return Object.keys(output).length ? output : undefined;
}

function cleanCodexRaw(value: LooseRecord | undefined): NonNullable<NonNullable<Task["raw"]>["codex"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tokensUsed = Number(value.tokensUsed);
  const git = cleanCodexGit(value.git);
  const output = {
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
    ...(value.rolloutPath ? { rolloutPath: String(value.rolloutPath) } : {}),
    ...(value.source ? { source: String(value.source) } : {}),
    ...(value.model ? { model: String(value.model) } : {}),
    ...(value.cwdKind === "codex-native-or-other" ? { cwdKind: value.cwdKind } : {}),
    ...(Number.isFinite(tokensUsed) ? { tokensUsed } : {}),
    ...(git ? { git } : {}),
  };
  return Object.keys(output).length ? output : undefined;
}

function cleanCodexGit(value: LooseRecord | undefined): NonNullable<NonNullable<NonNullable<Task["raw"]>["codex"]>["git"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const output = {
    ...(value.branch ? { branch: String(value.branch) } : {}),
    ...(value.sha ? { sha: String(value.sha) } : {}),
    ...(value.origin ? { origin: String(value.origin) } : {}),
  };
  return Object.keys(output).length ? output : undefined;
}

function cleanTaskConversation(value: LooseRecord | undefined): Task["conversation"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  return {
    ...(value.title ? { title: value.title } : {}),
    ...(value.externalId ? { externalId: value.externalId } : {}),
    ...(value.lastActivityAt ? { lastActivityAt: value.lastActivityAt } : {}),
  };
}

function normalizeCollectionStatus(value: string | undefined): CollectionStatus {
  if (value === "syncing" || value === "online" || value === "offline" || value === "error") return value;
  return "syncing";
}

function normalizeAgentCollectionStatus(value: string | undefined): AgentCollectionStatus {
  if (value === "invisible") return value;
  return normalizeCollectionStatus(value);
}

function cleanCollectionDiagnostics(value: unknown): CollectionDiagnostics {
  if (!value || typeof value !== "object") return { items: [] };
  const rawItems: unknown[] = Array.isArray((value as LooseRecord).items) ? (value as LooseRecord).items : [];
  const items = rawItems.length
    ? rawItems.map(cleanCollectionDiagnosticItem).filter((item): item is CollectionDiagnosticItem => Boolean(item))
    : [];
  return { items };
}

function cleanCollectionDiagnosticItem(value: unknown): CollectionDiagnosticItem | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as LooseRecord;
  if (!isNonEmptyString(candidate.code) || !isCollectionDiagnosticSeverity(candidate.severity)) return null;
  const count = Number(candidate.count);
  if (!Number.isInteger(count) || count < 1) return null;
  const message = isNonEmptyString(candidate.message) ? candidate.message : candidate.code;
  const sampleRefs = Array.isArray(candidate.sampleRefs)
    ? candidate.sampleRefs.filter(isNonEmptyString).slice(0, 5)
    : undefined;
  return {
    code: candidate.code,
    severity: candidate.severity,
    count,
    message,
    ...(isNonEmptyString(candidate.source) ? { source: candidate.source } : {}),
    ...(isCollectionDiagnosticTarget(candidate.target) ? { target: candidate.target } : {}),
    ...(isCollectionDiagnosticAction(candidate.action) ? { action: candidate.action } : {}),
    ...(sampleRefs?.length ? { sampleRefs } : {}),
  };
}

function isCollectionDiagnosticSeverity(value: unknown): value is CollectionDiagnosticSeverity {
  return value === "debug" || value === "info" || value === "warning" || value === "error";
}

function isCollectionDiagnosticTarget(value: unknown): value is NonNullable<CollectionDiagnosticItem["target"]> {
  return value === "adapter" || value === "collector" || value === "snapshot" || value === "task";
}

function isCollectionDiagnosticAction(value: unknown): value is NonNullable<CollectionDiagnosticItem["action"]> {
  return value === "ignored" || value === "task_dropped" || value === "task_ingested_with_gap" || value === "ingestion_failed";
}

function isTaskAdapterKind(value: unknown): value is TaskAdapterKind {
  return value === "openclaw" || value === "slock" || value === "codex";
}

function isTaskChannelKind(value: unknown): value is TaskChannelKind {
  return value === "dingtalk" || value === "webchat" || value === "slock";
}

function normalizeRuntimeKind(value: string | undefined): RuntimeKind | undefined {
  if (value === "openclaw" || value === "codex") return value;
  return undefined;
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
