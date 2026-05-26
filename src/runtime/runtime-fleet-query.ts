import {
  createDeviceStateSnapshot,
  type Agent,
  type AgentCollectionStatus,
  type CollectionStatus,
  type Device,
  type RuntimeFleetTaskSummary,
  type Runtime,
  type RuntimeKind,
  type TaskChannelKind,
  type TaskStatusCounts,
  createEmptyRuntimeFleetTaskSummary,
  createEmptyTaskStatusCounts,
  TASK_CHANNEL_KIND_LABELS,
} from "./runtime-model";
import type { DeviceCollectionHealth } from "./runtime-collection-health";
import type { DeviceHealthStatus, DeviceHealthStatusResult } from "./runtime-device-health";

/** Runtime kind labels used by the Runtime Fleet page. */
export const runtimeKindLabels: Record<RuntimeKind, string> = {
  codex: "Codex",
  openclaw: "OpenClaw",
};

/** Channel labels used when a Task includes user-facing channel context. */
export const channelKindLabels: Record<TaskChannelKind, string> = {
  ...TASK_CHANNEL_KIND_LABELS,
};

/** Product collection status labels shown for Device, Runtime, and Agent rows. */
export const collectionStatusLabels: Record<RuntimeFleetObjectStatus, string> = {
  syncing: "同步中",
  online: "在线",
  offline: "离线",
  error: "异常",
  invisible: "不可见",
};

/** Alias used by page components for Runtime Fleet object labels. */
export const runtimeFleetObjectStatusLabels = collectionStatusLabels;

/** Normalized Runtime Fleet object status. */
export type RuntimeFleetObjectStatus = CollectionStatus | AgentCollectionStatus;

/** Backend/UI Runtime Fleet snapshot built from the four top-level product objects. */
export interface RuntimeFleetSnapshot {
  /** Collector completion time across the result set. */
  collectedAt: string;
  /** Devices represented by the query. */
  devices: Device[];
  /** Runtime objects represented by the query. */
  runtimes: Runtime[];
  /** Agent objects represented by the query. */
  agents: Agent[];
  /** Active Task counts derived by the backend without returning Task rows. */
  taskSummary: RuntimeFleetTaskSummary;
  /** Top-level backend counts. */
  summary: RuntimeFleetQuerySummary;
}

export interface RuntimeFleetQuerySummary {
  deviceCount: number;
  runtimeCount: number;
  agentCount: number;
  taskCount: number;
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
  return agent.lastSeenAt ?? runtime?.lastSeenAt ?? snapshot?.collectedAt;
}

