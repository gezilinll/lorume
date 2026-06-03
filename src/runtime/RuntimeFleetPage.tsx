import { useEffect, useMemo, useState } from "react";
import { BarChart3, Bot, Copy, Cpu, Monitor, Server, UploadCloud } from "lucide-react";
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
import { consoleDetailInspectorClass } from "@/components/layout/inspector-styles";
import { toast } from "sonner";
import {
  collectorVersionPostureLabels,
  deriveAgentFleetStatus,
  deriveDeviceFleetStatus,
  deriveRuntimeFleetStatus,
  formatRelativeActivityTime,
  formatRuntimeTimestamp,
  getRuntimeFleetDetail,
  runtimeFleetAgentLastActiveAt,
  runtimeFleetDeviceLastActiveAt,
  runtimeFleetOperationsFromQueryResponse,
  runtimeFleetObjectStatusLabels,
  runtimeFleetRuntimeLastActiveAt,
  runtimeFleetSnapshotFromQueryResponse,
  runtimeFleetStatusFromDeviceHealth,
  summarizeCollectorVersions,
  type CollectorVersionDeviceSummary,
  type CollectorVersionPosture,
  type CollectorVersionSummary,
  type RuntimeFleetDetail,
  type RuntimeFleetOperationListItem,
  type RuntimeFleetObjectStatus,
  type RuntimeFleetSnapshot,
} from "./runtime-fleet-query";
import { createEmptyRuntimeFleetTaskSummary, type Agent, type Runtime } from "./runtime-model";
import { isFixtureFallbackAllowed } from "./runtime-data-source";
import { type CollectionHealthCheck, type DeviceCollectionHealth } from "./runtime-collection-health";
import type { DeviceHealthStatus, DeviceHealthStatusResult } from "./runtime-device-health";

const fixtureRuntimeSnapshot = runtimeFleetSnapshotFromQueryResponse(fixtureSnapshot) ?? createEmptyRuntimeInventorySnapshot();
const autoRefreshIntervalMs = 30_000;

type RuntimeFleetSelection = {
  kind: RuntimeFleetDetail["kind"];
  id: string;
};

const invisibleAgentDescription = "该 Agent 曾被采集到，但最新全量采集中未再出现。可能已被删除、停用，或已移出当前采集范围。";

function createRuntimeFleetUrl(pathname: string, organizationId?: string): URL {
  const requestUrl = new URL(pathname, window.location.origin);
  if (organizationId?.trim()) requestUrl.searchParams.set("organizationId", organizationId.trim());
  return requestUrl;
}

