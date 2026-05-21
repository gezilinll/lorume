import {
  RUNTIME_KINDS,
  type LorumeRuntime,
  type ChannelKind,
  type RuntimeActivityStats,
  type RuntimeSource,
  type ManagedAgentStatus,
  type ManagedRuntimeAgent,
  type RuntimeDevice,
  type RuntimeInventorySnapshot,
  type RuntimeKind,
  type RuntimeObjectPath,
} from "./runtime-normalize";
import type {
  RuntimeObservationCapability,
  RuntimeWorkParticipant,
} from "./runtime-work-state";
import {
  deriveRuntimeWorkStage,
  type RuntimeExecution,
  type RuntimeWorkItem,
  type RuntimeWorkStateSnapshot,
} from "./runtime-work-state";
import type { DeviceCollectionHealth } from "./runtime-collection-health";
import type { DeviceHealthStatus, DeviceHealthStatusResult } from "./runtime-device-health";

/** Runtime kind labels used by the Runtime Fleet page. */
export const runtimeKindLabels: Record<RuntimeKind, string> = {
  openclaw: "OpenClaw",
  codex: "Codex",
  claude_code: "Claude Code",
  slock: "Slock",
  multica: "Multica",
  unknown: "未识别",
};

/** Channel labels used when an Agent is exposed through a chat or platform surface. */
export const channelKindLabels: Record<ChannelKind, string> = {
  dingtalk: "DingTalk",
  telegram: "Telegram",
  slack: "Slack",
  slock: "Slock",
  multica: "Multica",
  openclaw: "OpenClaw",
  other: "Other",
};

/** Runtime operating state derived by Lorume from linked Agent work evidence. */
export type RuntimeOperatingStatus = "working" | "idle" | "offline" | "unknown";

/** User-facing object status after availability, work evidence, and collection diagnostics are folded together. */
export type RuntimeFleetObjectStatus = "working" | "idle" | "offline" | "exception";

/** Coarse observation time range for Runtime Fleet filtering. */
export type RuntimeFleetLastSeenRange = "all" | "24h" | "7d" | "30d";

/** Runtime operating labels for Runtime Fleet. */
export const runtimeOperatingStatusLabels: Record<RuntimeOperatingStatus, string> = {
  working: "工作中",
  idle: "空闲",
  offline: "离线",
  unknown: "异常",
};

/** Compact Runtime Fleet status labels. These are the only status labels shown for assets. */
export const runtimeFleetObjectStatusLabels: Record<RuntimeFleetObjectStatus, string> = {
  working: "工作中",
  idle: "空闲",
  offline: "离线",
  exception: "异常",
};

type DeviceHealthById = ReadonlyMap<string, Pick<DeviceHealthStatusResult, "label" | "status">>;

/** Agent status labels after source-specific states are normalized. */
export const managedAgentStatusLabels: Record<ManagedAgentStatus, string> = {
  active: "工作中",
  idle: "空闲",
  inactive: "离线",
  degraded: "异常",
  unknown: "异常",
};

const unsupportedStatLabel = "不支持采集";

/** Runtime kind option shown by Runtime Fleet. */
export interface RuntimeFleetRuntimeKindOption {
  /** Filter value. */
  value: RuntimeKind;
  /** Human-readable label. */
  label: string;
}

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
export function runtimeDisplayName(runtime: LorumeRuntime): string {
  return runtime.name;
}

/** Resolve the best available observation time for an Agent row or detail view. */
export function runtimeAgentLastSeenAt(
  agent: ManagedRuntimeAgent,
  runtime?: LorumeRuntime,
  snapshot?: RuntimeInventorySnapshot,
): string | undefined {
  return agent.lastSeenAt ?? runtime?.lastSeenAt ?? snapshot?.observedAt;
}

/** List runtime kinds actually present in the current Runtime Fleet snapshot. */
export function listRuntimeFleetRuntimeKindOptions(snapshot: RuntimeInventorySnapshot): RuntimeFleetRuntimeKindOption[] {
  const kinds = new Set(snapshot.runtimes.map((runtime) => runtime.kind));
  return RUNTIME_KINDS
    .filter((kind) => kinds.has(kind))
    .map((kind) => ({ value: kind, label: runtimeKindLabels[kind] }));
}

