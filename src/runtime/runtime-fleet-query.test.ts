import { describe, expect, it } from "vitest";
import {
  collectionStatusLabels,
  deriveAgentFleetStatus,
  deriveDeviceFleetStatus,
  deriveRuntimeFleetStatus,
  filterRuntimeFleet,
  formatRuntimeTimestamp,
  getRuntimeFleetDetail,
  listRuntimeFleetRuntimeKindOptions,
  runtimeDisplayName,
  runtimeFleetSnapshotFromQueryResponse,
  summarizeRuntimeFleet,
  type RuntimeFleetSnapshot,
} from "./runtime-fleet-query";

const fixtureLastSeenAt = formatRuntimeTimestamp("2026-05-21T10:00:00.000Z");

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
  tasks: [
    {
      id: "fixture-mac:runtime:openclaw:agent:main:task:todo-1",
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      taskType: "conversation",
      userMessage: "PMO asked OpenClaw to inspect the handoff.",
      agentReply: "The handoff looks ready for review.",
      status: "todo",
      adapter: { kind: "openclaw" },
      channel: { kind: "dingtalk", externalId: "group-live" },
      conversation: { title: "DingTalk 群聊", externalId: "conversation-1" },
      creator: { name: "PMO" },
      assignee: { name: "main" },
      updatedAt: "2026-05-21T09:59:00.000Z",
    },
    {
      id: "fixture-mac:runtime:openclaw:agent:main:task:running-1",
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      taskType: "conversation",
      userMessage: "Execute OpenClaw run",
      status: "in_progress",
      adapter: { kind: "openclaw" },
      channel: { kind: "dingtalk" },
      updatedAt: "2026-05-21T10:00:00.000Z",
    },
  ],
};

describe("runtime fleet query", () => {
  it("summarizes the four product objects for Runtime Fleet metrics", () => {
    expect(summarizeRuntimeFleet(snapshot)).toEqual({
      agents: 1,
      devices: 1,
      runtimes: 1,
      tasks: 2,
    });
  });

  it("lists only supported runtime kinds present in the current snapshot", () => {
    expect(listRuntimeFleetRuntimeKindOptions({
      ...snapshot,
      runtimes: [
        ...snapshot.runtimes,
        {
          id: "fixture-mac:runtime:codex",
          deviceId: "fixture-mac",
          kind: "codex",
          name: "Codex",
          collectionStatus: "online",
        },
      ],
    })).toEqual([
      { label: "OpenClaw", value: "openclaw" },
      { label: "Codex", value: "codex" },
    ]);
  });

  it("uses collection status as the only Runtime and Agent status source", () => {
    const runtime = snapshot.runtimes[0];
    const agent = snapshot.agents[0];

    expect(collectionStatusLabels).toEqual({
      error: "异常",
      offline: "离线",
      online: "在线",
      syncing: "同步中",
    });
    expect(deriveDeviceFleetStatus(snapshot, snapshot.devices[0])).toBe("online");
    expect(deriveRuntimeFleetStatus(snapshot, runtime)).toBe("online");
    expect(deriveAgentFleetStatus(snapshot, agent)).toBe("online");

    const changedTaskSnapshot: RuntimeFleetSnapshot = {
      ...snapshot,
      tasks: snapshot.tasks.map((task) => ({ ...task, status: "failed" })),
    };
    expect(deriveRuntimeFleetStatus(changedTaskSnapshot, runtime)).toBe("online");
    expect(deriveAgentFleetStatus(changedTaskSnapshot, agent)).toBe("online");
  });

  it("filters fleet objects without relying on removed fields", () => {
    const result = filterRuntimeFleet(snapshot, { query: "dingtalk" });

    expect(result.devices.map((device) => device.id)).toEqual(["fixture-mac"]);
    expect(result.runtimes.map((runtime) => runtime.name)).toEqual(["OpenClaw Gateway"]);
    expect(result.agents.map((agent) => agent.name)).toEqual(["main"]);
    expect(result.tasks.map((task) => task.userMessage)).toEqual([
      "PMO asked OpenClaw to inspect the handoff.",
      "Execute OpenClaw run",
    ]);
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
      "Lorume ID: fixture-mac",
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
      `最近同步: ${fixtureLastSeenAt}`,
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
      "Lorume ID: fixture-mac:runtime:openclaw",
      "Version: 2026.5.1",
      "状态: 在线",
      `最近同步: ${fixtureLastSeenAt}`,
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
      "Lorume ID: fixture-mac:runtime:openclaw:agent:main",
      "状态: 在线",
      `最近同步: ${fixtureLastSeenAt}`,
    ]);
    expect(sectionItems(detailSections(detail), "归属关系")).toEqual([
      "所属 Runtime: OpenClaw Gateway",
      "所属设备: fixture-mac",
    ]);
    expect(sectionItems(detailSections(detail), "任务统计")).toContain("全部任务: 2");
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
      tasks: [{
        ...snapshot.tasks[0],
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
    expect(parsed?.tasks[0]).not.toHaveProperty("runtimeId");
    expect(parsed?.tasks[0]).not.toHaveProperty("lastRun");
    expect(parsed?.tasks[0]).not.toHaveProperty("title");
    expect(parsed?.tasks[0]).not.toHaveProperty("description");
    expect(parsed?.tasks[0]).not.toHaveProperty("lastSeenAt");
  });

  it("uses runtime names as the stable display label", () => {
    expect(runtimeDisplayName(snapshot.runtimes[0])).toBe("OpenClaw Gateway");
  });
});

function detailSections(detail: unknown): Array<{ title: string; items: string[] }> {
  if (!detail || typeof detail !== "object" || !("sections" in detail)) return [];
  return (detail as { sections: Array<{ title: string; items: string[] }> }).sections;
}

function sectionItems(sections: Array<{ title: string; items: string[] }>, title: string): string[] {
  return sections.find((section) => section.title === title)?.items ?? [];
}
