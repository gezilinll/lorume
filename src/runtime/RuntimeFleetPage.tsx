import { useEffect, useMemo, useState } from "react";
import fixtureSnapshot from "../../fixtures/runtime/runtime-fleet-device-state.sample.json";
import {
  deriveAgentFleetStatus,
  deriveDeviceFleetStatus,
  deriveRuntimeFleetStatus,
  filterRuntimeFleet,
  formatRuntimeTimestamp,
  getRuntimeFleetDetail,
  listRuntimeFleetRuntimeKindOptions,
  runtimeAgentLastSeenAt,
  runtimeFleetObjectStatusLabels,
  runtimeFleetSnapshotFromQueryResponse,
  runtimeFleetStatusFromDeviceHealth,
  runtimeKindLabels,
  summarizeRuntimeFleet,
  type RuntimeFleetDetail,
  type RuntimeFleetFilters,
  type RuntimeFleetLastSeenRange,
  type RuntimeFleetSnapshot,
} from "./runtime-fleet-query";
import type { Agent, Runtime, RuntimeKind } from "./runtime-model";
import { isFixtureFallbackAllowed } from "./runtime-data-source";
import { type CollectionHealthCheck, type DeviceCollectionHealth } from "./runtime-collection-health";
import type { DeviceHealthStatus, DeviceHealthStatusResult } from "./runtime-device-health";
import {
  normalizeAgentSkillProbeSnapshot,
  type AgentSkillProbeSnapshot,
  type AgentSkillProbeStatus,
} from "./agent-skill-probe";
import { PixelIcon } from "../ui/PixelIcon";

const fixtureRuntimeSnapshot = runtimeFleetSnapshotFromQueryResponse(fixtureSnapshot) ?? createEmptyRuntimeInventorySnapshot();
const autoRefreshIntervalMs = 30_000;
const lastSeenRangeLabels: Record<RuntimeFleetLastSeenRange, string> = {
  all: "全部时间",
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
};

type RuntimeFleetSelection = {
  kind: RuntimeFleetDetail["kind"];
  id: string;
};

type AgentSkillProbeViewState = {
  agentId: string;
  errorMessage?: string;
  isVisible: boolean;
  snapshot: AgentSkillProbeSnapshot | null;
  status: "idle" | "loading" | "ready" | "error";
};

const agentSkillProbeStatusLabels: Record<AgentSkillProbeStatus, string> = {
  unknown: "未探测",
  requested: "已请求探测",
  succeeded: "探测完成",
  unsupported: "不支持探测",
  failed: "探测失败",
  device_disconnected: "设备未连接",
};