/** Derive a runtime's coarse operating state without exposing source-platform raw states. */
export function deriveRuntimeOperatingStatus(
  snapshot: RuntimeInventorySnapshot,
  runtime: LorumeRuntime,
  workState?: RuntimeWorkStateSnapshot | null,
): RuntimeOperatingStatus {
  if (runtime.status === "offline") return "offline";

  const runtimeAgentIds = new Set(
    snapshot.agents.filter((agent) => agent.runtimeId === runtime.id).map((agent) => agent.id),
  );

  const linkedWorkItems = (workState?.workItems ?? []).filter((workItem) =>
    isWorkItemLinkedToRuntime(workItem, runtime, runtimeAgentIds),
  );
  if (linkedWorkItems.some((workItem) => isProcessingWorkItem(workItem, workState))) return "working";

  const linkedExecutions = selectLatestExecutions(workState?.executions ?? []).filter((execution) =>
    isExecutionLinkedToRuntime(execution, runtime, runtimeAgentIds),
  );
  if (linkedExecutions.some((execution) => execution.status === "queued" || execution.status === "running")) {
    return "working";
  }

  if (linkedWorkItems.length > 0 || linkedExecutions.length > 0) return "idle";

  if (workState && canObserveRuntimeWork(workState.capabilities, runtime)) return "idle";

  return "unknown";
}

/** Derive an Agent's display state from Lorume work evidence before falling back to raw inventory state. */
export function deriveManagedAgentDisplayStatus(
  snapshot: RuntimeInventorySnapshot,
  agent: ManagedRuntimeAgent,
  workState?: RuntimeWorkStateSnapshot | null,
): ManagedAgentStatus {
  if (agent.status === "inactive" || agent.status === "degraded") return agent.status;
  if (!workState) return agent.status;

  const runtime = snapshot.runtimes.find((candidate) => candidate.id === agent.runtimeId);
  if (runtime?.status === "offline") return agent.status;

  const linkedWorkItems = workState.workItems.filter((workItem) => isWorkItemLinkedToAgent(workItem, agent));
  if (linkedWorkItems.some((workItem) => isProcessingWorkItem(workItem, workState))) return "active";

  const linkedExecutions = selectLatestExecutions(workState.executions).filter(
    (execution) => execution.agentId === agent.id,
  );
  if (linkedExecutions.some((execution) => execution.status === "queued" || execution.status === "running")) {
    return "active";
  }

  if (linkedWorkItems.length > 0 || linkedExecutions.length > 0) return "idle";
  if (canObserveAgentWork(workState.capabilities, agent)) return "idle";

  return agent.status;
}

/** Filter state supported by the first Runtime Fleet page. */
export interface RuntimeFleetFilters {
  /** Free-text search across device, runtime, agent, channel, and source labels. */
  query?: string;
  /** Runtime or platform kind to keep. */
  runtimeKind?: RuntimeKind | "all";
  /** Optional last-observed range for device/runtime/agent rows. */
  lastSeenRange?: RuntimeFleetLastSeenRange;
}

/** Filtered device inventory shown by Runtime Fleet. */
export interface RuntimeFleetResult {
  /** Device that produced the latest snapshot. */
  device: RuntimeDevice;
  /** Devices represented by the active filters. */
  devices: RuntimeDevice[];
  /** Runtimes matching the active filters. */
  runtimes: LorumeRuntime[];
  /** Agents matching the active filters. */
  agents: ManagedRuntimeAgent[];
}

