import { useEffect, useMemo, useState } from "react";
import { Bot, Copy, Cpu, Monitor, Server } from "lucide-react";
import fixtureSnapshot from "../../fixtures/runtime/runtime-fleet-query.sample.json";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InitialAvatar } from "@/components/data/InitialAvatar";
import { StatusBadge as AppStatusBadge } from "@/components/data/StatusBadge";
import { useConsoleWorkbar, useHasConsoleWorkbar } from "@/components/layout/ConsoleWorkbar";
import { toast } from "sonner";
import {
  deriveAgentFleetStatus,
  deriveDeviceFleetStatus,
  deriveRuntimeFleetStatus,
  formatRelativeActivityTime,
  formatRuntimeTimestamp,
  getRuntimeFleetDetail,
  runtimeFleetAgentLastActiveAt,
  runtimeFleetDeviceLastActiveAt,
  runtimeFleetObjectStatusLabels,
  runtimeFleetRuntimeLastActiveAt,
  runtimeFleetSnapshotFromQueryResponse,
  runtimeFleetStatusFromDeviceHealth,
  type RuntimeFleetDetail,
  type RuntimeFleetObjectStatus,
  type RuntimeFleetSnapshot,
} from "./runtime-fleet-query";
import { createEmptyRuntimeFleetTaskSummary, type Agent, type Runtime } from "./runtime-model";
import { isFixtureFallbackAllowed } from "./runtime-data-source";
import { type CollectionHealthCheck, type DeviceCollectionHealth } from "./runtime-collection-health";
import type { DeviceHealthStatus, DeviceHealthStatusResult } from "./runtime-device-health";
import {
  normalizeAgentSkillProbeSnapshot,
  type AgentSkillProbeSnapshot,
  type AgentSkillProbeStatus,
} from "./agent-skill-probe";

const fixtureRuntimeSnapshot = runtimeFleetSnapshotFromQueryResponse(fixtureSnapshot) ?? createEmptyRuntimeInventorySnapshot();
const autoRefreshIntervalMs = 30_000;

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
  succeeded: "探测完成",
  unsupported: "不支持探测",
  failed: "探测失败",
};
const invisibleAgentDescription = "该 Agent 曾被采集到，但最新全量采集中未再出现。可能已被删除、停用，或已移出当前采集范围。";

function createRuntimeFleetUrl(pathname: string, organizationId?: string): URL {
  const requestUrl = new URL(pathname, window.location.origin);
  if (organizationId?.trim()) requestUrl.searchParams.set("organizationId", organizationId.trim());
  return requestUrl;
}

