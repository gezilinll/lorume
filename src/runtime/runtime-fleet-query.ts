import {
  createDeviceStateSnapshot,
  RUNTIME_KINDS,
  TASK_STATUSES,
  type Agent,
  type CollectionStatus,
  type Device,
  type Runtime,
  type RuntimeKind,
  type Task,
  type TaskStatus,
} from "./runtime-model";
import type { DeviceCollectionHealth } from "./runtime-collection-health";
import type { DeviceHealthStatus, DeviceHealthStatusResult } from "./runtime-device-health";

/** Runtime kind labels used by the Runtime Fleet page. */
export const runtimeKindLabels: Record<RuntimeKind, string> = {
  openclaw: "OpenClaw",
  slock: "Slock",
  multica: "Multica",
  codex: "Codex",
};

/** Channel labels used when a Task includes user-facing channel context. */
export const channelKindLabels: Record<NonNullable<Task["channel"]>["kind"], string> = {
  dingtalk: "DingTalk",
  webchat: "Web Chat",
  telegram: "Telegram",
  slack: "Slack",
  other: "Other",
};

/** Product collection status labels shown for Device, Runtime, and Agent rows. */
export const collectionStatusLabels: Record<CollectionStatus, string> = {
  syncing: "同步中",
  online: "在线",
  offline: "离线",
  error: "异常",
};

/** Alias used by page components for Runtime Fleet object labels. */
export const runtimeFleetObjectStatusLabels = collectionStatusLabels;

/** Normalized Runtime Fleet object status. */
export type RuntimeFleetObjectStatus = CollectionStatus;

/** Coarse observation time range for Runtime Fleet filtering. */
export type RuntimeFleetLastSeenRange = "all" | "24h" | "7d" | "30d";

/** Backend/UI Runtime Fleet snapshot built from the four top-level product objects. */
export interface RuntimeFleetSnapshot {
  /** Latest observation time across the result set. */
  observedAt: string;
  /** Devices represented by the query. */
  devices: Device[];
  /** Runtime objects represented by the query. */
  runtimes: Runtime[];
  /** Agent objects represented by the query. */
  agents: Agent[];
  /** Task objects represented by the query. */
  tasks: Task[];
}

/** Runtime kind option shown by Runtime Fleet. */
export interface RuntimeFleetRuntimeKindOption {
  /** Filter value. */
  value: RuntimeKind;
  /** Human-readable label. */
  label: string;
}

/** Filter state supported by the Runtime Fleet page. */
export interface RuntimeFleetFilters {
  /** Free-text search across device, runtime, agent, and task context. */
  query?: string;
  /** Runtime kind to keep. */
  runtimeKind?: RuntimeKind | "all";
  /** Optional last-observed range for device/runtime/agent rows. */
  lastSeenRange?: RuntimeFleetLastSeenRange;
}

/** Filtered assets shown by Runtime Fleet. */
export interface RuntimeFleetResult {
  /** Devices represented by the active filters. */
  devices: Device[];
  /** Runtimes matching the active filters. */
  runtimes: Runtime[];
  /** Agents matching the active filters. */
  agents: Agent[];
  /** Tasks matching or linked to the active filters. */
  tasks: Task[];
}

/** Small summary cards for Runtime Fleet. */
export interface RuntimeFleetSummary {
  /** Registered devices represented by the snapshot. */
  devices: number;
  /** Total runtime count represented by the snapshot. */
  runtimes: number;
  /** Total managed agent count represented by the snapshot. */
  agents: number;
  /** Total task count represented by the snapshot. */
  tasks: number;
}

/** Detail panel model for device, runtime, or agent selections. */
export interface RuntimeFleetDetailSection {
  /** Section title rendered in the detail panel. */
  title: string;
  /** Human-readable rows in this section. */
  items: string[];
}

interface RuntimeFleetDetailBase {
  /** Stable object id. */
  id: string;
  /** Main detail title. */
  title: string;
  /** Detail subtitle. */
  subtitle: string;
  /** Normalized status used for badge styling and automation. */
  status: RuntimeFleetObjectStatus;
  /** Human-readable status label. */
  statusLabel: string;
  /** Sectioned details for display. */
  sections: RuntimeFleetDetailSection[];
}

