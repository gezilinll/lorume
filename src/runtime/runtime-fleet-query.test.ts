import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectorVersionPostureLabels,
  collectionStatusLabels,
  deriveCollectorVersionPosture,
  deriveAgentFleetStatus,
  deriveDeviceFleetStatus,
  deriveRuntimeFleetStatus,
  formatRelativeActivityTime,
  getRuntimeFleetDetail,
  runtimeFleetAgentLastActiveAt,
  runtimeFleetDeviceLastActiveAt,
  runtimeFleetRuntimeLastActiveAt,
  runtimeDisplayName,
  runtimeFleetSnapshotFromQueryResponse,
  summarizeCollectorVersions,
  summarizeRuntimeFleet,
  type RuntimeFleetSnapshot,
} from "./runtime-fleet-query";
import { createEmptyTaskStatusCounts } from "./runtime-model";

const fixtureTaskCounts = {
  ...createEmptyTaskStatusCounts(),
  in_progress: 1,
  todo: 1,
  total: 2,
};
const fixtureLastActiveAt = "2026-05-21T09:58:00.000Z";
const fixtureLastActiveLabel = "2 分钟前";

const snapshot: RuntimeFleetSnapshot = {
  collectedAt: "2026-05-21T10:00:00.000Z",
  devices: [{
    id: "fixture-mac",
    hostname: "fixture-mac.local",
    os: "darwin",
    architecture: "arm64",
    collectionStatus: "online",
    lastSeenAt: "2026-05-21T10:00:00.000Z",
    user: { username: "tester" },
    network: { localIps: ["10.0.0.2"], publicIp: "203.0.113.10" },
    collector: { version: "0.1.0", installPath: "/opt/lorume" },
  }],
  runtimes: [{
    id: "fixture-mac:runtime:openclaw",
    deviceId: "fixture-mac",
    kind: "openclaw",
    name: "OpenClaw Gateway",
    version: "2026.5.1",
    collectionStatus: "online",
    lastSeenAt: "2026-05-21T10:00:00.000Z",
    diagnostics: { paths: [{ label: "Config", path: "/Users/tester/.openclaw" }] },
  }],
  agents: [{
    id: "fixture-mac:runtime:openclaw:agent:main",
    runtimeId: "fixture-mac:runtime:openclaw",
    name: "main",
    collectionStatus: "online",
    lastSeenAt: "2026-05-21T10:00:00.000Z",
  }],
  taskSummary: {
    byAgentId: { "fixture-mac:runtime:openclaw:agent:main": fixtureTaskCounts },
    byDeviceId: { "fixture-mac": fixtureTaskCounts },
    byRuntimeId: { "fixture-mac:runtime:openclaw": fixtureTaskCounts },
    lastActiveAtByAgentId: { "fixture-mac:runtime:openclaw:agent:main": fixtureLastActiveAt },
    lastActiveAtByDeviceId: { "fixture-mac": fixtureLastActiveAt },
    lastActiveAtByRuntimeId: { "fixture-mac:runtime:openclaw": fixtureLastActiveAt },
  },
  summary: { agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 2 },
};

