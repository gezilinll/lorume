import { describe, expect, it } from "vitest";
import fixtureSnapshot from "../../fixtures/runtime/collector-snapshot.sample.json";
import {
  deriveAgentFleetStatus,
  deriveDeviceFleetStatus,
  deriveRuntimeFleetStatus,
  deriveRuntimeOperatingStatus,
  formatRuntimeTimestamp,
  filterRuntimeFleet,
  getRuntimeFleetDetail,
  runtimeOperatingStatusLabels,
  runtimeFleetObjectStatusLabels,
  runtimeDisplayName,
  listRuntimeFleetRuntimeKindOptions,
  summarizeRuntimeFleet,
} from "./runtime-inventory-query";
import type { RuntimeInventorySnapshot } from "./runtime-normalize";
import type { RuntimeWorkStateSnapshot } from "./runtime-work-state";

const snapshot = fixtureSnapshot as RuntimeInventorySnapshot;
const fixtureLastSeenAt = formatRuntimeTimestamp("2026-05-08T08:00:01.000Z");

describe("runtime inventory query", () => {
  it("summarizes fixture inventory for Runtime Fleet metrics", () => {
    expect(summarizeRuntimeFleet(snapshot)).toEqual({
      devices: 1,
      runtimes: 2,
      agents: 2,
    });
  });

  it("lists Runtime Fleet filter options from the current snapshot", () => {
    expect(listRuntimeFleetRuntimeKindOptions(snapshot).map((option) => option.value)).toEqual([
      "openclaw",
      "slock",
    ]);
  });

  it("derives Runtime operating status from Agent work state without using platform raw states", () => {
    const slockRuntime = snapshot.runtimes.find((runtime) => runtime.kind === "slock");
    if (!slockRuntime) throw new Error("missing Slock runtime fixture");
    const workState: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: snapshot.device.id,
      workItems: [
        {
          id: "fixture-slock-task-1",
          source: "slock",
          externalId: "fixture-slock-task-1",
          title: "Example in progress card",
          status: "in_progress",
          runtimeId: slockRuntime.id,
          agentId: "fixture-mac:slock:slock-daemon:agent:tester",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };

    expect(deriveRuntimeOperatingStatus(snapshot, slockRuntime, workState)).toBe("working");
    expect(runtimeOperatingStatusLabels.working).toBe("工作中");
  });

  it("marks an online Runtime idle only when the adapter can observe that it has no processing work", () => {
    const slockRuntime = snapshot.runtimes.find((runtime) => runtime.kind === "slock");
    if (!slockRuntime) throw new Error("missing Slock runtime fixture");
    const idleWorkState: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: snapshot.device.id,
      workItems: [],
      conversations: [],
      executions: [],
      capabilities: [
        {
          source: "slock",
          collectedAt: "2026-05-09T08:00:00.000Z",
          workItems: { support: "supported", strategies: ["native_api"], evidence: [], limitations: [] },
          conversations: { support: "partial", strategies: ["native_api"], evidence: [], limitations: [] },
          executions: { support: "unknown", strategies: ["native_api"], evidence: [], limitations: [] },
        },
      ],
    };

    expect(deriveRuntimeOperatingStatus(snapshot, slockRuntime, idleWorkState)).toBe("idle");
    expect(deriveRuntimeOperatingStatus(snapshot, slockRuntime, undefined)).toBe("unknown");
    expect(deriveRuntimeFleetStatus(snapshot, slockRuntime, undefined)).toBe("exception");
    expect(runtimeFleetObjectStatusLabels.exception).toBe("异常");
    expect(Object.values(runtimeFleetObjectStatusLabels)).not.toContain("未知");
  });

  it("treats linked non-processing work evidence as enough to mark a Runtime idle", () => {
    const slockRuntime = snapshot.runtimes.find((runtime) => runtime.kind === "slock");
    if (!slockRuntime) throw new Error("missing Slock runtime fixture");
    const closedWorkState: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: snapshot.device.id,
      workItems: [
        {
          id: "fixture-slock-task-3",
          source: "slock",
          externalId: "fixture-slock-task-3",
          title: "Example done card",
          status: "done",
          runtimeId: slockRuntime.id,
          agentId: "fixture-mac:slock:slock-daemon:agent:tester",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };

    expect(deriveRuntimeOperatingStatus(snapshot, slockRuntime, closedWorkState)).toBe("idle");
  });

  it("uses latest execution evidence when deriving Runtime operating status", () => {
    const openClawRuntime = snapshot.runtimes.find((runtime) => runtime.kind === "openclaw");
    if (!openClawRuntime) throw new Error("missing OpenClaw runtime fixture");
    const completedWorkState: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: snapshot.device.id,
      workItems: [
        {
          id: "fixture-openclaw-work-item",
          source: "openclaw",
          externalId: "fixture-openclaw-work-item",
          title: "Retry eventually succeeded",
          status: "in_progress",
          runtimeId: openClawRuntime.id,
          agentId: "fixture-mac:openclaw:gateway-18789:agent:main",
        },
      ],
      conversations: [],
      executions: [
        {
          id: "fixture-openclaw-execution-old",
          source: "openclaw",
          externalId: "old",
          runtimeId: openClawRuntime.id,
          agentId: "fixture-mac:openclaw:gateway-18789:agent:main",
          workItemId: "fixture-openclaw-work-item",
          status: "running",
          lastSeenAt: "2026-05-09T08:00:00.000Z",
        },
        {
          id: "fixture-openclaw-execution-new",
          source: "openclaw",
          externalId: "new",
          runtimeId: openClawRuntime.id,
          agentId: "fixture-mac:openclaw:gateway-18789:agent:main",
          workItemId: "fixture-openclaw-work-item",
          status: "succeeded",
          lastSeenAt: "2026-05-09T08:05:00.000Z",
        },
      ],
      capabilities: [],
    };

    expect(deriveRuntimeOperatingStatus(snapshot, openClawRuntime, completedWorkState)).toBe("idle");
  });

  it("keeps offline Runtime status separate from Agent work-board stages", () => {
    const slockRuntime = snapshot.runtimes.find((runtime) => runtime.kind === "slock");
    if (!slockRuntime) throw new Error("missing Slock runtime fixture");
    const offlineSnapshot: RuntimeInventorySnapshot = {
      ...snapshot,
      runtimes: snapshot.runtimes.map((runtime) =>
        runtime.id === slockRuntime.id ? { ...runtime, status: "offline" } : runtime,
      ),
    };
    const offlineRuntime = offlineSnapshot.runtimes.find((runtime) => runtime.id === slockRuntime.id);
    if (!offlineRuntime) throw new Error("missing offline Slock runtime fixture");

    expect(deriveRuntimeOperatingStatus(offlineSnapshot, offlineRuntime, undefined)).toBe("offline");
    expect(deriveDeviceFleetStatus(offlineSnapshot, offlineSnapshot.device)).toBe("working");
  });

  it("filters runtimes and agents by query", () => {
    const result = filterRuntimeFleet(snapshot, { query: "tester" });

    expect(result.runtimes.map((runtime) => runtime.name)).toEqual(["Slock daemon"]);
    expect(result.agents.map((agent) => agent.name)).toEqual(["tester"]);
  });

  it("filters agents by runtime kind without dropping device context", () => {
    const result = filterRuntimeFleet(snapshot, { runtimeKind: "slock" });

    expect(result.device.id).toBe("fixture-mac");
    expect(result.agents.map((agent) => agent.name)).toEqual(["tester"]);
    expect(result.runtimes.map((runtime) => runtime.kind)).toEqual(["slock"]);
  });

  it("preserves multi-device ownership in filters and detail sections", () => {
    const multiDeviceSnapshot: RuntimeInventorySnapshot = {
      ...snapshot,
      devices: [
        snapshot.device,
        {
          id: "edge-node-2",
          hostname: "edge-node-2.local",
          os: "linux",
          architecture: "x64",
          lastSeenAt: "2026-05-19T10:00:00.000Z",
        },
      ],
      runtimes: [
        ...snapshot.runtimes,
        {
          id: "edge-node-2:codex:runtime-main",
          deviceId: "edge-node-2",
          kind: "codex",
          name: "Codex Runtime",
          status: "online",
          capabilities: ["cli:version"],
          lastSeenAt: "2026-05-19T10:00:00.000Z",
          sourceRefs: [{ source: "codex", externalId: "runtime-main", label: "Codex Runtime" }],
        },
      ],
      agents: [
        ...snapshot.agents,
        {
          id: "edge-node-2:codex:runtime-main:agent:reviewer",
          runtimeId: "edge-node-2:codex:runtime-main",
          name: "reviewer",
          origin: "codex",
          status: "idle",
          channelBindings: [{ kind: "other", label: "CLI", status: "enabled" }],
          sourceRefs: [{ source: "codex", externalId: "reviewer", label: "reviewer" }],
          lastSeenAt: "2026-05-19T10:00:00.000Z",
        },
      ],
    };

    expect(summarizeRuntimeFleet(multiDeviceSnapshot).devices).toBe(2);
    const result = filterRuntimeFleet(multiDeviceSnapshot, { query: "edge-node" });
    expect(result.devices.map((device) => device.id)).toEqual(["edge-node-2"]);
    expect(result.runtimes.map((runtime) => runtime.name)).toEqual(["Codex Runtime"]);

    const detail = getRuntimeFleetDetail(multiDeviceSnapshot, "runtime", "edge-node-2:codex:runtime-main");
    expect(sectionItems(detailSections(detail), "归属关系")).toContain("所属设备: edge-node-2");
  });

  it("resolves selected agent detail with its runtime", () => {
    const detail = getRuntimeFleetDetail(snapshot, "agent", "fixture-mac:slock:slock-daemon:agent:tester");

    expect(detail).toMatchObject({
      kind: "agent",
      title: "tester",
      runtimeName: "Slock daemon",
      status: "exception",
      statusLabel: "异常",
      sections: expect.arrayContaining([
        expect.objectContaining({ title: "关联渠道", items: ["Slock"] }),
      ]),
    });
  });

  it("derives Slock Agent display status from task-board assignee evidence", () => {
    const detail = getRuntimeFleetDetail(
      snapshot,
      "agent",
      "fixture-mac:slock:slock-daemon:agent:tester",
      {
        observedAt: "2026-05-09T08:00:00.000Z",
        deviceId: snapshot.device.id,
        workItems: [
          {
            id: "fixture-slock-task-1",
            source: "slock",
            externalId: "fixture-slock-task-1",
            title: "Slock board card assigned to tester",
            status: "in_progress",
            runtimeId: "fixture-mac:slock:slock-daemon",
            agentId: "fixture-mac:slock:slock-daemon:agent:workspace-owner",
            assignee: { kind: "agent", label: "tester" },
          },
        ],
        conversations: [],
        executions: [],
        capabilities: [],
      },
    );

    expect(detail).toMatchObject({
      kind: "agent",
      title: "tester",
      status: "working",
      statusLabel: "工作中",
      subtitle: "Slock · 工作中",
    });
    expect(sectionItems(detailSections(detail), "基础信息")).toContain("状态: 工作中");
  });

  it("aggregates Agent runtime statistics from linked work-state evidence", () => {
    const detail = getRuntimeFleetDetail(
      snapshot,
      "agent",
      "fixture-mac:slock:slock-daemon:agent:tester",
      {
        observedAt: "2026-05-09T08:00:00.000Z",
        deviceId: snapshot.device.id,
        workItems: [
          {
            id: "fixture-slock-task-running",
            source: "slock",
            externalId: "fixture-slock-task-running",
            title: "Running Slock board card",
            status: "in_progress",
            runtimeId: "fixture-mac:slock:slock-daemon",
            agentId: "fixture-mac:slock:slock-daemon:agent:workspace-owner",
            assignee: { kind: "agent", label: "tester" },
            conversationId: "fixture-mac:slock:slock-daemon:conversation:thread-running",
          },
          {
            id: "fixture-slock-task-queued",
            source: "slock",
            externalId: "fixture-slock-task-queued",
            title: "Queued Slock board card",
            status: "todo",
            runtimeId: "fixture-mac:slock:slock-daemon",
            agentId: "fixture-mac:slock:slock-daemon:agent:workspace-owner",
            assignee: { kind: "agent", label: "tester" },
            conversationId: "fixture-mac:slock:slock-daemon:conversation:thread-queued",
          },
        ],
        conversations: [
          {
            id: "fixture-mac:slock:slock-daemon:conversation:thread-running",
            source: "slock",
            externalId: "thread-running",
            status: "open",
            runtimeId: "fixture-mac:slock:slock-daemon",
            agentId: "fixture-mac:slock:slock-daemon:agent:workspace-owner",
            workItemId: "fixture-slock-task-running",
          },
          {
            id: "fixture-mac:slock:slock-daemon:conversation:thread-queued",
            source: "slock",
            externalId: "thread-queued",
            status: "closed",
            runtimeId: "fixture-mac:slock:slock-daemon",
            agentId: "fixture-mac:slock:slock-daemon:agent:workspace-owner",
            workItemId: "fixture-slock-task-queued",
          },
        ],
        executions: [],
        capabilities: [],
      },
    );

    expect(sectionItems(detailSections(detail), "运行统计")).toEqual([
      "活跃任务: 1",
      "队列深度: 1",
      "活跃会话: 1",
      "历史会话: 2",
      "最大并发: 不支持采集",
    ]);
  });

  it("resolves device detail into human-readable sections without raw source lists", () => {
    const detail = getRuntimeFleetDetail(snapshot, "device", "fixture-mac");
    const sections = detailSections(detail);

    expect(sectionItems(sections, "基础信息")).toEqual([
      "Lorume ID: fixture-mac",
      "Hostname: fixture-mac.local",
      "OS: darwin",
      "Arch: arm64",
      "用户: 未上报",
    ]);
    expect(sectionItems(sections, "网络")).toEqual([
      "局域网 IP: 未上报",
      "公网 IP: 未上报",
    ]);
    expect(sectionItems(sections, "运行资产")).toEqual([
      "状态: 工作中",
      "Collector: 0.1.0",
      "Runtime 数量: 2",
      `最近同步: ${fixtureLastSeenAt}`,
    ]);
    expect(sectionItems(sections, "已注册 Runtime")).toEqual(["OpenClaw Gateway", "Slock daemon"]);
    expect((detail as { sourceLabels?: string[] })?.sourceLabels).toBeUndefined();
  });

  it("resolves runtime detail around ownership without agent workload statistics", () => {
    const detail = getRuntimeFleetDetail(snapshot, "runtime", "fixture-mac:openclaw:gateway-18789");
    const sections = detailSections(detail);

    expect(sectionItems(sections, "基础信息")).toEqual([
      "Lorume ID: fixture-mac:openclaw:gateway-18789",
      "Version: 2026.4.27",
      "状态: 异常",
      `最近同步: ${fixtureLastSeenAt}`,
    ]);
    expect(sectionItems(sections, "归属关系")).toEqual(["所属设备: fixture-mac", "Agent 数量: 1"]);
    expect(sectionItems(sections, "运行入口")).toEqual([]);
    expect(sectionItems(sections, "运行统计")).toEqual([]);
    expect((detail as { capabilities?: string[] })?.capabilities).toBeUndefined();
    expect((detail as { channelLabels?: string[] })?.channelLabels).toBeUndefined();
  });

  it("resolves agent detail around runtime ownership and channel exposure", () => {
    const detail = getRuntimeFleetDetail(snapshot, "agent", "fixture-mac:slock:slock-daemon:agent:tester");
    const sections = detailSections(detail);

    expect(sectionItems(sections, "基础信息")).toEqual([
      "Lorume ID: fixture-mac:slock:slock-daemon:agent:tester",
      "状态: 异常",
      `最近同步: ${fixtureLastSeenAt}`,
    ]);
    expect(sectionItems(sections, "归属关系")).toEqual([
      "所属 Runtime: Slock daemon",
      "所属设备: fixture-mac",
    ]);
    expect(sectionItems(sections, "关联渠道")).toEqual(["Slock"]);
    expect(sectionItems(sections, "运行统计")).toEqual([
      "活跃任务: 不支持采集",
      "队列深度: 不支持采集",
      "活跃会话: 不支持采集",
      "历史会话: 不支持采集",
      "最大并发: 不支持采集",
    ]);
    expect((detail as { sourceLabels?: string[] })?.sourceLabels).toBeUndefined();
  });

  it("falls back agent last sync to its runtime when older snapshots omit agent-level observation time", () => {
    const legacySnapshot: RuntimeInventorySnapshot = {
      ...snapshot,
      agents: snapshot.agents.map((agent) => {
        if (agent.id !== "fixture-mac:slock:slock-daemon:agent:tester") return agent;
        const { lastSeenAt, ...agentWithoutLastSeenAt } = agent;
        void lastSeenAt;
        return agentWithoutLastSeenAt;
      }),
    };

    const detail = getRuntimeFleetDetail(
      legacySnapshot,
      "agent",
      "fixture-mac:slock:slock-daemon:agent:tester",
    );
    const sections = detailSections(detail);

    expect(sectionItems(sections, "基础信息")).toContain(`最近同步: ${fixtureLastSeenAt}`);
  });

  it("formats timestamps for UI display without leaking raw ISO strings", () => {
    const formatted = formatRuntimeTimestamp("2026-05-08T08:00:01.000Z");

    expect(formatted).not.toContain("T");
    expect(formatted).toContain("2026");
    expect(formatted).toContain("16:00");
  });

  it("uses runtime names as the stable display label for agent ownership", () => {
    expect(runtimeDisplayName(snapshot.runtimes[0])).toBe("OpenClaw Gateway");
    expect(runtimeDisplayName(snapshot.runtimes[1])).toBe("Slock daemon");
  });

  it("folds collection exceptions into concrete asset statuses", () => {
    const failedCollection = new Map([
      [snapshot.device.id, { deviceId: snapshot.device.id, status: "failed" as const, summary: "采集异常", checks: [] }],
    ]);
    const openClawRuntime = snapshot.runtimes.find((runtime) => runtime.kind === "openclaw");
    const openClawAgent = snapshot.agents.find((agent) => agent.runtimeId === openClawRuntime?.id);
    if (!openClawRuntime || !openClawAgent) throw new Error("missing OpenClaw fixture");

    expect(deriveDeviceFleetStatus(snapshot, snapshot.device, failedCollection)).toBe("exception");
    expect(deriveRuntimeFleetStatus(snapshot, openClawRuntime, null, failedCollection)).toBe("exception");
    expect(deriveAgentFleetStatus(snapshot, openClawAgent, null, failedCollection)).toBe("exception");
  });
});

function detailSections(detail: unknown): Array<{ title: string; items: string[] }> {
  if (!detail || typeof detail !== "object" || !("sections" in detail)) return [];
  return (detail as { sections: Array<{ title: string; items: string[] }> }).sections;
}

function sectionItems(sections: Array<{ title: string; items: string[] }>, title: string): string[] {
  return sections.find((section) => section.title === title)?.items ?? [];
}