/** Small summary cards for Runtime Fleet. */
export interface RuntimeFleetSummary {
  /** Registered devices represented by the snapshot. */
  devices: number;
  /** Total runtime count represented by the snapshot. */
  runtimes: number;
  /** Total managed agent count represented by the snapshot. */
  agents: number;
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

/** Summarize one device snapshot for Runtime Fleet cards. */
export function summarizeRuntimeFleet(
  snapshot: RuntimeInventorySnapshot,
  _workState?: RuntimeWorkStateSnapshot | null,
): RuntimeFleetSummary {
  return {
    devices: runtimeFleetDevices(snapshot).length,
    runtimes: snapshot.runtimes.length,
    agents: snapshot.agents.length,
  };
}

/** Fold collection health and normalized inventory into one device status for Runtime Fleet. */
export function deriveDeviceFleetStatus(
  _snapshot: RuntimeInventorySnapshot,
  device: RuntimeDevice,
  collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
): RuntimeFleetObjectStatus {
  if (collectionHealthByDeviceId?.get(device.id)?.status === "failed") return "exception";
  return "working";
}

/** Fold runtime availability, work evidence, and collection diagnostics into one Runtime status. */
export function deriveRuntimeFleetStatus(
  snapshot: RuntimeInventorySnapshot,
  runtime: LorumeRuntime,
  workState?: RuntimeWorkStateSnapshot | null,
  collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
): RuntimeFleetObjectStatus {
  const device = deviceForRuntime(snapshot, runtime);
  if (device) {
    const deviceStatus = deriveDeviceFleetStatus(snapshot, device, collectionHealthByDeviceId);
    if (deviceStatus === "exception" || deviceStatus === "offline") return deviceStatus;
  }
  if (runtime.status === "offline") return "offline";
  if (runtime.status === "degraded" || runtime.status === "unknown") return "exception";

  const operatingStatus = deriveRuntimeOperatingStatus(snapshot, runtime, workState);
  if (operatingStatus === "working" || operatingStatus === "idle" || operatingStatus === "offline") {
    return operatingStatus;
  }
  return "exception";
}

/** Fold Agent inventory state, work evidence, and parent object health into one Agent status. */
export function deriveAgentFleetStatus(
  snapshot: RuntimeInventorySnapshot,
  agent: ManagedRuntimeAgent,
  workState?: RuntimeWorkStateSnapshot | null,
  collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
): RuntimeFleetObjectStatus {
  const runtime = snapshot.runtimes.find((candidate) => candidate.id === agent.runtimeId);
  if (runtime) {
    const runtimeStatus = deriveRuntimeFleetStatus(snapshot, runtime, workState, collectionHealthByDeviceId);
    if (runtimeStatus === "exception" || runtimeStatus === "offline") return runtimeStatus;
  } else {
    return "exception";
  }

  const displayStatus = deriveManagedAgentDisplayStatus(snapshot, agent, workState);
  if (displayStatus === "active") return "working";
  if (displayStatus === "idle") return "idle";
  if (displayStatus === "inactive") return "offline";
  return "exception";
}

/** Filter a runtime snapshot while preserving the current device context. */
export function filterRuntimeFleet(
  snapshot: RuntimeInventorySnapshot,
  filters: RuntimeFleetFilters = {},
): RuntimeFleetResult {
  const query = normalizeSearch(filters.query ?? "");

  let runtimes = snapshot.runtimes;
  let agents = snapshot.agents;
  let devices = runtimeFleetDevices(snapshot);

  if (filters.runtimeKind && filters.runtimeKind !== "all") {
    runtimes = runtimes.filter((runtime) => runtime.kind === filters.runtimeKind);
    const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
    agents = agents.filter((agent) => runtimeIds.has(agent.runtimeId));
  }

  if (filters.lastSeenRange && filters.lastSeenRange !== "all") {
    const lastSeenRange = filters.lastSeenRange;
    runtimes = runtimes.filter((runtime) => matchesLastSeenRange(runtime.lastSeenAt, lastSeenRange));
    const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
    agents = agents.filter((agent) =>
      runtimeIds.has(agent.runtimeId) || matchesLastSeenRange(agent.lastSeenAt, lastSeenRange),
    );
  }

  if (query) {
    const matchingDevices = devices.filter((device) => deviceMatches(device, query));
    const matchingDeviceIds = new Set(matchingDevices.map((device) => device.id));
    const matchingRuntimes = runtimes.filter((runtime) => runtimeMatches(runtime, query));
    const matchingRuntimeIds = new Set(matchingRuntimes.map((runtime) => runtime.id));
    const matchingAgents = agents.filter(
      (agent) => matchingRuntimeIds.has(agent.runtimeId) || agentMatches(agent, query),
    );
    const agentRuntimeIds = new Set(matchingAgents.map((agent) => agent.runtimeId));

    runtimes = runtimes.filter((runtime) =>
      matchingDeviceIds.has(runtime.deviceId) ||
      matchingRuntimeIds.has(runtime.id) ||
      agentRuntimeIds.has(runtime.id),
    );
    agents = matchingAgents;
    if (matchingDeviceIds.size > 0) {
      const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
      agents = snapshot.agents.filter((agent) => runtimeIds.has(agent.runtimeId) || agentMatches(agent, query));
    }
  }

  const visibleDeviceIds = new Set([
    ...runtimes.map((runtime) => runtime.deviceId),
    ...agents
      .map((agent) => snapshot.runtimes.find((runtime) => runtime.id === agent.runtimeId)?.deviceId)
      .filter((deviceId): deviceId is string => Boolean(deviceId)),
  ]);
  devices = devices.filter((device) => visibleDeviceIds.size === 0 ? false : visibleDeviceIds.has(device.id));

  return {
    device: snapshot.device,
    devices,
    runtimes,
    agents,
  };
}

/** Resolve a detail panel object from the latest snapshot. */
export function getRuntimeFleetDetail(
  snapshot: RuntimeInventorySnapshot,
  kind: RuntimeFleetDetail["kind"],
  id: string,
  workState?: RuntimeWorkStateSnapshot | null,
  collectionHealthByDeviceId?: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>,
  deviceHealthByDeviceId?: DeviceHealthById,
): RuntimeFleetDetail | null {
  const devices = runtimeFleetDevices(snapshot);

  if (kind === "device") {
    const device = devices.find((candidate) => candidate.id === id);
    if (!device) return null;
    const runtimes = snapshot.runtimes.filter((runtime) => runtime.deviceId === device.id);
    const deviceHealth = deviceHealthByDeviceId?.get(device.id);
    const status = deviceHealth
      ? runtimeFleetStatusFromDeviceHealth(deviceHealth.status)
      : deriveDeviceFleetStatus(snapshot, device, collectionHealthByDeviceId);
    const statusLabel = deviceHealth?.label ?? runtimeFleetObjectStatusLabels[status];
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
            `Collector: ${snapshot.collector.version}`,
            `Runtime 数量: ${runtimes.length}`,
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
    const status = deriveRuntimeFleetStatus(snapshot, runtime, workState, collectionHealthByDeviceId);
    const device = deviceForRuntime(snapshot, runtime);

    return {
      kind: "runtime",
      id: runtime.id,
      title: runtime.name,
      subtitle: `${runtimeKindLabels[runtime.kind]} · ${runtimeFleetObjectStatusLabels[status]}`,
      runtimeKindLabel: runtimeKindLabels[runtime.kind],
      status,
      statusLabel: runtimeFleetObjectStatusLabels[status],
      sections: [
        {
          title: "基础信息",
          items: [
            `Lorume ID: ${runtime.id}`,
            `Version: ${runtime.version ?? "未上报"}`,
            `状态: ${runtimeFleetObjectStatusLabels[status]}`,
            `最近同步: ${formatRuntimeTimestamp(runtime.lastSeenAt)}`,
          ],
        },
        {
          title: "归属关系",
          items: [`所属设备: ${device ? deviceDisplayLabel(device) : runtime.deviceId}`, `Agent 数量: ${agents.length}`],
        },
        {
          title: "本地路径",
          items: localPathItems(runtime.paths),
        },
      ],
    };
  }

  if (kind === "agent") {
    const agent = snapshot.agents.find((candidate) => candidate.id === id);
    if (!agent) return null;
    const runtime = snapshot.runtimes.find((candidate) => candidate.id === agent.runtimeId);
    const status = deriveAgentFleetStatus(snapshot, agent, workState, collectionHealthByDeviceId);
    const device = runtime ? deviceForRuntime(snapshot, runtime) : snapshot.device;

    return {
      kind: "agent",
      id: agent.id,
      title: agent.name,
      subtitle: `${sourceLabel(agent.origin)} · ${runtimeFleetObjectStatusLabels[status]}`,
      deviceId: device?.id ?? snapshot.device.id,
      runtimeName: runtime?.name ?? agent.runtimeId,
      runtimeId: agent.runtimeId,
      status,
      statusLabel: runtimeFleetObjectStatusLabels[status],
      sections: [
        {
          title: "基础信息",
          items: [
            `Lorume ID: ${agent.id}`,
            `状态: ${runtimeFleetObjectStatusLabels[status]}`,
            `最近同步: ${formatRuntimeTimestamp(runtimeAgentLastSeenAt(agent, runtime, snapshot))}`,
          ],
        },
        {
          title: "归属关系",
          items: [
            `所属 Runtime: ${runtime?.name ?? agent.runtimeId}`,
            `所属设备: ${device ? deviceDisplayLabel(device) : runtime?.deviceId ?? snapshot.device.id}`,
          ],
        },
        {
          title: "关联渠道",
          items: labelsForAgent(agent),
        },
        {
          title: "本地路径",
          items: localPathItems(agent.paths),
        },
        {
          title: "运行统计",
          items: runtimeStatisticsItems(deriveAgentRuntimeStats(agent, workState)),
        },
      ],
    };
  }

  return null;
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function runtimeFleetDevices(snapshot: RuntimeInventorySnapshot): RuntimeDevice[] {
  return Array.isArray(snapshot.devices) ? snapshot.devices : [snapshot.device];
}

export function runtimeFleetStatusFromDeviceHealth(status: DeviceHealthStatus): RuntimeFleetObjectStatus {
  if (status === "online") return "working";
  if (status === "offline") return "offline";
  if (status === "abnormal") return "exception";
  return "idle";
}

function deviceForRuntime(snapshot: RuntimeInventorySnapshot, runtime: LorumeRuntime): RuntimeDevice | undefined {
  return runtimeFleetDevices(snapshot).find((device) => device.id === runtime.deviceId);
}

function deviceDisplayLabel(device: RuntimeDevice): string {
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

function isWorkItemLinkedToRuntime(
  workItem: RuntimeWorkItem,
  runtime: LorumeRuntime,
  runtimeAgentIds: Set<string>,
): boolean {
  return workItem.runtimeId === runtime.id || Boolean(workItem.agentId && runtimeAgentIds.has(workItem.agentId));
}

function isExecutionLinkedToRuntime(
  execution: RuntimeExecution,
  runtime: LorumeRuntime,
  runtimeAgentIds: Set<string>,
): boolean {
  return execution.runtimeId === runtime.id || Boolean(execution.agentId && runtimeAgentIds.has(execution.agentId));
}

function isConversationLinkedToAgent(
  conversation: NonNullable<RuntimeWorkStateSnapshot["conversations"]>[number],
  agent: ManagedRuntimeAgent,
  linkedWorkItemIds: Set<string>,
): boolean {
  return conversation.agentId === agent.id || Boolean(conversation.workItemId && linkedWorkItemIds.has(conversation.workItemId));
}

function isWorkItemLinkedToAgent(workItem: RuntimeWorkItem, agent: ManagedRuntimeAgent): boolean {
  if (workItem.source === "slock" && workItem.assignee?.label) {
    return participantMatchesAgent(workItem.assignee, agent);
  }
  if (participantMatchesAgent(workItem.assignee, agent)) return true;
  return workItem.agentId === agent.id;
}

function participantMatchesAgent(
  participant: RuntimeWorkParticipant | undefined,
  agent: ManagedRuntimeAgent,
): boolean {
  if (!participant) return false;
  if (participant.objectId === agent.id) return true;
  return normalizeParticipantLabel(participant.label) === normalizeParticipantLabel(agent.name);
}

function normalizeParticipantLabel(value: string | undefined): string {
  return (value ?? "").trim().replace(/^@+/, "").toLowerCase();
}

function deriveAgentRuntimeStats(
  agent: ManagedRuntimeAgent,
  workState?: RuntimeWorkStateSnapshot | null,
): RuntimeActivityStats & { lastError?: string } | undefined {
  if (!workState) return agent.load;

  const linkedWorkItems = workState.workItems.filter((workItem) => isWorkItemLinkedToAgent(workItem, agent));
  const linkedWorkItemIds = new Set(linkedWorkItems.map((workItem) => workItem.id));
  const linkedExecutions = selectLatestExecutions(workState.executions).filter((execution) =>
    execution.agentId === agent.id || Boolean(execution.workItemId && linkedWorkItemIds.has(execution.workItemId)),
  );
  const linkedConversations = workState.conversations.filter((conversation) =>
    isConversationLinkedToAgent(conversation, agent, linkedWorkItemIds),
  );
  const hasObservableAgentWork = linkedWorkItems.length > 0 ||
    linkedExecutions.length > 0 ||
    linkedConversations.length > 0 ||
    canObserveAgentWork(workState.capabilities, agent);

  if (!hasObservableAgentWork) return agent.load;

  const activeWorkItems = linkedWorkItems.filter((workItem) =>
    deriveRuntimeWorkStage({
      source: workItem.source,
      workItemStatus: workItem.status,
      executionStatus: linkedExecutions.find((execution) => execution.workItemId === workItem.id)?.status,
    }).stage === "processing",
  ).length;
  const queuedWorkItems = linkedWorkItems.filter((workItem) =>
    deriveRuntimeWorkStage({
      source: workItem.source,
      workItemStatus: workItem.status,
      executionStatus: linkedExecutions.find((execution) => execution.workItemId === workItem.id)?.status,
    }).stage === "pending",
  ).length;
  const standaloneRunningExecutions = linkedExecutions.filter((execution) =>
    !execution.workItemId && (execution.status === "queued" || execution.status === "running"),
  );

  return {
    ...agent.load,
    activeTasks: activeWorkItems + standaloneRunningExecutions.filter((execution) => execution.status === "running").length,
    queuedTasks: queuedWorkItems + standaloneRunningExecutions.filter((execution) => execution.status === "queued").length,
    activeSessions: linkedConversations.filter((conversation) => conversation.status === "active" || conversation.status === "open").length,
    historicalSessions: linkedConversations.length,
  };
}

function isProcessingWorkItem(workItem: RuntimeWorkItem, workState?: RuntimeWorkStateSnapshot | null): boolean {
  const execution = selectLatestExecutions(workState?.executions ?? []).find(
    (candidate) => candidate.workItemId === workItem.id,
  );
  return deriveRuntimeWorkStage({
    source: workItem.source,
    workItemStatus: workItem.status,
    executionStatus: execution?.status,
  }).stage === "processing";
}

function selectLatestExecutions(executions: RuntimeExecution[]): RuntimeExecution[] {
  const latestByWork = new Map<string, RuntimeExecution>();
  for (const execution of executions) {
    const key = execution.workItemId ?? execution.id;
    const current = latestByWork.get(key);
    if (!current || isExecutionMoreRecent(execution, current)) latestByWork.set(key, execution);
  }
  return Array.from(latestByWork.values());
}

function isExecutionMoreRecent(candidate: RuntimeExecution, current: RuntimeExecution): boolean {
  const candidateTime = executionObservedTime(candidate);
  const currentTime = executionObservedTime(current);
  if (Number.isFinite(candidateTime) && Number.isFinite(currentTime) && candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }
  if (Number.isFinite(candidateTime) && !Number.isFinite(currentTime)) return true;
  return false;
}

function executionObservedTime(execution: RuntimeExecution): number {
  return Date.parse(execution.lastSeenAt ?? execution.endedAt ?? execution.startedAt ?? execution.queuedAt ?? "");
}

function canObserveRuntimeWork(
  capabilities: RuntimeObservationCapability[],
  runtime: LorumeRuntime,
): boolean {
  const runtimeSources = new Set([runtime.kind, ...runtime.sourceRefs.map((ref) => ref.source)]);
  return capabilities.some((capability) =>
    runtimeSources.has(capability.source) &&
    [capability.workItems.support, capability.executions.support].some((support) =>
      support === "supported" || support === "partial",
    ),
  );
}

function canObserveAgentWork(
  capabilities: RuntimeObservationCapability[],
  agent: ManagedRuntimeAgent,
): boolean {
  const agentSources = new Set([agent.origin, ...agent.sourceRefs.map((ref) => ref.source)]);
  return capabilities.some((capability) =>
    agentSources.has(capability.source) &&
    [capability.workItems.support, capability.executions.support].some((support) =>
      support === "supported" || support === "partial",
    ),
  );
}

function includesQuery(values: Array<string | undefined>, query: string): boolean {
  return values.some((value) => value?.toLowerCase().includes(query));
}

function deviceMatches(device: RuntimeDevice, query: string): boolean {
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

function runtimeMatches(runtime: LorumeRuntime, query: string): boolean {
  return includesQuery(
    [
      runtime.name,
      runtime.kind,
      runtimeKindLabels[runtime.kind],
      runtime.version,
      runtime.endpoint,
      ...localPathItems(runtime.paths),
      ...runtime.capabilities,
      ...runtime.sourceRefs.flatMap((ref) => [ref.source, ref.externalId, ref.label, ref.url]),
    ],
    query,
  );
}

function agentMatches(agent: ManagedRuntimeAgent, query: string): boolean {
  return includesQuery(
    [
      agent.name,
      agent.origin,
      sourceLabel(agent.origin),
      agent.status,
      ...localPathItems(agent.paths),
      ...agent.channelBindings.flatMap((binding) => [
        binding.kind,
        channelKindLabels[binding.kind],
        binding.label,
        binding.externalId,
        binding.status,
      ]),
      ...agent.sourceRefs.flatMap((ref) => [ref.source, ref.externalId, ref.label, ref.url]),
    ],
    query,
  );
}

function labelsForAgent(agent: ManagedRuntimeAgent): string[] {
  const labels = agent.channelBindings.map((binding) => binding.label || channelKindLabels[binding.kind]);
  return labels.length ? labels : ["暂无关联渠道"];
}

function labelsForAgents(agents: ManagedRuntimeAgent[]): string[] {
  return Array.from(
    new Set(
      agents.flatMap((agent) =>
        agent.channelBindings.map((binding) => binding.label || channelKindLabels[binding.kind]),
      ),
    ),
  ).sort();
}

function registeredRuntimeLabels(runtimes: LorumeRuntime[]): string[] {
  const labels = runtimes.map(runtimeDisplayName);
  return labels.length ? Array.from(new Set(labels)).sort() : ["暂无已注册 Runtime"];
}

function runtimeStatisticsItems(stats?: RuntimeActivityStats & { lastError?: string }): string[] {
  return [
    `活跃任务: ${statValue(stats?.activeTasks)}`,
    `队列深度: ${statValue(stats?.queuedTasks)}`,
    `活跃会话: ${statValue(stats?.activeSessions)}`,
    `历史会话: ${statValue(stats?.historicalSessions)}`,
    `最大并发: ${statValue(stats?.maxConcurrency)}`,
    stats?.lastError ? `最近错误: ${stats.lastError}` : "",
  ].filter(Boolean);
}

function localPathItems(paths?: RuntimeObjectPath[]): string[] {
  return (paths ?? [])
    .filter((entry) => entry.path)
    .map((entry) => `${entry.label}: ${entry.path}`);
}

function statValue(value?: number): string {
  return value === undefined ? unsupportedStatLabel : String(value);
}

function sourceLabel(source: RuntimeSource): string {
  return source === "manual" ? "Manual" : runtimeKindLabels[source];
}