export type RuntimeFleetDetail =
  | (RuntimeFleetDetailBase & {
      /** Detail object kind. */
      kind: "device";
    })
  | (RuntimeFleetDetailBase & {
      /** Detail object kind. */
      kind: "runtime";
      /** Runtime kind label. */
      runtimeKindLabel: string;
    })
  | (RuntimeFleetDetailBase & {
      /** Detail object kind. */
      kind: "agent";
      /** Device that hosts the Agent runtime. */
      deviceId: string;
      /** Runtime name that owns this agent. */
      runtimeName: string;
      /** Runtime id that owns this agent. */
      runtimeId: string;
    });

type DeviceHealthById = ReadonlyMap<string, Pick<DeviceHealthStatusResult, "label" | "status">>;

/** Format runtime timestamps for Chinese-first UI without leaking raw UTC ISO strings. */
export function formatRuntimeTimestamp(value?: string): string {
  if (!value) return "未上报";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

/** Runtime display label used consistently across Runtime and Agent surfaces. */
export function runtimeDisplayName(runtime: Runtime): string {
  return runtime.name;
}

/** Resolve the best available observation time for an Agent row or detail view. */
export function runtimeAgentLastSeenAt(
  agent: Agent,
  runtime?: Runtime,
  snapshot?: RuntimeFleetSnapshot,
): string | undefined {
  return agent.lastSeenAt ?? runtime?.lastSeenAt ?? snapshot?.observedAt;
}

/** List runtime kinds actually present in the current Runtime Fleet snapshot. */
export function listRuntimeFleetRuntimeKindOptions(snapshot: RuntimeFleetSnapshot): RuntimeFleetRuntimeKindOption[] {
  const kinds = new Set(snapshot.runtimes.map((runtime) => runtime.kind));
  return RUNTIME_KINDS
    .filter((kind) => kinds.has(kind))
    .map((kind) => ({ value: kind, label: runtimeKindLabels[kind] }));
}

/** Summarize one query result for Runtime Fleet cards. */
export function summarizeRuntimeFleet(snapshot: RuntimeFleetSnapshot): RuntimeFleetSummary {
  return {
    agents: snapshot.agents.length,
    devices: snapshot.devices.length,
    runtimes: snapshot.runtimes.length,
    tasks: snapshot.tasks.length,
  };
}

/** Resolve Device status from the product collection status plus optional diagnostics. */
export function deriveDeviceFleetStatus(
  _snapshot: RuntimeFleetSnapshot,
  device: Device,
  collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
): RuntimeFleetObjectStatus {
  if (collectionHealthByDeviceId?.get(device.id)?.status === "failed") return "error";
  return normalizeCollectionStatus(device.collectionStatus);
}

/** Runtime status is collection status only; task activity is exposed as counts, not status. */
export function deriveRuntimeFleetStatus(
  _snapshot: RuntimeFleetSnapshot,
  runtime: Runtime,
  _collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
): RuntimeFleetObjectStatus {
  return normalizeCollectionStatus(runtime.collectionStatus);
}

/** Agent status is collection status only; task activity is exposed as counts, not status. */
export function deriveAgentFleetStatus(
  _snapshot: RuntimeFleetSnapshot,
  agent: Agent,
  _collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
): RuntimeFleetObjectStatus {
  return normalizeCollectionStatus(agent.collectionStatus);
}

/** Filter a runtime snapshot while preserving linear Device -> Runtime -> Agent -> Task relationships. */
export function filterRuntimeFleet(
  snapshot: RuntimeFleetSnapshot,
  filters: RuntimeFleetFilters = {},
): RuntimeFleetResult {
  const query = normalizeSearch(filters.query ?? "");
  let runtimes = snapshot.runtimes;
  let agents = snapshot.agents;
  let tasks = snapshot.tasks;
  let devices = snapshot.devices;

  if (filters.runtimeKind && filters.runtimeKind !== "all") {
    runtimes = runtimes.filter((runtime) => runtime.kind === filters.runtimeKind);
    const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
    agents = agents.filter((agent) => runtimeIds.has(agent.runtimeId));
    const agentIds = new Set(agents.map((agent) => agent.id));
    tasks = tasks.filter((task) => agentIds.has(task.agentId));
  }

  if (filters.lastSeenRange && filters.lastSeenRange !== "all") {
    const lastSeenRange = filters.lastSeenRange;
    runtimes = runtimes.filter((runtime) => matchesLastSeenRange(runtime.lastSeenAt, lastSeenRange));
    const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
    agents = agents.filter((agent) =>
      runtimeIds.has(agent.runtimeId) || matchesLastSeenRange(agent.lastSeenAt, lastSeenRange),
    );
    const agentIds = new Set(agents.map((agent) => agent.id));
    tasks = tasks.filter((task) => agentIds.has(task.agentId) || matchesLastSeenRange(task.lastSeenAt, lastSeenRange));
  }

  if (query) {
    const matchingDevices = devices.filter((device) => deviceMatches(device, query));
    const matchingDeviceIds = new Set(matchingDevices.map((device) => device.id));
    const matchingRuntimes = runtimes.filter((runtime) =>
      matchingDeviceIds.has(runtime.deviceId) || runtimeMatches(runtime, query),
    );
    const matchingRuntimeIds = new Set(matchingRuntimes.map((runtime) => runtime.id));
    const matchingAgents = agents.filter((agent) =>
      matchingRuntimeIds.has(agent.runtimeId) || agentMatches(agent, query),
    );
    const matchingAgentIds = new Set(matchingAgents.map((agent) => agent.id));
    const matchingTasks = tasks.filter((task) => matchingAgentIds.has(task.agentId) || taskMatches(task, query));
    const taskAgentIds = new Set(matchingTasks.map((task) => task.agentId));

    agents = agents.filter((agent) => matchingAgentIds.has(agent.id) || taskAgentIds.has(agent.id));
    const visibleRuntimeIds = new Set([
      ...matchingRuntimeIds,
      ...agents.map((agent) => agent.runtimeId),
    ]);
    runtimes = runtimes.filter((runtime) =>
      visibleRuntimeIds.has(runtime.id) || matchingDeviceIds.has(runtime.deviceId),
    );
    const visibleAgentIds = new Set(agents.map((agent) => agent.id));
    tasks = tasks.filter((task) => matchingTasks.some((candidate) => candidate.id === task.id) || visibleAgentIds.has(task.agentId));
  }

  const visibleDeviceIds = new Set(runtimes.map((runtime) => runtime.deviceId));
  devices = devices.filter((device) => visibleDeviceIds.has(device.id));

  return {
    devices,
    runtimes,
    agents,
    tasks,
  };
}

/** Resolve a detail panel object from the latest snapshot. */
export function getRuntimeFleetDetail(
  snapshot: RuntimeFleetSnapshot,
  kind: RuntimeFleetDetail["kind"],
  id: string,
  collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
  deviceHealthByDeviceId?: DeviceHealthById,
): RuntimeFleetDetail | null {
  if (kind === "device") {
    const device = snapshot.devices.find((candidate) => candidate.id === id);
    if (!device) return null;
    const runtimes = snapshot.runtimes.filter((runtime) => runtime.deviceId === device.id);
    const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
    const agents = snapshot.agents.filter((agent) => runtimeIds.has(agent.runtimeId));
    const agentIds = new Set(agents.map((agent) => agent.id));
    const tasks = snapshot.tasks.filter((task) => agentIds.has(task.agentId));
    const deviceHealth = deviceHealthByDeviceId?.get(device.id);
    const status = deviceHealth
      ? runtimeFleetStatusFromDeviceHealth(deviceHealth.status)
      : deriveDeviceFleetStatus(snapshot, device, collectionHealthByDeviceId);
    const statusLabel = deviceHealth?.label ?? collectionStatusLabels[status];
    return {
      kind: "device",
      id: device.id,
      title: deviceDisplayLabel(device),
      subtitle: `最近同步 ${formatRuntimeTimestamp(device.lastSeenAt ?? snapshot.observedAt)}`,
      status,
      statusLabel,
      sections: [
        {
          title: "基础信息",
          items: [
            `Lorume ID: ${device.id}`,
            `Hostname: ${device.hostname}`,
            `OS: ${device.os ?? "未上报"}`,
            `Arch: ${device.architecture ?? "未上报"}`,
            `用户: ${device.user?.username ?? "未上报"}`,
          ],
        },
        {
          title: "网络",
          items: [
            `局域网 IP: ${device.network?.localIps?.join(", ") || "未上报"}`,
            `公网 IP: ${device.network?.publicIp || "未上报"}`,
          ],
        },
        {
          title: "运行资产",
          items: [
            `状态: ${statusLabel}`,
            `Collector: ${device.collector?.version ?? "未上报"}`,
            `Runtime 数量: ${runtimes.length}`,
            `Agent 数量: ${agents.length}`,
            `Task 数量: ${tasks.length}`,
            `最近同步: ${formatRuntimeTimestamp(device.lastSeenAt ?? snapshot.observedAt)}`,
          ],
        },
        {
          title: "已注册 Runtime",
          items: registeredRuntimeLabels(runtimes),
        },
      ],
    };
  }

  if (kind === "runtime") {
    const runtime = snapshot.runtimes.find((candidate) => candidate.id === id);
    if (!runtime) return null;
    const agents = snapshot.agents.filter((agent) => agent.runtimeId === runtime.id);
    const agentIds = new Set(agents.map((agent) => agent.id));
    const tasks = snapshot.tasks.filter((task) => agentIds.has(task.agentId));
    const status = deriveRuntimeFleetStatus(snapshot, runtime, collectionHealthByDeviceId);
    const device = deviceForRuntime(snapshot, runtime);

    return {
      kind: "runtime",
      id: runtime.id,
      title: runtime.name,
      subtitle: `${runtimeKindLabels[runtime.kind]} · ${collectionStatusLabels[status]}`,
      runtimeKindLabel: runtimeKindLabels[runtime.kind],
      status,
      statusLabel: collectionStatusLabels[status],
      sections: [
        {
          title: "基础信息",
          items: [
            `Lorume ID: ${runtime.id}`,
            `Version: ${runtime.version ?? "未上报"}`,
            `状态: ${collectionStatusLabels[status]}`,
            `最近同步: ${formatRuntimeTimestamp(runtime.lastSeenAt)}`,
          ],
        },
        {
          title: "归属关系",
          items: [`所属设备: ${device ? deviceDisplayLabel(device) : runtime.deviceId}`, `Agent 数量: ${agents.length}`],
        },
        {
          title: "任务统计",
          items: taskStatisticsItems(tasks),
        },
        {
          title: "本地路径",
          items: localPathItems(runtime.diagnostics?.paths),
        },
      ],
    };
  }

  if (kind === "agent") {
    const agent = snapshot.agents.find((candidate) => candidate.id === id);
    if (!agent) return null;
    const runtime = snapshot.runtimes.find((candidate) => candidate.id === agent.runtimeId);
    const status = deriveAgentFleetStatus(snapshot, agent, collectionHealthByDeviceId);
    const device = runtime ? deviceForRuntime(snapshot, runtime) : snapshot.devices[0];
    const tasks = snapshot.tasks.filter((task) => task.agentId === agent.id);

    return {
      kind: "agent",
      id: agent.id,
      title: agent.name,
      subtitle: `${runtime?.name ?? agent.runtimeId} · ${collectionStatusLabels[status]}`,
      deviceId: device?.id ?? "unknown",
      runtimeName: runtime?.name ?? agent.runtimeId,
      runtimeId: agent.runtimeId,
      status,
      statusLabel: collectionStatusLabels[status],
      sections: [
        {
          title: "基础信息",
          items: [
            `Lorume ID: ${agent.id}`,
            `状态: ${collectionStatusLabels[status]}`,
            `最近同步: ${formatRuntimeTimestamp(runtimeAgentLastSeenAt(agent, runtime, snapshot))}`,
          ],
        },
        {
          title: "归属关系",
          items: [
            `所属 Runtime: ${runtime?.name ?? agent.runtimeId}`,
            `所属设备: ${device ? deviceDisplayLabel(device) : runtime?.deviceId ?? "unknown"}`,
          ],
        },
        {
          title: "任务统计",
          items: taskStatisticsItems(tasks),
        },
        {
          title: "本地路径",
          items: localPathItems(agent.diagnostics?.paths),
        },
      ],
    };
  }

  return null;
}

/** Map device connection diagnostics into the same four labels used by collection status. */
export function runtimeFleetStatusFromDeviceHealth(status: DeviceHealthStatus): RuntimeFleetObjectStatus {
  if (status === "online") return "online";
  if (status === "offline") return "offline";
  if (status === "abnormal") return "error";
  return "syncing";
}

/** Parse backend Runtime Fleet payloads into the four-object product model. */
export function runtimeFleetSnapshotFromQueryResponse(value: unknown): RuntimeFleetSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    agents?: unknown[];
    devices?: unknown[];
    observedAt?: unknown;
    runtimes?: unknown[];
    tasks?: unknown[];
  };
  if (!Array.isArray(candidate.devices) || !Array.isArray(candidate.runtimes) || !Array.isArray(candidate.agents)) {
    return null;
  }
  const observedAt = typeof candidate.observedAt === "string"
    ? candidate.observedAt
    : new Date().toISOString();
  const snapshot = createDeviceStateSnapshot({
    observedAt,
    device: candidate.devices[0] ?? { id: "backend", hostname: "backend", os: "unknown" },
    runtimes: candidate.runtimes,
    agents: candidate.agents,
    tasks: Array.isArray(candidate.tasks) ? candidate.tasks : [],
  });
  return {
    observedAt: snapshot.observedAt,
    devices: candidate.devices.map((device) => createDeviceStateSnapshot({
      observedAt,
      device,
      runtimes: [],
      agents: [],
      tasks: [],
    }).device),
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    tasks: snapshot.tasks,
  };
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCollectionStatus(value: unknown): CollectionStatus {
  return value === "online" || value === "offline" || value === "error" || value === "syncing"
    ? value
    : "syncing";
}