describe("runtime fleet query", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("summarizes the four product objects for Runtime Fleet metrics", () => {
    expect(summarizeRuntimeFleet(snapshot)).toEqual({
      agents: 1,
      devices: 1,
      runtimes: 1,
      tasks: 2,
    });
  });

  it("uses collection status as the only Runtime and Agent status source", () => {
    const runtime = snapshot.runtimes[0];
    const agent = snapshot.agents[0];

    expect(collectionStatusLabels).toEqual({
      error: "异常",
      invisible: "不可见",
      offline: "离线",
      online: "在线",
      syncing: "同步中",
    });
    expect(deriveDeviceFleetStatus(snapshot, snapshot.devices[0])).toBe("online");
    expect(deriveRuntimeFleetStatus(snapshot, runtime)).toBe("online");
    expect(deriveAgentFleetStatus(snapshot, agent)).toBe("online");

    expect(deriveRuntimeFleetStatus({
      ...snapshot,
      taskSummary: {
        ...snapshot.taskSummary,
        byAgentId: {
          [agent.id]: { ...fixtureTaskCounts, failed: 2, in_progress: 0, todo: 0 },
        },
      },
    }, runtime)).toBe("online");
    expect(deriveAgentFleetStatus(snapshot, agent)).toBe("online");
    expect(deriveAgentFleetStatus(snapshot, { ...agent, collectionStatus: "invisible" })).toBe("invisible");
  });

  it("derives collector version posture from latest package version and upgrade operations", () => {
    expect(collectorVersionPostureLabels).toEqual({
      failed: "升级失败",
      latest: "最新",
      not_reported: "未上报",
      outdated: "待升级",
      requires_manual_step: "需手动升级",
      unknown: "未知",
      upgrading: "升级中",
    });
    expect(deriveCollectorVersionPosture({ currentVersion: "0.1.0", latestVersion: "0.1.0" })).toBe("latest");
    expect(deriveCollectorVersionPosture({ currentVersion: "0.0.9", latestVersion: "0.1.0" })).toBe("outdated");
    expect(deriveCollectorVersionPosture({ currentVersion: undefined, latestVersion: "0.1.0" })).toBe("not_reported");
    expect(deriveCollectorVersionPosture({ currentVersion: "0.1.0", latestVersion: undefined })).toBe("unknown");
    expect(deriveCollectorVersionPosture({
      currentVersion: "0.0.9",
      latestVersion: "0.1.0",
      operationStatus: "running",
    })).toBe("upgrading");
    expect(deriveCollectorVersionPosture({
      currentVersion: "0.0.9",
      latestVersion: "0.1.0",
      operationStatus: "failed",
    })).toBe("failed");
    expect(deriveCollectorVersionPosture({
      currentVersion: "0.0.9",
      latestVersion: "0.1.0",
      operationStatus: "requires_manual_step",
    })).toBe("requires_manual_step");
  });

  it("summarizes collector versions per Device using the latest relevant Operation", () => {
    const summary = summarizeCollectorVersions({
      ...snapshot,
      devices: [
        snapshot.devices[0],
        {
          ...snapshot.devices[0],
          collector: { version: "0.1.0" },
          id: "latest-device",
        },
        {
          ...snapshot.devices[0],
          collector: undefined,
          id: "manual-device",
        },
      ],
    }, "0.1.0", [
      {
        createdAt: "2026-05-21T09:30:00.000Z",
        id: "op_old",
        resourceId: "fixture-mac",
        resourceType: "device",
        status: "failed",
        targetId: "0.1.0",
        targetType: "collector",
        type: "collector_upgrade",
        updatedAt: "2026-05-21T09:40:00.000Z",
      },
      {
        createdAt: "2026-05-21T09:50:00.000Z",
        id: "op_running",
        resourceId: "fixture-mac",
        resourceType: "device",
        status: "running",
        targetId: "0.1.0",
        targetType: "collector",
        type: "collector_upgrade",
        updatedAt: "2026-05-21T09:55:00.000Z",
      },
      {
        createdAt: "2026-05-21T09:59:00.000Z",
        id: "op_manual",
        resourceId: "manual-device",
        resourceType: "device",
        status: "requires_manual_step",
        targetId: "0.1.0",
        targetType: "collector",
        type: "collector_upgrade",
        updatedAt: "2026-05-21T09:59:00.000Z",
      },
    ]);

    expect(summary.latestVersion).toBe("0.1.0");
    expect(summary.byDeviceId["fixture-mac"]).toMatchObject({
      currentVersion: "0.1.0",
      deviceId: "fixture-mac",
      label: "升级中",
      operationId: "op_running",
      operationStatus: "running",
      posture: "upgrading",
      targetVersion: "0.1.0",
    });
    expect(summary.byDeviceId["latest-device"]).toMatchObject({
      currentVersion: "0.1.0",
      label: "最新",
      posture: "latest",
    });
    expect(summary.byDeviceId["manual-device"]).toMatchObject({
      label: "需手动升级",
      operationId: "op_manual",
      operationStatus: "requires_manual_step",
      posture: "requires_manual_step",
    });
    expect(summary.counts).toEqual({
      failed: 0,
      latest: 1,
      not_reported: 0,
      outdated: 0,
      requires_manual_step: 1,
      unknown: 0,
      upgrading: 1,
    });
    expect(summary.actionableCount).toBe(1);
    expect(summary.activeCount).toBe(1);
  });

  it("resolves device detail with only device facts, collector facts, and derived task counts", () => {
    const detail = getRuntimeFleetDetail(snapshot, "device", "fixture-mac");

    expect(detail).toMatchObject({
      kind: "device",
      status: "online",
      statusLabel: "在线",
      title: "fixture-mac",
    });
    expect(sectionItems(detailSections(detail), "基础信息")).toEqual([
      "Hostname: fixture-mac.local",
      "OS: darwin",
      "Arch: arm64",
      "用户: tester",
    ]);
    expect(sectionItems(detailSections(detail), "网络")).toEqual([
      "局域网 IP: 10.0.0.2",
      "公网 IP: 203.0.113.10",
    ]);
    expect(sectionItems(detailSections(detail), "运行资产")).toEqual([
      "状态: 在线",
      "Collector: 0.1.0",
      "Runtime 数量: 1",
      "Agent 数量: 1",
      "Task 数量: 2",
      `最近活跃: ${fixtureLastActiveLabel}`,
    ]);
  });

  it("resolves runtime detail around ownership and task counts without capabilities or endpoint", () => {
    const detail = getRuntimeFleetDetail(snapshot, "runtime", "fixture-mac:runtime:openclaw");

    expect(detail).toMatchObject({
      kind: "runtime",
      runtimeKindLabel: "OpenClaw",
      status: "online",
      statusLabel: "在线",
      title: "OpenClaw Gateway",
    });
    expect(sectionItems(detailSections(detail), "基础信息")).toEqual([
      "Version: 2026.5.1",
      "状态: 在线",
      `最近活跃: ${fixtureLastActiveLabel}`,
    ]);
    expect(sectionItems(detailSections(detail), "归属关系")).toEqual([
      "所属设备: fixture-mac",
      "Agent 数量: 1",
    ]);
    expect(sectionItems(detailSections(detail), "任务统计")).toEqual([
      "全部任务: 2",
      "待处理: 1",
      "进行中: 1",
      "待验收: 0",
      "阻塞: 0",
      "失败: 0",
    ]);
    expect((detail as { capabilities?: unknown }).capabilities).toBeUndefined();
    expect((detail as { endpoint?: unknown }).endpoint).toBeUndefined();
    expect((detail as { sourceRefs?: unknown }).sourceRefs).toBeUndefined();
  });

  it("resolves agent detail through runtime ownership without origin, load, or channel bindings", () => {
    const detail = getRuntimeFleetDetail(snapshot, "agent", "fixture-mac:runtime:openclaw:agent:main");

    expect(detail).toMatchObject({
      deviceId: "fixture-mac",
      kind: "agent",
      runtimeId: "fixture-mac:runtime:openclaw",
      runtimeName: "OpenClaw Gateway",
      status: "online",
      statusLabel: "在线",
      title: "main",
    });
    expect(sectionItems(detailSections(detail), "基础信息")).toEqual([
      "状态: 在线",
      `最近活跃: ${fixtureLastActiveLabel}`,
    ]);
    expect(sectionItems(detailSections(detail), "归属关系")).toEqual([
      "所属 Runtime: OpenClaw Gateway",
      "所属设备: fixture-mac",
    ]);
    expect(sectionItems(detailSections(detail), "任务统计")).toContain("全部任务: 2");
    expect(sectionItems(detailSections(detail), "本地路径")).toEqual(["不适用"]);
    expect((detail as { origin?: unknown }).origin).toBeUndefined();
    expect((detail as { sourceRefs?: unknown }).sourceRefs).toBeUndefined();
    expect((detail as { load?: unknown }).load).toBeUndefined();
  });

  it("parses backend Runtime Fleet responses and strips removed product fields", () => {
    const parsed = runtimeFleetSnapshotFromQueryResponse({
      collectedAt: "2026-05-21T10:00:00.000Z",
      devices: [{
        ...snapshot.devices[0],
        name: "should not leak",
        status: "offline",
        connectionMode: "ssh",
      }],
      runtimes: [{
        ...snapshot.runtimes[0],
        endpoint: "http://localhost:18789",
        capabilities: ["task:list"],
        sourceRefs: [{ source: "openclaw", externalId: "gateway" }],
      }],
      agents: [{
        ...snapshot.agents[0],
        origin: "openclaw",
        load: { activeTasks: 99 },
        sourceRefs: [{ source: "openclaw", externalId: "main" }],
      }],
      summary: { agentCount: 1, deviceCount: 1, runtimeCount: 1, taskCount: 2 },
      taskSummary: snapshot.taskSummary,
      tasks: [{
        runtimeId: "must-not-leak",
        lastRun: { status: "running" },
        title: "should not leak",
        description: "should not leak",
        lastSeenAt: "2026-05-21T10:00:00.000Z",
      }],
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.devices[0]).not.toHaveProperty("name");
    expect(parsed?.devices[0]).not.toHaveProperty("status");
    expect(parsed?.devices[0]).not.toHaveProperty("connectionMode");
    expect(parsed?.runtimes[0]).not.toHaveProperty("endpoint");
    expect(parsed?.runtimes[0]).not.toHaveProperty("capabilities");
    expect(parsed?.runtimes[0]).not.toHaveProperty("sourceRefs");
    expect(parsed?.agents[0]).not.toHaveProperty("origin");
    expect(parsed?.agents[0]).not.toHaveProperty("load");
    expect(parsed?.agents[0]).not.toHaveProperty("sourceRefs");
    expect(parsed).not.toHaveProperty("tasks");
    expect(parsed?.summary.taskCount).toBe(2);
    expect(parsed?.taskSummary.byAgentId["fixture-mac:runtime:openclaw:agent:main"]).toMatchObject({ total: 2 });
    expect(parsed?.taskSummary.lastActiveAtByAgentId?.["fixture-mac:runtime:openclaw:agent:main"]).toBe(fixtureLastActiveAt);
    expect(parsed?.taskSummary.lastActiveAtByRuntimeId?.["fixture-mac:runtime:openclaw"]).toBe(fixtureLastActiveAt);
    expect(parsed?.taskSummary.lastActiveAtByDeviceId?.["fixture-mac"]).toBe(fixtureLastActiveAt);
  });

  it("uses runtime names as the stable display label", () => {
    expect(runtimeDisplayName(snapshot.runtimes[0])).toBe("OpenClaw Gateway");
  });

  it("resolves Task-derived recent activity by Device, Runtime, and Agent", () => {
    expect(runtimeFleetDeviceLastActiveAt(snapshot, "fixture-mac")).toBe(fixtureLastActiveAt);
    expect(runtimeFleetRuntimeLastActiveAt(snapshot, "fixture-mac:runtime:openclaw")).toBe(fixtureLastActiveAt);
    expect(runtimeFleetAgentLastActiveAt(snapshot, "fixture-mac:runtime:openclaw:agent:main")).toBe(fixtureLastActiveAt);
  });

  it("formats recent activity with product-level relative time rules", () => {
    const now = new Date("2026-05-21T10:00:00.000Z");

    expect(formatRelativeActivityTime(undefined, { now })).toBe("暂无活跃");
    expect(formatRelativeActivityTime("not-a-date", { now })).toBe("未知");
    expect(formatRelativeActivityTime("2026-05-21T09:59:30.000Z", { now })).toBe("刚刚");
    expect(formatRelativeActivityTime("2026-05-21T09:17:00.000Z", { now })).toBe("43 分钟前");
    expect(formatRelativeActivityTime("2026-05-21T06:00:00.000Z", { now })).toBe("4 小时前");
    expect(formatRelativeActivityTime("2026-05-20T08:30:00.000Z", { now })).toBe("昨天 16:30");
    expect(formatRelativeActivityTime("2026-05-18T08:30:00.000Z", { now })).toBe("3 天前");
    expect(formatRelativeActivityTime("2026-05-08T08:30:00.000Z", { now })).toBe("05月08日");
    expect(formatRelativeActivityTime("2025-12-08T08:30:00.000Z", { now })).toBe("2025年12月08日");
  });
});

function detailSections(detail: unknown): Array<{ title: string; items: string[] }> {
  if (!detail || typeof detail !== "object" || !("sections" in detail)) return [];
  return (detail as { sections: Array<{ title: string; items: string[] }> }).sections;
}

function sectionItems(sections: Array<{ title: string; items: string[] }>, title: string): string[] {
  return sections.find((section) => section.title === title)?.items ?? [];
}