/** First Runtime Fleet surface: inspect registered device, runtimes, agents, and collection state. */
export function RuntimeFleetPage({ organizationId }: { organizationId?: string }) {
  const allowFixtureFallback = isFixtureFallbackAllowed();
  const [snapshot, setSnapshot] = useState<RuntimeFleetSnapshot>(
    allowFixtureFallback ? fixtureRuntimeSnapshot : createEmptyRuntimeInventorySnapshot(),
  );
  const [collectionHealth, setCollectionHealth] = useState<DeviceCollectionHealth[]>([]);
  const [deviceDiagnostics, setDeviceDiagnostics] = useState<DeviceHealthStatusResult[]>([]);
  const [isLoading, setIsLoading] = useState(!allowFixtureFallback);
  const [loadError, setLoadError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState("");
  const [selection, setSelection] = useState<RuntimeFleetSelection | null>(null);
  const [agentSkillProbeState, setAgentSkillProbeState] = useState<AgentSkillProbeViewState>({
    agentId: "",
    isVisible: false,
    snapshot: null,
    status: "idle",
  });
  const hasConsoleWorkbar = useHasConsoleWorkbar();

  async function fetchLatestSnapshot(): Promise<RuntimeFleetSnapshot | null> {
    const queryResponse = await fetch(createRuntimeFleetUrl("/api/runtime-fleet", organizationId));
    if (!queryResponse.ok) {
      throw new Error(`runtime fleet query failed: ${queryResponse.status}`);
    }
    const querySnapshot = runtimeFleetSnapshotFromQueryResponse(await queryResponse.json());
    if (!querySnapshot) throw new Error("runtime fleet query returned an invalid payload");
    return querySnapshot;
  }

  async function fetchCollectionHealth(deviceId: string): Promise<DeviceCollectionHealth | null> {
    const response = await fetch(createRuntimeFleetUrl(`/api/devices/${encodeURIComponent(deviceId)}/collection-health`, organizationId));
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
    const response = await fetch(createRuntimeFleetUrl(`/api/devices/${encodeURIComponent(deviceId)}/diagnostics`, organizationId));
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

  async function loadLatestRuntimeFleet() {
    setIsLoading(true);
    try {
      const latestSnapshot = await fetchLatestSnapshot();
      if (!latestSnapshot) return;
      const [latestCollectionHealth, latestDeviceDiagnostics] = await Promise.all([
        fetchCollectionHealthForDevices(latestSnapshot).catch(() => []),
        fetchDeviceDiagnosticsForDevices(latestSnapshot).catch(() => []),
      ]);
      applySnapshot(latestSnapshot, latestCollectionHealth, latestDeviceDiagnostics);
    } catch {
      if (!allowFixtureFallback) {
        setLoadError("后端查询失败，无法读取正式运行资产");
      }
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInitialSnapshot() {
      setIsLoading(true);
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
      } finally {
        if (!cancelled) setIsLoading(false);
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
  }, [allowFixtureFallback, organizationId]);

  const collectionHealthByDeviceId = useMemo(
    () => new Map(collectionHealth.map((health) => [health.deviceId, health])),
    [collectionHealth],
  );
  const deviceDiagnosticsByDeviceId = useMemo(
    () => new Map(deviceDiagnostics.map((diagnostic) => [diagnostic.deviceId, diagnostic])),
    [deviceDiagnostics],
  );
  const detail = selection
    ? getRuntimeFleetDetail(
      snapshot,
      selection.kind,
      selection.id,
      collectionHealthByDeviceId,
      deviceDiagnosticsByDeviceId,
    )
    : null;

  useConsoleWorkbar({
    meta: (
      <>
        <span>{snapshot.summary.deviceCount} 设备</span>
        <span>{snapshot.summary.runtimeCount} Runtime</span>
        <span>{snapshot.summary.agentCount} Agent</span>
        {lastLoadedAt ? <span>更新 {formatRuntimeTimestamp(lastLoadedAt)}</span> : null}
      </>
    ),
    refresh: {
      disabled: isLoading,
      isLoading,
      label: "刷新",
      onClick: () => {
        void loadLatestRuntimeFleet();
      },
    },
    title: "运行资产",
  }, [
    isLoading,
    lastLoadedAt,
    snapshot.summary.agentCount,
    snapshot.summary.deviceCount,
    snapshot.summary.runtimeCount,
  ]);

  async function fetchAgentSkillProbe(agentId: string): Promise<AgentSkillProbeSnapshot> {
    const response = await fetch(createRuntimeFleetUrl(`/api/agents/${encodeURIComponent(agentId)}/skill-probe`, organizationId));
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

  return (
    <section className="min-w-0">
      {hasConsoleWorkbar ? null : (
        <>
          <h1 className="sr-only">运行资产</h1>
          <Button
            className="sr-only"
            disabled={isLoading}
            type="button"
            variant="ghost"
            onClick={() => {
              void loadLatestRuntimeFleet();
            }}
          >
            刷新
          </Button>
        </>
      )}
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {isLoading && !allowFixtureFallback && snapshot.devices.length === 0 ? (
        <RuntimeFleetSkeleton />
      ) : (
        <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.38fr)]">
          <div className="min-w-0 space-y-4">
            <DevicePanel
              collectionHealthByDeviceId={collectionHealthByDeviceId}
              deviceDiagnosticsByDeviceId={deviceDiagnosticsByDeviceId}
              devices={snapshot.devices}
              snapshot={snapshot}
              selectedId={selection?.kind === "device" ? selection.id : undefined}
              onSelect={(deviceId) => setSelection({ kind: "device", id: deviceId })}
            />
            <RuntimeTable
              collectionHealthByDeviceId={collectionHealthByDeviceId}
              snapshot={snapshot}
              runtimes={snapshot.runtimes}
              selectedId={selection?.kind === "runtime" ? selection.id : undefined}
              onSelect={(runtime) => setSelection({ kind: "runtime", id: runtime.id })}
            />
            <AgentTable
              agents={snapshot.agents}
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
                  deviceDiagnosticsByDeviceId,
                );
                if (agentDetail?.kind === "agent") void handleShowAgentSkillProbe(agentDetail);
              }}
            />
          </div>
          <RuntimeDetail
            detail={detail}
            skillProbeState={agentSkillProbeState}
            onRefreshSkillProbe={(agentDetail) => {
              void handleShowAgentSkillProbe(agentDetail);
            }}
          />
        </section>
      )}
    </section>
  );
}