function deviceForRuntime(snapshot: RuntimeFleetSnapshot, runtime: Runtime): Device | undefined {
  return snapshot.devices.find((device) => device.id === runtime.deviceId);
}

function deviceDisplayLabel(device: Device): string {
  return device.id;
}

function matchesLastSeenRange(value: string | undefined, range: RuntimeFleetLastSeenRange): boolean {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return false;
  const now = Date.now();
  const rangeMs = range === "24h"
    ? 24 * 60 * 60 * 1000
    : range === "7d"
      ? 7 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  return timestamp >= now - rangeMs && timestamp <= now + 60 * 1000;
}

function includesQuery(values: Array<string | undefined>, query: string): boolean {
  return values.some((value) => value?.toLowerCase().includes(query));
}

function deviceMatches(device: Device, query: string): boolean {
  return includesQuery(
    [
      device.id,
      device.hostname,
      device.os,
      device.architecture,
      device.user?.username,
      device.network?.publicIp,
      ...(device.network?.localIps ?? []),
    ],
    query,
  );
}

function runtimeMatches(runtime: Runtime, query: string): boolean {
  return includesQuery(
    [
      runtime.id,
      runtime.name,
      runtime.kind,
      runtimeKindLabels[runtime.kind],
      runtime.version,
      ...localPathItems(runtime.diagnostics?.paths),
      runtime.diagnostics?.lastError,
    ],
    query,
  );
}