/** Summarize one query result for Runtime Fleet cards. */
export function summarizeRuntimeFleet(snapshot: RuntimeFleetSnapshot): RuntimeFleetSummary {
  return {
    agents: snapshot.summary.agentCount,
    devices: snapshot.summary.deviceCount,
    runtimes: snapshot.summary.runtimeCount,
    tasks: snapshot.summary.taskCount,
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
  return normalizeRuntimeFleetObjectStatus(agent.collectionStatus);
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
    const taskCounts = taskCountsForDevice(snapshot, device.id);
    const deviceHealth = deviceHealthByDeviceId?.get(device.id);
    const status = deviceHealth
      ? runtimeFleetStatusFromDeviceHealth(deviceHealth.status)
      : deriveDeviceFleetStatus(snapshot, device, collectionHealthByDeviceId);
    const statusLabel = deviceHealth?.label ?? collectionStatusLabels[status];
    return {
      kind: "device",
      id: device.id,
      title: deviceDisplayLabel(device),
      subtitle: `最近同步 ${formatRuntimeTimestamp(device.lastSeenAt ?? snapshot.collectedAt)}`,
      status,
      statusLabel,
      sections: [
        {
          title: "基础信息",
          items: [
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
            `Task 数量: ${taskCounts.total}`,
            `最近同步: ${formatRuntimeTimestamp(device.lastSeenAt ?? snapshot.collectedAt)}`,
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
    const taskCounts = taskCountsForRuntime(snapshot, runtime.id);
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
          items: taskStatisticsItems(taskCounts),
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
    const taskCounts = taskCountsForAgent(snapshot, agent.id);

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
          items: taskStatisticsItems(taskCounts),
        },
        {
          title: "本地路径",
          items: localPathItems(agent.diagnostics?.paths, "不适用"),
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
  if (status === "error") return "error";
  return "syncing";
}

/** Parse backend Runtime Fleet payloads into the four-object product model. */
export function runtimeFleetSnapshotFromQueryResponse(value: unknown): RuntimeFleetSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    agents?: unknown[];
    collectedAt?: unknown;
    devices?: unknown[];
    runtimes?: unknown[];
    summary?: unknown;
    taskSummary?: unknown;
  };
  if (!Array.isArray(candidate.devices) || !Array.isArray(candidate.runtimes) || !Array.isArray(candidate.agents)) {
    return null;
  }
  const collectedAt = typeof candidate.collectedAt === "string"
    ? candidate.collectedAt
    : new Date().toISOString();
  const snapshot = createDeviceStateSnapshot({
    collectedAt,
    device: candidate.devices[0] ?? { id: "backend", hostname: "backend", os: "unknown" },
    runtimes: candidate.runtimes,
    agents: candidate.agents,
    tasks: [],
  });
  const devices = candidate.devices.map((device) => createDeviceStateSnapshot({
    collectedAt,
    device,
    runtimes: [],
    agents: [],
    tasks: [],
  }).device);
  const taskSummary = normalizeRuntimeFleetTaskSummary(candidate.taskSummary);
  return {
    collectedAt: snapshot.collectedAt,
    devices,
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    taskSummary,
    summary: normalizeRuntimeFleetQuerySummary(candidate.summary, {
      agentCount: snapshot.agents.length,
      deviceCount: devices.length,
      runtimeCount: snapshot.runtimes.length,
      taskCount: totalTaskCount(taskSummary),
    }),
  };
}

function normalizeCollectionStatus(value: unknown): CollectionStatus {
  return value === "online" || value === "offline" || value === "error" || value === "syncing"
    ? value
    : "syncing";
}

function normalizeRuntimeFleetObjectStatus(value: unknown): RuntimeFleetObjectStatus {
  if (value === "invisible") return value;
  return normalizeCollectionStatus(value);
}

function deviceForRuntime(snapshot: RuntimeFleetSnapshot, runtime: Runtime): Device | undefined {
  return snapshot.devices.find((device) => device.id === runtime.deviceId);
}

function deviceDisplayLabel(device: Device): string {
  return device.id;
}

function registeredRuntimeLabels(runtimes: Runtime[]): string[] {
  const labels = runtimes.map(runtimeDisplayName);
  return labels.length ? Array.from(new Set(labels)).sort() : ["暂无已注册 Runtime"];
}

function taskStatisticsItems(counts: TaskStatusCounts): string[] {
  return [
    `全部任务: ${counts.total}`,
    `待处理: ${counts.todo}`,
    `进行中: ${counts.in_progress}`,
    `待验收: ${counts.review}`,
    `阻塞: ${counts.blocked}`,
    `失败: ${counts.failed}`,
  ];
}

function taskCountsForDevice(snapshot: RuntimeFleetSnapshot, deviceId: string): TaskStatusCounts {
  return snapshot.taskSummary.byDeviceId[deviceId] ?? createEmptyTaskStatusCounts();
}

function taskCountsForRuntime(snapshot: RuntimeFleetSnapshot, runtimeId: string): TaskStatusCounts {
  return snapshot.taskSummary.byRuntimeId[runtimeId] ?? createEmptyTaskStatusCounts();
}

function taskCountsForAgent(snapshot: RuntimeFleetSnapshot, agentId: string): TaskStatusCounts {
  return snapshot.taskSummary.byAgentId[agentId] ?? createEmptyTaskStatusCounts();
}

function normalizeRuntimeFleetTaskSummary(value: unknown): RuntimeFleetTaskSummary {
  if (!value || typeof value !== "object") return createEmptyRuntimeFleetTaskSummary();
  const candidate = value as Partial<Record<keyof RuntimeFleetTaskSummary, unknown>>;
  return {
    byAgentId: normalizeTaskCountMap(candidate.byAgentId),
    byDeviceId: normalizeTaskCountMap(candidate.byDeviceId),
    byRuntimeId: normalizeTaskCountMap(candidate.byRuntimeId),
  };
}

function normalizeTaskCountMap(value: unknown): Record<string, TaskStatusCounts> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, TaskStatusCounts> = {};
  for (const [id, counts] of Object.entries(value)) {
    if (!id) continue;
    output[id] = normalizeTaskStatusCounts(counts);
  }
  return output;
}

function normalizeTaskStatusCounts(value: unknown): TaskStatusCounts {
  const counts = createEmptyTaskStatusCounts();
  if (!value || typeof value !== "object" || Array.isArray(value)) return counts;
  const candidate = value as Record<string, unknown>;
  counts.todo = normalizeCount(candidate.todo);
  counts.in_progress = normalizeCount(candidate.in_progress);
  counts.review = normalizeCount(candidate.review);
  counts.done = normalizeCount(candidate.done);
  counts.blocked = normalizeCount(candidate.blocked);
  counts.failed = normalizeCount(candidate.failed);
  counts.cancelled = normalizeCount(candidate.cancelled);
  counts.unknown = normalizeCount(candidate.unknown);
  const explicitTotal = normalizeCount(candidate.total);
  counts.total = explicitTotal || counts.todo + counts.in_progress + counts.review + counts.done + counts.blocked + counts.failed + counts.cancelled + counts.unknown;
  return counts;
}

function normalizeRuntimeFleetQuerySummary(
  value: unknown,
  fallback: RuntimeFleetQuerySummary,
): RuntimeFleetQuerySummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = value as Record<string, unknown>;
  return {
    agentCount: normalizeCount(candidate.agentCount, fallback.agentCount),
    deviceCount: normalizeCount(candidate.deviceCount, fallback.deviceCount),
    runtimeCount: normalizeCount(candidate.runtimeCount, fallback.runtimeCount),
    taskCount: normalizeCount(candidate.taskCount, fallback.taskCount),
  };
}

function totalTaskCount(taskSummary: RuntimeFleetTaskSummary): number {
  return Object.values(taskSummary.byAgentId).reduce((sum, counts) => sum + counts.total, 0);
}

function normalizeCount(value: unknown, fallback = 0): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : fallback;
}

function localPathItems(paths?: Array<{ label: string; path: string }>, emptyFallback?: string): string[] {
  const items = (paths ?? [])
    .filter((entry) => entry.path)
    .map((entry) => `${entry.label}: ${entry.path}`);
  if (!items.length && emptyFallback) return [emptyFallback];
  return items;
}