function createEmptyRuntimeInventorySnapshot(): RuntimeFleetSnapshot {
  return {
    collectedAt: new Date(0).toISOString(),
    devices: [],
    runtimes: [],
    agents: [],
    taskSummary: createEmptyRuntimeFleetTaskSummary(),
    summary: { agentCount: 0, deviceCount: 0, runtimeCount: 0, taskCount: 0 },
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
    lastCollectedAt: typeof candidate.lastCollectedAt === "string" ? candidate.lastCollectedAt : undefined,
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
  return value === "syncing" || value === "online" || value === "offline" || value === "error";
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
    && Array.isArray(candidate.diagnostics)
    && typeof candidate.counts === "object"
    && Boolean(candidate.counts)
  );
}

function isCollectionHealthStatus(value: unknown): value is DeviceCollectionHealth["status"] {
  return value === "healthy" || value === "failed";
}

function runtimeCountForDevice(snapshot: RuntimeFleetSnapshot, deviceId: string): number {
  return snapshot.runtimes.filter((runtime) => runtime.deviceId === deviceId).length;
}

function agentCountForDevice(snapshot: RuntimeFleetSnapshot, deviceId: string): number {
  const runtimeIds = new Set(snapshot.runtimes.filter((runtime) => runtime.deviceId === deviceId).map((runtime) => runtime.id));
  return snapshot.agents.filter((agent) => runtimeIds.has(agent.runtimeId)).length;
}

function taskTotalForRuntime(snapshot: RuntimeFleetSnapshot, runtimeId: string): number {
  return snapshot.taskSummary.byRuntimeId[runtimeId]?.total ?? 0;
}