function agentMatches(agent: Agent, query: string): boolean {
  return includesQuery(
    [
      agent.id,
      agent.name,
      ...localPathItems(agent.diagnostics?.paths),
      agent.diagnostics?.lastError,
    ],
    query,
  );
}

function taskMatches(task: Task, query: string): boolean {
  return includesQuery(
    [
      task.id,
      task.title,
      task.description,
      task.status,
      task.channel?.kind,
      task.channel?.name,
      task.conversation?.title,
      task.creator?.name,
      task.assignee?.name,
      task.error,
    ],
    query,
  );
}

function registeredRuntimeLabels(runtimes: Runtime[]): string[] {
  const labels = runtimes.map(runtimeDisplayName);
  return labels.length ? Array.from(new Set(labels)).sort() : ["暂无已注册 Runtime"];
}

function taskStatisticsItems(tasks: Task[]): string[] {
  const counts = countTasksByStatus(tasks);
  return [
    `全部任务: ${tasks.length}`,
    `待处理: ${counts.todo}`,
    `进行中: ${counts.in_progress}`,
    `待验收: ${counts.review}`,
    `阻塞: ${counts.blocked}`,
    `失败: ${counts.failed}`,
  ];
}

function countTasksByStatus(tasks: Task[]): Record<TaskStatus, number> {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

function localPathItems(paths?: Array<{ label: string; path: string }>): string[] {
  return (paths ?? [])
    .filter((entry) => entry.path)
    .map((entry) => `${entry.label}: ${entry.path}`);
}