/** First Runtime Fleet surface: inspect registered device, runtimes, agents, and collection state. */
export function RuntimeFleetPage({
  organizationId,
  onOpenAgentDashboard,
  onOpenSkillWarehouse,
}: {
  organizationId?: string;
  onOpenAgentDashboard?: (filters: { agentId?: string }) => void;
  onOpenSkillWarehouse?: (filters: { runtimeId?: string; agentId?: string }) => void;
}) {
  const allowFixtureFallback = isFixtureFallbackAllowed();
  const [snapshot, setSnapshot] = useState<RuntimeFleetSnapshot>(
    allowFixtureFallback ? fixtureRuntimeSnapshot : createEmptyRuntimeInventorySnapshot(),
  );
  const [collectionHealth, setCollectionHealth] = useState<DeviceCollectionHealth[]>([]);
  const [deviceDiagnostics, setDeviceDiagnostics] = useState<DeviceHealthStatusResult[]>([]);
  const [latestCollectorVersion, setLatestCollectorVersion] = useState("");
  const [collectorUpgradeOperations, setCollectorUpgradeOperations] = useState<RuntimeFleetOperationListItem[]>([]);
  const [isLoading, setIsLoading] = useState(!allowFixtureFallback);
  const [loadError, setLoadError] = useState("");
  const [lastLoadedAt, setLastLoadedAt] = useState("");
  const [selection, setSelection] = useState<RuntimeFleetSelection | null>(null);
  const [upgradeRequestDeviceId, setUpgradeRequestDeviceId] = useState<string | null>(null);
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

  async function fetchLatestCollectorVersion(): Promise<string> {
    const response = await fetch(createRuntimeFleetUrl("/api/device-collector/manifest.json"));
    if (!response.ok) return "";
    const payload = await response.json() as { version?: unknown };
    return typeof payload.version === "string" ? payload.version.trim() : "";
  }

  async function fetchCollectorUpgradeOperations(): Promise<RuntimeFleetOperationListItem[]> {
    if (!organizationId?.trim()) return [];
    const requestUrl = createRuntimeFleetUrl("/api/operations", organizationId);
    requestUrl.searchParams.set("resourceType", "device");
    requestUrl.searchParams.set("targetType", "collector");
    requestUrl.searchParams.set("limit", "100");
    const response = await fetch(requestUrl);
    if (!response.ok) return [];
    return runtimeFleetOperationsFromQueryResponse(await response.json());
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
    collectorVersion: string,
    upgradeOperations: RuntimeFleetOperationListItem[],
  ) {
    setSnapshot(latestSnapshot);
    setCollectionHealth(latestCollectionHealth);
    setDeviceDiagnostics(latestDeviceDiagnostics);
    setLatestCollectorVersion(collectorVersion);
    setCollectorUpgradeOperations(upgradeOperations);
    setLoadError("");
    setLastLoadedAt(new Date().toISOString());
  }

  async function loadLatestRuntimeFleet() {
    setIsLoading(true);
    try {
      const latestSnapshot = await fetchLatestSnapshot();
      if (!latestSnapshot) return;
      const [latestCollectionHealth, latestDeviceDiagnostics, collectorVersion, upgradeOperations] = await Promise.all([
        fetchCollectionHealthForDevices(latestSnapshot).catch(() => []),
        fetchDeviceDiagnosticsForDevices(latestSnapshot).catch(() => []),
        fetchLatestCollectorVersion().catch(() => ""),
        fetchCollectorUpgradeOperations().catch(() => []),
      ]);
      applySnapshot(latestSnapshot, latestCollectionHealth, latestDeviceDiagnostics, collectorVersion, upgradeOperations);
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
        const [latestCollectionHealth, latestDeviceDiagnostics, collectorVersion, upgradeOperations] = await Promise.all([
          fetchCollectionHealthForDevices(latestSnapshot).catch(() => []),
          fetchDeviceDiagnosticsForDevices(latestSnapshot).catch(() => []),
          fetchLatestCollectorVersion().catch(() => ""),
          fetchCollectorUpgradeOperations().catch(() => []),
        ]);
        if (!cancelled) {
          applySnapshot(latestSnapshot, latestCollectionHealth, latestDeviceDiagnostics, collectorVersion, upgradeOperations);
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
  const collectorVersionSummary = useMemo(
    () => summarizeCollectorVersions(
      snapshot,
      latestCollectorVersion || undefined,
      collectorUpgradeOperations,
    ),
    [collectorUpgradeOperations, latestCollectorVersion, snapshot],
  );
  const detail = selection
    ? getRuntimeFleetDetail(
      snapshot,
      selection.kind,
      selection.id,
      collectionHealthByDeviceId,
      deviceDiagnosticsByDeviceId,
      collectorVersionSummary,
    )
    : null;

  async function requestCollectorUpgrade(deviceId: string) {
    if (!organizationId?.trim()) {
      toast.error("缺少组织上下文，无法创建升级任务");
      return;
    }
    setUpgradeRequestDeviceId(deviceId);
    try {
      const response = await fetch(
        createRuntimeFleetUrl(`/api/devices/${encodeURIComponent(deviceId)}/collector-upgrade`, organizationId),
        {
          body: "{}",
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const payload = await readJsonObject(response);
      if (!response.ok) {
        throw new Error(errorMessageFromResponse(payload) ?? "Collector 升级任务创建失败");
      }
      const status = typeof payload.status === "string" ? payload.status : "";
      if (status === "succeeded") {
        toast.success("Collector 已是最新版本");
      } else if (status === "requires_manual_step") {
        toast.warning("Collector 升级需要手动处理，请在任务抽屉查看详情");
      } else {
        toast.success("Collector 升级任务已创建，可在任务抽屉查看进度");
      }
      await loadLatestRuntimeFleet();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Collector 升级任务创建失败");
    } finally {
      setUpgradeRequestDeviceId(null);
    }
  }

  useConsoleWorkbar({
    meta: (
      <>
        <span>{snapshot.summary.deviceCount} 设备</span>
        <span>{snapshot.summary.runtimeCount} Runtime</span>
        <span>{snapshot.summary.agentCount} Agent</span>
        <span>Collector 最新 {latestCollectorVersion || "未获取"}</span>
        {collectorVersionSummary.actionableCount ? <span>待升级 {collectorVersionSummary.actionableCount}</span> : null}
        {collectorVersionSummary.activeCount ? <span>升级中 {collectorVersionSummary.activeCount}</span> : null}
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
    latestCollectorVersion,
    collectorVersionSummary.actionableCount,
    collectorVersionSummary.activeCount,
    snapshot.summary.agentCount,
    snapshot.summary.deviceCount,
    snapshot.summary.runtimeCount,
  ]);

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
              collectorVersionSummary={collectorVersionSummary}
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
              onOpenSkillWarehouse={(runtime) => {
                setSelection({ kind: "runtime", id: runtime.id });
                onOpenSkillWarehouse?.({ runtimeId: runtime.id });
              }}
            />
            <AgentTable
              agents={snapshot.agents}
              collectionHealthByDeviceId={collectionHealthByDeviceId}
              runtimes={snapshot.runtimes}
              snapshot={snapshot}
              selectedId={selection?.kind === "agent" ? selection.id : undefined}
              onSelect={(agent) => setSelection({ kind: "agent", id: agent.id })}
              onOpenSkillWarehouse={(agent) => {
                setSelection({ kind: "agent", id: agent.id });
                onOpenSkillWarehouse?.({ agentId: agent.id, runtimeId: agent.runtimeId });
              }}
              onOpenAgentDashboard={(agent) => {
                setSelection({ kind: "agent", id: agent.id });
                onOpenAgentDashboard?.({ agentId: agent.id });
              }}
            />
          </div>
          <RuntimeDetail
            collectorVersion={detail?.kind === "device" ? collectorVersionSummary.byDeviceId[detail.id] : undefined}
            detail={detail}
            isCollectorUpgradeSubmitting={Boolean(detail?.kind === "device" && upgradeRequestDeviceId === detail.id)}
            onOpenAgentDashboard={(agentId) => {
              onOpenAgentDashboard?.({ agentId });
            }}
            onUpgradeCollector={requestCollectorUpgrade}
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

function collectorVersionLine(summary: CollectorVersionDeviceSummary): string {
  return `Collector ${summary.currentVersion ?? "未上报"} · ${summary.label}`;
}

function canRequestCollectorUpgrade(summary: CollectorVersionDeviceSummary): boolean {
  return Boolean(summary.latestVersion)
    && summary.posture !== "latest"
    && summary.posture !== "upgrading"
    && summary.posture !== "unknown";
}

function collectorUpgradeButtonLabel(
  summary: CollectorVersionDeviceSummary,
  isSubmitting: boolean,
): string {
  if (isSubmitting) return "提交中";
  if (summary.posture === "upgrading") return "升级中";
  if (summary.posture === "latest") return "已是最新";
  return "升级 Collector";
}

function DevicePanel({
  collectorVersionSummary,
  collectionHealthByDeviceId,
  deviceDiagnosticsByDeviceId,
  devices,
  snapshot,
  selectedId,
  onSelect,
}: {
  collectorVersionSummary: CollectorVersionSummary;
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
              const collectorVersion = collectorVersionSummary.byDeviceId[device.id];
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
                      {collectorVersion ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {collectorVersionLine(collectorVersion)}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5 self-start sm:self-auto sm:justify-end">
                    <FleetStatusBadge label={label} status={status} />
                    {collectorVersion ? <CollectorPostureBadge posture={collectorVersion.posture} /> : null}
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
  onOpenSkillWarehouse,
  onSelect,
}: {
  collectionHealthByDeviceId: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>;
  snapshot: RuntimeFleetSnapshot;
  runtimes: Runtime[];
  selectedId?: string;
  onOpenSkillWarehouse: (runtime: Runtime) => void;
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
          <Table aria-label="Runtime 列表" className="table-fixed">
            <TableHeader className="bg-[var(--surface-soft)]">
              <TableRow>
                <TableHead className="w-[30%]">名称</TableHead>
                <TableHead className="w-[22%]">所属设备</TableHead>
                <TableHead className="w-[12%]">状态</TableHead>
                <TableHead className="w-[9%]">Task</TableHead>
                <TableHead className="w-[17%]">最近活跃</TableHead>
                <TableHead className="w-[10%]">
                  <span className="sr-only">Skill 操作</span>
                </TableHead>
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
                    <TableCell className="text-muted-foreground tabular-nums">{taskTotal}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelativeActivityTime(lastActiveAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenSkillWarehouse(runtime);
                        }}
                      >
                        查看 Skill
                      </Button>
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
  onOpenAgentDashboard,
  onOpenSkillWarehouse,
  onSelect,
}: {
  agents: Agent[];
  collectionHealthByDeviceId: ReadonlyMap<string, Pick<DeviceCollectionHealth, "status">>;
  runtimes: Runtime[];
  snapshot: RuntimeFleetSnapshot;
  selectedId?: string;
  onOpenAgentDashboard?: (agent: Agent) => void;
  onOpenSkillWarehouse: (agent: Agent) => void;
  onSelect: (agent: Agent) => void;
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
          <Table aria-label="Agent 列表" className="table-fixed">
            <TableHeader className="bg-[var(--surface-soft)]">
              <TableRow>
                <TableHead className="w-[26%]">名称</TableHead>
                <TableHead className="w-[20%]">归属 Runtime</TableHead>
                <TableHead className="w-[11%]">状态</TableHead>
                <TableHead className="w-[8%]">Task</TableHead>
                <TableHead className="w-[15%]">最近活跃</TableHead>
                <TableHead className="w-[20%]">
                  <span className="sr-only">操作</span>
                </TableHead>
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
                    <TableCell className="text-muted-foreground tabular-nums">{taskTotal}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelativeActivityTime(lastActiveAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="flex min-w-max items-center justify-end gap-2">
                        {onOpenAgentDashboard ? (
                          <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenAgentDashboard(agent);
                            }}
                          >
                            <BarChart3 aria-hidden="true" className="size-3.5" />
                            查看看板
                          </Button>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="inline-flex"
                              data-skill-probe-disabled={skillProbeDisabled ? "true" : undefined}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Button
                                disabled={skillProbeDisabled}
                                size="sm"
                                type="button"
                                variant="outline"
                                onClick={() => {
                                  if (skillProbeDisabled) return;
                                  onOpenSkillWarehouse(agent);
                                }}
                              >
                                查看 Skill
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {skillProbeDisabled ? (
                            <TooltipContent className="max-w-72 text-left leading-5" side="top">
                              {invisibleAgentDescription}
                            </TooltipContent>
                          ) : null}
                        </Tooltip>
                      </div>
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
  collectorVersion,
  detail,
  isCollectorUpgradeSubmitting,
  onOpenAgentDashboard,
  onUpgradeCollector,
}: {
  collectorVersion?: CollectorVersionDeviceSummary;
  detail: RuntimeFleetDetail | null;
  isCollectorUpgradeSubmitting: boolean;
  onOpenAgentDashboard?: (agentId: string) => void;
  onUpgradeCollector: (deviceId: string) => void;
}) {
  if (!detail) {
    return (
      <aside aria-label="运行资产详情" className={consoleDetailInspectorClass}>
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
    <aside aria-label="运行资产详情" className={consoleDetailInspectorClass}>
      <Card size="sm">
        <CardHeader className="gap-3">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase text-muted-foreground">{detail.kind}</p>
              <h2 className="mt-1 break-words font-heading text-sm font-medium leading-snug">{detail.title}</h2>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <FleetStatusBadge label={detail.statusLabel} status={detail.status} />
              {detail.kind === "device" && collectorVersion ? (
                <Button
                  disabled={!canRequestCollectorUpgrade(collectorVersion) || isCollectorUpgradeSubmitting}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => onUpgradeCollector(detail.id)}
                >
                  <UploadCloud aria-hidden="true" className="size-3.5" />
                  {collectorUpgradeButtonLabel(collectorVersion, isCollectorUpgradeSubmitting)}
                </Button>
              ) : null}
              {detail.kind === "agent" && onOpenAgentDashboard ? (
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => onOpenAgentDashboard(detail.id)}
                >
                  <BarChart3 aria-hidden="true" className="size-3.5" />
                  查看看板
                </Button>
              ) : null}
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

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function errorMessageFromResponse(payload: Record<string, unknown>): string | null {
  const message = payload.message ?? payload.error;
  return typeof message === "string" && message.trim() ? message.trim() : null;
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

function CollectorPostureBadge({ posture }: { posture: CollectorVersionPosture }) {
  return (
    <AppStatusBadge tone={collectorPostureTone(posture)}>
      {collectorVersionPostureLabels[posture]}
    </AppStatusBadge>
  );
}

function fleetStatusTone(status: RuntimeFleetObjectStatus): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "online") return "success";
  if (status === "offline" || status === "invisible") return "neutral";
  if (status === "error") return "danger";
  return "info";
}

function collectorPostureTone(posture: CollectorVersionPosture): "neutral" | "success" | "warning" | "danger" | "info" {
  if (posture === "latest") return "success";
  if (posture === "failed") return "danger";
  if (posture === "outdated" || posture === "requires_manual_step") return "warning";
  if (posture === "upgrading") return "info";
  return "neutral";
}