function taskTotalForAgent(snapshot: RuntimeFleetSnapshot, agentId: string): number {
  return snapshot.taskSummary.byAgentId[agentId]?.total ?? 0;
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
    <Card size="sm" aria-label="设备">
      <CardHeader className="grid-cols-[1fr_auto] items-start border-b border-border pb-3">
        <div>
          <CardTitle>Device</CardTitle>
          <p className="mt-1 text-[11.5px] text-muted-foreground">来自所有 Runtime 和 Agent 的最近处理活动。</p>
        </div>
        <Server aria-hidden="true" className="size-5 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <EmptyAsset message="暂无设备" />
        ) : (
          <div className="grid gap-2.5">
            {devices.map((device) => {
              const deviceHealth = deviceDiagnosticsByDeviceId.get(device.id);
              const status = deviceHealth
                ? runtimeFleetStatusFromDeviceHealth(deviceHealth.status)
                : deriveDeviceFleetStatus(snapshot, device, collectionHealthByDeviceId);
              const label = deviceHealth?.label ?? runtimeFleetObjectStatusLabels[status];
              const lastActiveAt = runtimeFleetDeviceLastActiveAt(snapshot, device.id);
              const runtimeCount = runtimeCountForDevice(snapshot, device.id);
              const agentCount = agentCountForDevice(snapshot, device.id);
              return (
                <Button
                  className="h-auto w-full flex-col items-stretch justify-start gap-3 rounded-[14px] border-border bg-[var(--surface-soft)] px-3 py-3 text-left whitespace-normal shadow-none data-[active=true]:border-[var(--brand-border)] data-[active=true]:bg-[var(--brand-soft)] sm:flex-row sm:items-center sm:justify-between"
                  data-active={device.id === selectedId}
                  key={device.id}
                  type="button"
                  variant="outline"
                  onClick={() => onSelect(device.id)}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-[14px] border border-[var(--brand-border)] bg-[var(--brand-soft)] text-[var(--brand-foreground)]">
                      <Monitor aria-hidden="true" className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-[13px] font-semibold">{device.id}</strong>
                      <span className="block truncate text-[11.5px] text-muted-foreground">
                        {device.hostname} · {runtimeCount} Runtime · {agentCount} Agent
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        最近活跃 {formatRelativeActivityTime(lastActiveAt)}
                      </span>
                    </span>
                  </span>
                  <span className="self-start sm:self-auto">
                    <FleetStatusBadge label={label} status={status} />
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
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
    <Card size="sm" aria-label="Runtime 列表">
      <CardHeader className="grid-cols-[1fr_auto] items-start border-b border-border pb-3">
        <div>
          <CardTitle>Runtime</CardTitle>
          <p className="mt-1 text-[11.5px] text-muted-foreground">成员目录样式展示运行时、归属设备和任务活动。</p>
        </div>
        <Cpu aria-hidden="true" className="size-5 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {runtimes.length === 0 ? (
          <EmptyAsset message="暂无 Runtime" />
        ) : (
          <Table aria-label="Runtime 列表">
            <TableHeader className="bg-[var(--surface-soft)]">
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>所属设备</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>Task</TableHead>
                <TableHead className="text-right">最近活跃</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runtimes.map((runtime) => {
                const status = deriveRuntimeFleetStatus(snapshot, runtime, collectionHealthByDeviceId);
                const lastActiveAt = runtimeFleetRuntimeLastActiveAt(snapshot, runtime.id);
                const taskTotal = taskTotalForRuntime(snapshot, runtime.id);
                return (
                  <TableRow
                    aria-selected={runtime.id === selectedId}
                    className="cursor-pointer border-border/70 aria-selected:bg-muted/80"
                    key={runtime.id}
                    tabIndex={0}
                    onClick={() => onSelect(runtime)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(runtime);
                      }
                    }}
                  >
                    <TableCell className="min-w-44">
                      <div className="flex min-w-0 items-center gap-3">
                        <InitialAvatar text={runtime.name} />
                        <span className="min-w-0">
                          <strong className="block truncate text-[13px] font-semibold">{runtime.name}</strong>
                          <span className="block truncate text-[11.5px] text-muted-foreground">{runtime.version ?? "未上报版本"}</span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {deviceById.get(runtime.deviceId)?.id ?? runtime.deviceId}
                    </TableCell>
                    <TableCell>
                      <FleetStatusBadge label={runtimeFleetObjectStatusLabels[status]} status={status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{taskTotal}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatRelativeActivityTime(lastActiveAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
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
    <Card size="sm" aria-label="Agent 列表">
      <CardHeader className="grid-cols-[1fr_auto] items-start border-b border-border pb-3">
        <div>
          <CardTitle>Agent</CardTitle>
          <p className="mt-1 text-[11.5px] text-muted-foreground">成员目录样式展示 Agent、归属 Runtime、Skill 与任务活动。</p>
        </div>
        <Bot aria-hidden="true" className="size-5 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <EmptyAsset message="暂无 Agent" />
        ) : (
          <Table aria-label="Agent 列表">
            <TableHeader className="bg-[var(--surface-soft)]">
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>归属 Runtime</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>最近活跃</TableHead>
                <TableHead className="w-20 text-right">Skill</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent) => {
                const status = deriveAgentFleetStatus(snapshot, agent, collectionHealthByDeviceId);
                const skillProbeDisabled = status === "invisible";
                const lastActiveAt = runtimeFleetAgentLastActiveAt(snapshot, agent.id);
                const taskTotal = taskTotalForAgent(snapshot, agent.id);
                const runtimeName = runtimeById.get(agent.runtimeId)?.name ?? "未匹配 Runtime";
                return (
                  <TableRow
                    aria-selected={agent.id === selectedId}
                    className="cursor-pointer border-border/70 aria-selected:bg-muted/80"
                    key={agent.id}
                    tabIndex={0}
                    onClick={() => onSelect(agent)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(agent);
                      }
                    }}
                  >
                    <TableCell className="min-w-36">
                      <div className="flex min-w-0 items-center gap-3">
                        <InitialAvatar text={agent.name} variant="solid" />
                        <span className="min-w-0">
                          <strong className="block truncate text-[13px] font-semibold">{agent.name}</strong>
                          <span className="block truncate text-[11.5px] text-muted-foreground">Agent · {taskTotal} Task</span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground">
                      {runtimeName}
                    </TableCell>
                    <TableCell>
                      <FleetStatusBadge label={runtimeFleetObjectStatusLabels[status]} status={status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{taskTotal}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelativeActivityTime(lastActiveAt)}
                    </TableCell>
                    <TableCell className="w-20 text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex justify-end"
                            data-skill-probe-disabled={skillProbeDisabled ? "true" : undefined}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Button
                              aria-label={`${agent.name} Skill 探测`}
                              disabled={skillProbeDisabled}
                              size="sm"
                              type="button"
                              variant="outline"
                              onClick={() => {
                                if (skillProbeDisabled) return;
                                onShowSkillProbe(agent);
                              }}
                            >
                              查看
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {skillProbeDisabled ? (
                          <TooltipContent className="max-w-72 text-left leading-5" side="top">
                            {invisibleAgentDescription}
                          </TooltipContent>
                        ) : null}
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function RuntimeDetail({
  detail,
  skillProbeState,
  onRefreshSkillProbe,
}: {
  detail: RuntimeFleetDetail | null;
  skillProbeState: AgentSkillProbeViewState;
  onRefreshSkillProbe: (agentDetail: Extract<RuntimeFleetDetail, { kind: "agent" }>) => void;
}) {
  if (!detail) {
    return (
      <aside aria-label="运行资产详情" className="self-start xl:sticky xl:top-4">
        <Card size="sm">
          <CardHeader>
            <h2 className="font-heading text-sm font-medium leading-snug">资产详情</h2>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">选择设备、Runtime 或 Agent 查看完整信息。</p>
          </CardContent>
        </Card>
      </aside>
    );
  }

  const safeSections = detail.sections.filter((section) => section.title !== "本地路径");

  return (
    <aside aria-label="运行资产详情" className="self-start xl:sticky xl:top-4">
      <Card size="sm">
        <CardHeader className="gap-3">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase text-muted-foreground">{detail.kind}</p>
              <h2 className="mt-1 break-words font-heading text-sm font-medium leading-snug">{detail.title}</h2>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <FleetStatusBadge label={detail.statusLabel} status={detail.status} />
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  void copyTextToClipboard(detail.id).then((copied) => {
                    if (copied) toast.success("已复制");
                  });
                }}
              >
                <Copy aria-hidden="true" className="size-3.5" />
                复制 ID
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailBlock title="概览">{detail.subtitle}</DetailBlock>
          {safeSections.map((section) => (
            <DetailList key={section.title} title={section.title} items={section.items} />
          ))}
          {detail.kind === "agent" && skillProbeState.agentId === detail.id && skillProbeState.isVisible ? (
            <AgentSkillProbePanel
              detail={detail}
              state={skillProbeState}
              onRefresh={() => onRefreshSkillProbe(detail)}
            />
          ) : null}
        </CardContent>
      </Card>
    </aside>
  );
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(value);
    return true;
  }
  return copyTextWithTextarea(value);
}

function copyTextWithTextarea(value: string): boolean {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    if (typeof document.execCommand !== "function") return false;
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

function AgentSkillProbePanel({
  detail,
  state,
  onRefresh,
}: {
  detail: Extract<RuntimeFleetDetail, { kind: "agent" }>;
  state: AgentSkillProbeViewState;
  onRefresh: () => void;
}) {
  const snapshot = state.snapshot ?? null;
  const status = snapshot?.status ?? "unknown";

  return (
    <section className="border-t border-border pt-3" aria-label="Skill 探测">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Skill 探测</h3>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={state.status === "loading"}
          onClick={onRefresh}
        >
          刷新
        </Button>
      </div>
      <div className="mt-3">
        <SkillStatusBadge label={agentSkillProbeStatusLabels[status]} status={status} />
      </div>
      <div className="mt-3 space-y-3 text-sm">
        {state.status === "loading" ? <p>正在读取 Skill 探测</p> : null}
        {state.status === "error" ? <p className="text-destructive">{state.errorMessage}</p> : null}
        {snapshot ? <AgentSkillProbeSnapshotView snapshot={snapshot} /> : null}
        {!snapshot && state.status !== "loading" && state.status !== "error" ? <p>尚未探测 Skill</p> : null}
        <p className="text-muted-foreground">目标 Agent: {detail.title}</p>
      </div>
    </section>
  );
}

function AgentSkillProbeSnapshotView({ snapshot }: { snapshot: AgentSkillProbeSnapshot }) {
  if (snapshot.status === "unknown") {
    return <p>尚未探测 Skill</p>;
  }
  if (snapshot.status === "unsupported") {
    return <p className="text-destructive">{snapshot.errorSummary || "当前目标不支持本地 Skill 探测"}</p>;
  }
  if (snapshot.status === "failed") {
    return <p className="text-destructive">{snapshot.errorSummary || "Skill 探测失败"}</p>;
  }
  if (snapshot.skills.length === 0) {
    return <p>未发现本地 Skill。</p>;
  }
  return (
    <div className="space-y-3">
      {snapshot.skills.map((skill) => (
        <article className="border-t border-border pt-3 first:border-t-0 first:pt-0" key={`${skill.rootPath}:${skill.entryPath}`}>
          <h4 className="font-medium">{skill.name}</h4>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <SkillProbeFileGroup title="Markdown" files={skill.markdownFiles} />
            <SkillProbeFileGroup title="非 Markdown" files={skill.nonMarkdownFiles} />
          </div>
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
    <div className="space-y-1">
      <strong className="text-xs text-muted-foreground">{title}</strong>
      <ul className="space-y-1">
        {files.map((file) => (
          <li className="break-all rounded-[6px] bg-muted px-2 py-1 text-xs" key={`${title}:${file.path}`}>
            {file.relativePath}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: string }) {
  return (
    <section className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
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
    <section className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length ? (
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {items.map((item) => (
            <li className="break-words" key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </section>
  );
}

function EmptyAsset({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
      <p>{message}</p>
    </div>
  );
}

function RuntimeFleetSkeleton() {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.38fr)]" aria-label="运行资产读取中">
      <div className="space-y-4">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
      <Skeleton className="h-80 w-full" />
    </section>
  );
}

function FleetStatusBadge({ label, status }: { label: string; status: RuntimeFleetObjectStatus }) {
  const badge = <AppStatusBadge tone={fleetStatusTone(status)}>{label}</AppStatusBadge>;
  if (status !== "invisible") return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`${label}：${invisibleAgentDescription}`}
          className="inline-flex cursor-help"
          tabIndex={0}
        >
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-left leading-5" side="top">
        {invisibleAgentDescription}
      </TooltipContent>
    </Tooltip>
  );
}

function SkillStatusBadge({ label, status }: { label: string; status: AgentSkillProbeStatus }) {
  return <AppStatusBadge tone={skillStatusTone(status)}>{label}</AppStatusBadge>;
}

function fleetStatusTone(status: RuntimeFleetObjectStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "online") return "success";
  if (status === "offline" || status === "invisible") return "neutral";
  if (status === "error") return "danger";
  return "info";
}

function skillStatusTone(status: AgentSkillProbeStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "unsupported") return "warning";
  return "neutral";
}