/** First Runtime Fleet surface: inspect registered device, runtimes, agents, and channel exposure. */
export function RuntimeFleetPage() {
  const allowFixtureFallback = isFixtureFallbackAllowed();
  const [snapshot, setSnapshot] = useState<RuntimeFleetSnapshot>(
    allowFixtureFallback ? fixtureRuntimeSnapshot : createEmptyRuntimeInventorySnapshot(),
  );
  const [collectionHealth, setCollectionHealth] = useState<DeviceCollectionHealth[]>([]);
  const [deviceDiagnostics, setDeviceDiagnostics] = useState<DeviceHealthStatusResult[]>([]);
  const [loadError, setLoadError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState("");
  const [query, setQuery] = useState("");
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind | "all">("all");
  const [lastSeenRange, setLastSeenRange] = useState<RuntimeFleetLastSeenRange>("all");
  const [selection, setSelection] = useState<RuntimeFleetSelection | null>(null);
  const [agentSkillProbeState, setAgentSkillProbeState] = useState<AgentSkillProbeViewState>({
    agentId: "",
    isVisible: false,
    snapshot: null,
    status: "idle",
  });

  async function fetchLatestSnapshot(): Promise<RuntimeFleetSnapshot | null> {
    const queryResponse = await fetch(new URL("/api/runtime-fleet", window.location.origin));
    if (!queryResponse.ok) {
      throw new Error(`runtime fleet query failed: ${queryResponse.status}`);
    }
    const querySnapshot = runtimeFleetSnapshotFromQueryResponse(await queryResponse.json());
    if (!querySnapshot) throw new Error("runtime fleet query returned an invalid payload");
    return querySnapshot;
  }

  async function fetchCollectionHealth(deviceId: string): Promise<DeviceCollectionHealth | null> {
    const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/collection-health`);
    if (!response.ok) return null;
    return deviceCollectionHealthFromResponse(await response.json());
  }

  async function fetchCollectionHealthForDevices(latestSnapshot: RuntimeFleetSnapshot): Promise<DeviceCollectionHealth[]> {
    const devices = latestSnapshot.devices;
    const health = await Promise.all(
      devices.map((device) => fetchCollectionHealth(device.id).catch(() => null)),
    );
    return health.filter((value): value is DeviceCollectionHealth => Boolean(value));
  }

  async function fetchDeviceDiagnostics(deviceId: string): Promise<DeviceHealthStatusResult | null> {
    const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/diagnostics`);
    if (!response.ok) return null;
    return deviceHealthFromResponse(await response.json());
  }

  async function fetchDeviceDiagnosticsForDevices(
    latestSnapshot: RuntimeFleetSnapshot,
  ): Promise<DeviceHealthStatusResult[]> {
    const devices = latestSnapshot.devices;
    const diagnostics = await Promise.all(
      devices.map((device) => fetchDeviceDiagnostics(device.id).catch(() => null)),
    );
    return diagnostics.filter((value): value is DeviceHealthStatusResult => Boolean(value));
  }

  function applySnapshot(
    latestSnapshot: RuntimeFleetSnapshot,
    latestCollectionHealth: DeviceCollectionHealth[],
    latestDeviceDiagnostics: DeviceHealthStatusResult[],
  ) {
    setSnapshot(latestSnapshot);
    setCollectionHealth(latestCollectionHealth);
    setDeviceDiagnostics(latestDeviceDiagnostics);
    setLoadError("");
    setLastLoadedAt(new Date().toISOString());
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInitialSnapshot() {
      try {
        const latestSnapshot = await fetchLatestSnapshot();
        if (!latestSnapshot) return;
        const [latestCollectionHealth, latestDeviceDiagnostics] = await Promise.all([
          fetchCollectionHealthForDevices(latestSnapshot).catch(() => []),
          fetchDeviceDiagnosticsForDevices(latestSnapshot).catch(() => []),
        ]);
        if (!cancelled) {
          applySnapshot(latestSnapshot, latestCollectionHealth, latestDeviceDiagnostics);
        }
      } catch {
        if (!allowFixtureFallback && !cancelled) {
          setLoadError("后端查询失败，无法读取正式运行资产");
        }
      }
    }

    void loadInitialSnapshot();
    const refreshTimer = window.setInterval(() => {
      void loadInitialSnapshot();
    }, autoRefreshIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [allowFixtureFallback]);

  const runtimeKindOptions = useMemo(() => listRuntimeFleetRuntimeKindOptions(snapshot), [snapshot]);
  const collectionHealthByDeviceId = useMemo(
    () => new Map(collectionHealth.map((health) => [health.deviceId, health])),
    [collectionHealth],
  );
  const deviceDiagnosticsByDeviceId = useMemo(
    () => new Map(deviceDiagnostics.map((diagnostic) => [diagnostic.deviceId, diagnostic])),
    [deviceDiagnostics],
  );
  useEffect(() => {
    if (runtimeKind !== "all" && !runtimeKindOptions.some((option) => option.value === runtimeKind)) {
      setRuntimeKind("all");
    }
  }, [runtimeKind, runtimeKindOptions]);

  const filters: RuntimeFleetFilters = useMemo(
    () => ({ lastSeenRange, query, runtimeKind }),
    [lastSeenRange, query, runtimeKind],
  );
  const result = useMemo(() => filterRuntimeFleet(snapshot, filters), [filters, snapshot]);
  const summary = useMemo(() => summarizeRuntimeFleet(snapshot), [snapshot]);
  const detail = selection
    ? getRuntimeFleetDetail(
      snapshot,
      selection.kind,
      selection.id,
      collectionHealthByDeviceId,
      deviceDiagnosticsByDeviceId,
    )
    : null;

  async function fetchAgentSkillProbe(agentId: string): Promise<AgentSkillProbeSnapshot> {
    const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/skill-probe`);
    if (!response.ok) throw new Error(formatHttpError(response.status, "读取 Skill 探测失败"));
    const snapshot = normalizeAgentSkillProbeSnapshot(await response.json());
    if (!snapshot) throw new Error("Skill 探测返回了无效数据");
    return snapshot;
  }

  async function handleShowAgentSkillProbe(agentDetail: Extract<RuntimeFleetDetail, { kind: "agent" }>) {
    setAgentSkillProbeState({
      agentId: agentDetail.id,
      isVisible: true,
      snapshot: null,
      status: "loading",
    });
    try {
      const snapshot = await fetchAgentSkillProbe(agentDetail.id);
      setAgentSkillProbeState({
        agentId: agentDetail.id,
        isVisible: true,
        snapshot,
        status: "ready",
      });
    } catch (error) {
      setAgentSkillProbeState({
        agentId: agentDetail.id,
        isVisible: true,
        snapshot: null,
        status: "error",
        errorMessage: formatRuntimeFleetError(error, "读取 Skill 探测失败"),
      });
    }
  }

  async function handleRequestAgentSkillProbe(agentDetail: Extract<RuntimeFleetDetail, { kind: "agent" }>) {
    setAgentSkillProbeState((current) => ({
      agentId: agentDetail.id,
      isVisible: true,
      snapshot: current.agentId === agentDetail.id ? current.snapshot : null,
      status: "loading",
    }));
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentDetail.id)}/skill-probe`, {
        body: JSON.stringify({
          deviceId: agentDetail.deviceId,
          runtimeId: agentDetail.runtimeId,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await response.json();
      const snapshot = normalizeAgentSkillProbeSnapshot(
        body && typeof body === "object" && "snapshot" in body
          ? (body as { snapshot?: unknown }).snapshot
          : body,
      );
      if (!snapshot) throw new Error("Skill 探测请求返回了无效数据");
      setAgentSkillProbeState({
        agentId: agentDetail.id,
        errorMessage: response.ok ? undefined : snapshot.errorSummary,
        isVisible: true,
        snapshot,
        status: "ready",
      });
    } catch (error) {
      setAgentSkillProbeState({
        agentId: agentDetail.id,
        errorMessage: formatRuntimeFleetError(error, "请求 Skill 探测失败"),
        isVisible: true,
        snapshot: null,
        status: "error",
      });
    }
  }

  return (
    <section className="workspace">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Runtime / Device / Agent</p>
          <h1>运行资产</h1>
          <p className="pageSubtitle">查看设备、Runtime、Agent 的采集状态、归属关系和最近活动。</p>
          {lastLoadedAt ? (
            <p className="pageRefreshMeta">上次刷新 {formatRuntimeTimestamp(lastLoadedAt)}</p>
          ) : null}
        </div>
      </header>
      {loadError ? (
        <p className="pageStatus pageStatusError" role="status">
          {loadError}
        </p>
      ) : null}

      <section className="toolbar runtimeToolbar" aria-label="运行资产筛选">
        <label className="toolbarField toolbarSearch">
          <span className="controlLabel">搜索</span>
          <span className="searchBox">
            <PixelIcon name="search" size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索设备、Runtime、Agent 或任务"
            />
          </span>
        </label>

        <label className="toolbarField">
          <span className="controlLabel">Runtime</span>
          <select
            value={runtimeKind}
            onChange={(event) => setRuntimeKind(event.target.value as RuntimeKind | "all")}
          >
            <option value="all">全部</option>
            {runtimeKindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbarField">
          <span className="controlLabel">同步时间</span>
          <select
            value={lastSeenRange}
            onChange={(event) => setLastSeenRange(event.target.value as RuntimeFleetLastSeenRange)}
          >
            {(Object.keys(lastSeenRangeLabels) as RuntimeFleetLastSeenRange[]).map((option) => (
              <option key={option} value={option}>
                {lastSeenRangeLabels[option]}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="metricGrid" aria-label="运行资产概览">
        <Metric label="设备" value={summary.devices} tone="blue" />
        <Metric label="Runtime" value={summary.runtimes} tone="green" />
        <Metric label="Agent" value={summary.agents} tone="purple" />
      </section>

      <section className="runtimeFleetGrid">
        <div className="runtimeStack">
          <DevicePanel
            collectionHealthByDeviceId={collectionHealthByDeviceId}
            deviceDiagnosticsByDeviceId={deviceDiagnosticsByDeviceId}
            devices={result.devices}
            snapshot={snapshot}
            selectedId={selection?.kind === "device" ? selection.id : undefined}
            onSelect={(deviceId) => setSelection({ kind: "device", id: deviceId })}
          />
          <RuntimeTable
            collectionHealthByDeviceId={collectionHealthByDeviceId}
            snapshot={snapshot}
            runtimes={result.runtimes}
            selectedId={selection?.kind === "runtime" ? selection.id : undefined}
            onSelect={(runtime) => setSelection({ kind: "runtime", id: runtime.id })}
          />
          <AgentTable
            agents={result.agents}
            collectionHealthByDeviceId={collectionHealthByDeviceId}
            runtimes={snapshot.runtimes}
            snapshot={snapshot}
            selectedId={selection?.kind === "agent" ? selection.id : undefined}
            onSelect={(agent) => setSelection({ kind: "agent", id: agent.id })}
            onShowSkillProbe={(agent) => {
              setSelection({ kind: "agent", id: agent.id });
              const agentDetail = getRuntimeFleetDetail(
                snapshot,
                "agent",
                agent.id,
                collectionHealthByDeviceId,
              );
              if (agentDetail?.kind === "agent") void handleShowAgentSkillProbe(agentDetail);
            }}
          />
        </div>
        <RuntimeDetail
          detail={detail}
          skillProbeState={agentSkillProbeState}
          onRequestSkillProbe={(agentDetail) => {
            void handleRequestAgentSkillProbe(agentDetail);
          }}
        />
      </section>
    </section>
  );
}

function createEmptyRuntimeInventorySnapshot(): RuntimeFleetSnapshot {
  return {
    observedAt: new Date(0).toISOString(),
    devices: [],
    runtimes: [],
    agents: [],
    tasks: [],
  };
}

function formatRuntimeFleetError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  return formatBackendErrorMessage(error.message, fallback);
}

function formatHttpError(status: number, fallback: string): string {
  if (status === 401 || status === 403) return "当前会话无权读取该信息。";
  if (status === 404) return "没有找到对应的运行资产。";
  if (status === 502 || status === 503 || status === 504) return "本地后端暂不可用，请稍后重试。";
  return `${fallback}，请稍后重试。`;
}

function formatBackendErrorMessage(message: string, fallback: string): string {
  if (message.includes("device_not_connected")) return "设备控制通道未连接，无法下发请求。";
  if (message.includes("HTTP 502") || message.includes("HTTP 503") || message.includes("HTTP 504")) {
    return "本地后端暂不可用，请稍后重试。";
  }
  if (/^[a-z0-9_:-]+$/i.test(message)) return fallback;
  return message;
}

function deviceCollectionHealthFromResponse(value: unknown): DeviceCollectionHealth | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DeviceCollectionHealth>;
  if (
    typeof candidate.deviceId !== "string"
    || !isCollectionHealthStatus(candidate.status)
    || typeof candidate.summary !== "string"
    || !Array.isArray(candidate.checks)
  ) {
    return null;
  }
  const checks = candidate.checks.filter(isCollectionHealthCheck);
  if (checks.length === 0) return null;
  return {
    checks,
    deviceId: candidate.deviceId,
    lastObservedAt: typeof candidate.lastObservedAt === "string" ? candidate.lastObservedAt : undefined,
    lastReceivedAt: typeof candidate.lastReceivedAt === "string" ? candidate.lastReceivedAt : undefined,
    status: candidate.status,
    summary: candidate.summary,
  };
}

function deviceHealthFromResponse(value: unknown): DeviceHealthStatusResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DeviceHealthStatusResult>;
  if (
    typeof candidate.deviceId !== "string"
    || !isDeviceHealthStatus(candidate.status)
    || !isDeviceHealthLabel(candidate.label)
    || typeof candidate.reason !== "string"
    || typeof candidate.message !== "string"
  ) {
    return null;
  }
  return {
    deviceId: candidate.deviceId,
    label: candidate.label,
    lastHeartbeatAt: typeof candidate.lastHeartbeatAt === "string" ? candidate.lastHeartbeatAt : undefined,
    lastDeviceStateFailureAt: typeof candidate.lastDeviceStateFailureAt === "string" ? candidate.lastDeviceStateFailureAt : undefined,
    lastDeviceStateSuccessAt: typeof candidate.lastDeviceStateSuccessAt === "string" ? candidate.lastDeviceStateSuccessAt : undefined,
    message: candidate.message,
    reason: candidate.reason as DeviceHealthStatusResult["reason"],
    status: candidate.status,
  };
}

function isDeviceHealthStatus(value: unknown): value is DeviceHealthStatus {
  return value === "syncing" || value === "online" || value === "offline" || value === "abnormal";
}

function isDeviceHealthLabel(value: unknown): value is DeviceHealthStatusResult["label"] {
  return value === "同步中" || value === "在线" || value === "离线" || value === "异常";
}

function isCollectionHealthCheck(value: unknown): value is CollectionHealthCheck {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CollectionHealthCheck>;
  return (
    candidate.id === "device_state"
    && typeof candidate.label === "string"
    && isCollectionHealthStatus(candidate.status)
    && typeof candidate.message === "string"
    && Array.isArray(candidate.warnings)
    && typeof candidate.counts === "object"
    && Boolean(candidate.counts)
  );
}

function isCollectionHealthStatus(value: unknown): value is DeviceCollectionHealth["status"] {
  return value === "healthy" || value === "failed";
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`metricCard metric${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DevicePanel({
  collectionHealthByDeviceId,
  deviceDiagnosticsByDeviceId,
  devices,
  snapshot,
  selectedId,
  onSelect,
}: {
  collectionHealthByDeviceId: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>;
  deviceDiagnosticsByDeviceId: ReadonlyMap<string, Pick<DeviceHealthStatusResult, "label" | "status">>;
  devices: RuntimeFleetSnapshot["devices"];
  snapshot: RuntimeFleetSnapshot;
  selectedId?: string;
  onSelect: (deviceId: string) => void;
}) {
  return (
    <section className="tablePanel devicePanel" aria-label="设备">
      <div className="runtimePanelHeader">
        <div>
          <h2>设备</h2>
          <p>{devices.length} 台设备匹配当前筛选</p>
        </div>
        <PixelIcon name="server" size={18} />
      </div>
      {devices.length === 0 ? (
        <EmptyAsset message="没有匹配的设备" />
      ) : (
        devices.map((device) => {
          const deviceHealth = deviceDiagnosticsByDeviceId.get(device.id);
          const status = deviceHealth
            ? runtimeFleetStatusFromDeviceHealth(deviceHealth.status)
            : deriveDeviceFleetStatus(snapshot, device, collectionHealthByDeviceId);
          const label = deviceHealth?.label ?? runtimeFleetObjectStatusLabels[status];
          return (
            <button
              className={
                device.id === selectedId ? "deviceSummary deviceSummaryActive" : "deviceSummary"
              }
              key={device.id}
              type="button"
              onClick={() => onSelect(device.id)}
            >
              <span className="iconSquare">
                <PixelIcon name="monitor" size={18} />
              </span>
              <span>
                <strong>{device.id}</strong>
                <small>{device.hostname}</small>
                <small>最近同步 {formatRuntimeTimestamp(device.lastSeenAt ?? snapshot.observedAt)}</small>
              </span>
              <StatusBadge label={label} status={status} />
            </button>
          );
        })
      )}
    </section>
  );
}

function RuntimeTable({
  collectionHealthByDeviceId,
  snapshot,
  runtimes,
  selectedId,
  onSelect,
}: {
  collectionHealthByDeviceId: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>;
  snapshot: RuntimeFleetSnapshot;
  runtimes: Runtime[];
  selectedId?: string;
  onSelect: (runtime: Runtime) => void;
}) {
  const deviceById = new Map(snapshot.devices.map((device) => [device.id, device]));
  return (
    <section className="tablePanel runtimeAssetPanel" aria-label="Runtime 列表">
      <div className="runtimePanelHeader">
        <div>
          <h2>Runtime</h2>
          <p>{runtimes.length} 个 Runtime 匹配当前筛选</p>
        </div>
        <PixelIcon name="cpu" size={18} />
      </div>
      {runtimes.length === 0 ? (
        <EmptyAsset message="没有匹配的 Runtime" />
      ) : (
        <div className="assetTable runtimeTable" role="table" aria-label="Runtime 列表">
          <div className="assetRow assetHeader runtimeTableRow" role="row">
            <span role="columnheader">名称</span>
            <span role="columnheader">Runtime</span>
            <span role="columnheader">所属设备</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">最近同步</span>
          </div>
          {runtimes.map((runtime) => {
            const status = deriveRuntimeFleetStatus(snapshot, runtime, collectionHealthByDeviceId);
            return (
              <button
                className={
                  runtime.id === selectedId
                    ? "assetRow assetDataRow runtimeTableRow tableRowActive"
                    : "assetRow assetDataRow runtimeTableRow"
                }
                key={runtime.id}
                type="button"
                role="row"
                onClick={() => onSelect(runtime)}
              >
                <span className="nameCell" role="cell">
                  <strong>{runtime.name}</strong>
                  <small>{runtime.id}</small>
                </span>
                <span role="cell">
                  <Badge>{runtimeKindLabels[runtime.kind]}</Badge>
                </span>
                <span className="mutedAssetText" role="cell">
                  {deviceById.get(runtime.deviceId)?.id ?? runtime.deviceId}
                </span>
                <span role="cell">
                  <StatusBadge label={runtimeFleetObjectStatusLabels[status]} status={status} />
                </span>
                <span className="mutedAssetText" role="cell">
                  {formatRuntimeTimestamp(runtime.lastSeenAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AgentTable({
  agents,
  collectionHealthByDeviceId,
  runtimes,
  snapshot,
  selectedId,
  onSelect,
  onShowSkillProbe,
}: {
  agents: Agent[];
  collectionHealthByDeviceId: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>;
  runtimes: Runtime[];
  snapshot: RuntimeFleetSnapshot;
  selectedId?: string;
  onSelect: (agent: Agent) => void;
  onShowSkillProbe: (agent: Agent) => void;
}) {
  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));

  return (
    <section className="tablePanel runtimeAssetPanel" aria-label="Agent 列表">
      <div className="runtimePanelHeader">
        <div>
          <h2>Agent</h2>
          <p>{agents.length} 个 Agent 匹配当前筛选</p>
        </div>
        <PixelIcon name="bot" size={18} />
      </div>
      {agents.length === 0 ? (
        <EmptyAsset message="没有匹配的 Agent" />
      ) : (
        <div className="assetTable agentTable" role="table" aria-label="Agent 列表">
          <div className="assetRow assetHeader agentTableRow" role="row">
            <span role="columnheader">名称</span>
            <span role="columnheader">归属 Runtime</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">最近同步</span>
            <span role="columnheader">Skill</span>
          </div>
          {agents.map((agent) => {
            const status = deriveAgentFleetStatus(snapshot, agent, collectionHealthByDeviceId);
            return (
              <div
                className={
                  agent.id === selectedId
                    ? "assetRow assetDataRow agentTableRow tableRowActive"
                    : "assetRow assetDataRow agentTableRow"
                }
                key={agent.id}
                role="row"
                onClick={() => onSelect(agent)}
              >
                <button className="rowCellButton nameCell" type="button" role="cell" onClick={() => onSelect(agent)}>
                  <strong>{agent.name}</strong>
                  <small>{agent.id}</small>
                </button>
                <span className="mutedAssetText" role="cell">
                  {runtimeById.get(agent.runtimeId)?.name ?? agent.runtimeId}
                </span>
                <span role="cell">
                  <StatusBadge label={runtimeFleetObjectStatusLabels[status]} status={status} />
                </span>
                <span className="mutedAssetText" role="cell">
                  {formatRuntimeTimestamp(runtimeAgentLastSeenAt(agent, runtimeById.get(agent.runtimeId), snapshot))}
                </span>
                <span role="cell">
                  <button
                    aria-label={`${agent.name} Skill 探测`}
                    className="inlineActionButton"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onShowSkillProbe(agent);
                    }}
                  >
                    查看
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RuntimeDetail({
  detail,
  skillProbeState,
  onRequestSkillProbe,
}: {
  detail: RuntimeFleetDetail | null;
  skillProbeState: AgentSkillProbeViewState;
  onRequestSkillProbe: (agentDetail: Extract<RuntimeFleetDetail, { kind: "agent" }>) => void;
}) {
  if (!detail) {
    return (
      <aside className="detailPanel" aria-label="运行资产详情">
        <h2>资产详情</h2>
        <p>选择设备、Runtime 或 Agent 查看完整信息。</p>
      </aside>
    );
  }

  return (
    <aside className="detailPanel" aria-label="运行资产详情">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">{detail.kind}</p>
          <h2>{detail.title}</h2>
        </div>
        <StatusBadge label={detail.statusLabel} status={detail.status} />
      </div>
      <DetailBlock title="概览">{detail.subtitle}</DetailBlock>
      {detail.sections.map((section) => (
        <DetailList key={section.title} title={section.title} items={section.items} />
      ))}
      {detail.kind === "agent" && skillProbeState.agentId === detail.id && skillProbeState.isVisible ? (
        <AgentSkillProbePanel
          detail={detail}
          state={skillProbeState}
          onRequest={() => onRequestSkillProbe(detail)}
        />
      ) : null}
    </aside>
  );
}

function AgentSkillProbePanel({
  detail,
  state,
  onRequest,
}: {
  detail: Extract<RuntimeFleetDetail, { kind: "agent" }>;
  state: AgentSkillProbeViewState;
  onRequest: () => void;
}) {
  const snapshot = state.snapshot ?? null;
  const status = snapshot?.status ?? "unknown";

  return (
    <section className="detailBlock agentSkillProbeBlock" aria-label="Skill 探测">
      <div className="detailBlockHeader">
        <h3>Skill 探测</h3>
        <button
          className="secondaryButton compactButton"
          type="button"
          disabled={state.status === "loading"}
          onClick={onRequest}
        >
          请求探测
        </button>
      </div>
      <div className="skillProbeActions">
        <StatusBadge label={agentSkillProbeStatusLabels[status]} status={status} />
      </div>
      {state.status === "loading" ? <p>正在读取 Skill 探测</p> : null}
      {state.status === "error" ? <p className="healthIssueText">{state.errorMessage}</p> : null}
      {snapshot ? <AgentSkillProbeSnapshotView snapshot={snapshot} /> : null}
      {!snapshot && state.status !== "loading" && state.status !== "error" ? <p>尚未探测 Skill</p> : null}
      <p className="mutedText">目标 Agent: {detail.title}</p>
    </section>
  );
}

function AgentSkillProbeSnapshotView({ snapshot }: { snapshot: AgentSkillProbeSnapshot }) {
  if (snapshot.status === "unknown") {
    return <p>尚未探测 Skill</p>;
  }
  if (snapshot.status === "unsupported") {
    return (
      <>
        <p className="healthIssueText">{snapshot.errorSummary || "当前目标不支持本地 Skill 探测"}</p>
      </>
    );
  }
  if (snapshot.status === "failed") {
    return <p className="healthIssueText">{snapshot.errorSummary || "Skill 探测失败"}</p>;
  }
  if (snapshot.status === "device_disconnected") {
    return <p className="healthIssueText">{snapshot.errorSummary || "设备控制通道未连接"}</p>;
  }
  if (snapshot.status === "requested") {
    return <p>探测请求已下发，等待目标设备回传结果。</p>;
  }
  if (snapshot.skills.length === 0) {
    return <p>未发现本地 Skill。</p>;
  }
  return (
    <div className="skillProbeList">
      {snapshot.skills.map((skill) => (
        <article className="skillProbeItem" key={`${skill.rootPath}:${skill.entryPath}`}>
          <h4>{skill.name}</h4>
          <p>Root: {skill.rootPath}</p>
          <p>Entry: {skill.entryPath}</p>
          <SkillProbeFileGroup title="Markdown" files={skill.markdownFiles} />
          <SkillProbeFileGroup title="非 Markdown" files={skill.nonMarkdownFiles} />
        </article>
      ))}
    </div>
  );
}

function SkillProbeFileGroup({
  title,
  files,
}: {
  title: string;
  files: AgentSkillProbeSnapshot["skills"][number]["markdownFiles"];
}) {
  if (files.length === 0) return <p>{title}: 暂无</p>;
  return (
    <div className="skillProbeFileGroup">
      <strong>{title}</strong>
      <ul>
        {files.map((file) => (
          <li key={`${title}:${file.path}`}>{file.relativePath}</li>
        ))}
      </ul>
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: string }) {
  return (
    <section className="detailBlock">
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

function DetailList({
  title,
  items,
  emptyLabel = "暂无",
}: {
  title: string;
  items: string[];
  emptyLabel?: string;
}) {
  return (
    <section className="detailBlock">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mutedText">{emptyLabel}</p>
      )}
    </section>
  );
}

function EmptyAsset({ message }: { message: string }) {
  return (
    <div className="emptyAsset">
      <p>{message}</p>
    </div>
  );
}

function Badge({ children }: { children: string }) {
  return <span className="badge">{children}</span>;
}

function StatusBadge({ label, status }: { label: string; status: string }) {
  return <span className={`statusBadge status-${status}`}>{label}</span>;
}
