import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fleetFixture from "../fixtures/runtime/runtime-fleet-query.sample.json";
import { App } from "./App";
import type { RuntimeFleetSnapshot } from "./runtime/runtime-fleet-query";
import { TASK_CHANNEL_KIND_LABELS, TASK_STATUSES, type AgentCollectionStatus, type CollectionStatus, type Task, type TaskChannelKind } from "./runtime/runtime-model";

const originalFetch = globalThis.fetch;
const originalPath = window.location.pathname;
const fleetSnapshot = fleetFixture as RuntimeFleetSnapshot;
const defaultAgentId = fleetSnapshot.agents[0].id;
const defaultRuntimeId = fleetSnapshot.runtimes[0].id;
const rawDingTalkCid = "cid-private-raw-123";

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.history.pushState({}, "", originalPath);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function requestUrl(input: Parameters<typeof fetch>[0] | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function runtimeFleetQueryResponse(snapshot: RuntimeFleetSnapshot) {
  return {
    collectedAt: snapshot.collectedAt,
    devices: snapshot.devices,
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    taskSummary: snapshot.taskSummary,
    summary: snapshot.summary,
  };
}

function taskQueryResponse(tasks: unknown[], nextCursor?: string, total = tasks.length) {
  const byStatus = taskStatusCounts(tasks);
  byStatus.total = total;
  const channels = taskChannelFacets(tasks);
  return {
    facets: { channels },
    items: tasks,
    summary: { byStatus, total: byStatus.total },
    total,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function taskStatusCounts(tasks: unknown[]) {
  const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<Task["status"], number> & { total: number };
  counts.total = 0;
  for (const task of tasks as Task[]) {
    if (!TASK_STATUSES.includes(task.status)) continue;
    counts[task.status] += 1;
    counts.total += 1;
  }
  return counts;
}

function taskChannelFacets(tasks: unknown[]) {
  const counts = new Map<TaskChannelKind, number>();
  for (const task of tasks as Task[]) {
    if (!task.channel?.kind) continue;
    counts.set(task.channel.kind, (counts.get(task.channel.kind) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([kind, count]) => ({
    count,
    kind,
    label: TASK_CHANNEL_KIND_LABELS[kind],
  }));
}

function collectionHealthResponse(snapshot: RuntimeFleetSnapshot) {
  return {
    checks: [
      {
        counts: {
          agents: snapshot.agents.length,
          devices: snapshot.devices.length,
          runtimes: snapshot.runtimes.length,
          tasks: snapshot.summary.taskCount,
        },
        error: null,
        id: "device_state",
        label: "设备状态",
        lastCollectedAt: snapshot.collectedAt,
        lastReceivedAt: snapshot.collectedAt,
        message: "采集正常",
        status: "healthy",
        diagnostics: [],
      },
    ],
    deviceId: snapshot.devices[0].id,
    lastCollectedAt: snapshot.collectedAt,
    lastReceivedAt: snapshot.collectedAt,
    status: "healthy",
    summary: "采集正常",
  };
}

function deviceDiagnosticsResponse(
  snapshot: RuntimeFleetSnapshot,
  status = "online",
  label = "在线",
) {
  return {
    deviceId: snapshot.devices[0].id,
    label,
    lastHeartbeatAt: snapshot.collectedAt,
    lastDeviceStateSuccessAt: snapshot.collectedAt,
    message: "设备最近完成成功同步",
    reason: "device_state_fresh",
    status,
  };
}

function agentAnalysisReportResponse(snapshot = fleetSnapshot) {
  const agentId = snapshot.agents[0].id;
  return {
    agentId,
    analysis: {
      periodPerformance: {
        completion: "多数需求在周期内完成，少量任务仍需补充结果证据。",
        failurePattern: "失败集中在工具调用和验收信息不足的任务。",
        latency: "常规任务响应稳定，复杂变更耗时更长。",
        workload: "Queue triage dominated the day.",
      },
      taskTypes: [
        {
          cases: [
            {
              id: "task_done_1",
              outcome: "Delivered backend plan.",
              reason: "Covers planning, backend and validation work.",
              signal: "mixed",
              title: "Collector upgrade analysis",
            },
          ],
          countEstimate: 6,
          description: "围绕需求澄清、方案拆解和验收条件确认的任务。",
          label: "需求澄清",
          satisfaction: {
            evidenceIds: ["task_done_1"],
            level: "mixed",
            reason: "用户持续追问细节并推动方案调整，说明有推进也有返工。",
          },
        },
      ],
      risks: [
        {
          description: "Some tasks still lack explicit outcome messages.",
          evidenceIds: ["task_done_1"],
          title: "结果证据不足",
        },
      ],
      actions: [
        {
          evidenceIds: ["task_done_1"],
          reason: "在复杂任务完成后补充清晰的验收结论。",
          title: "补齐结果回执",
        },
      ],
    },
    createdAt: "2026-06-03T08:20:00.000Z",
    deviceId: snapshot.devices[0].id,
    hardMetrics: {
      duration: {
        basis: "trajectoryElapsed",
        includedStatuses: ["done", "failed"],
        sampleCount: 5,
        avgMs: 120000,
        p50Ms: 90000,
        p90Ms: 240000,
      },
      failedCount: 1,
      lastActiveAt: "2026-06-03T07:55:00.000Z",
      periodEnd: "2026-06-03T16:00:00.000Z",
      periodStart: "2026-06-02T16:00:00.000Z",
      statusCounts: { done: 4, failed: 1, unknown: 1 },
      taskTypeCounts: { conversation: 6 },
      totalTasks: 6,
      unknownCount: 1,
    },
    id: "report_app_1",
    modelMetadata: {
      model: "gpt-5-mini",
      provider: "openai",
      usage: { input: 1000, output: 300, total: 1300 },
    },
    operationId: "operation_app_1",
    organizationId: "agent-local-organization",
    periodEnd: "2026-06-03T16:00:00.000Z",
    periodStart: "2026-06-02T16:00:00.000Z",
    promptKind: "daily_operation_review",
    promptVersion: "openclaw-agent-operation-analysis-v2",
    runtimeId: snapshot.runtimes[0].id,
    runtimeKind: "openclaw",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    agentId: defaultAgentId,
    adapter: { kind: "openclaw" },
    status: "todo",
    taskType: "conversation",
    ...overrides,
  };
}

async function chooseRunsStatus(label: string) {
  await userEvent.click(screen.getByRole("tab", { name: label }));
}

function fleetWithStatus(runtimeStatus: CollectionStatus, agentStatus: AgentCollectionStatus): RuntimeFleetSnapshot {
  return {
    ...fleetSnapshot,
    agents: fleetSnapshot.agents.map((agent) => ({
      ...agent,
      collectionStatus: agentStatus,
    })),
    runtimes: fleetSnapshot.runtimes.map((runtime) => ({
      ...runtime,
      collectionStatus: runtimeStatus,
    })),
  };
}

function installRuntimeFleetFetch(snapshot = fleetSnapshot) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = requestUrl(input);
    if (url.includes("/api/runtime-fleet")) return jsonResponse(runtimeFleetQueryResponse(snapshot));
    if (url.includes("/api/device-collector/manifest.json")) {
      return jsonResponse({ schemaVersion: "collector-package-v1", version: snapshot.devices[0].collector?.version ?? "0.1.0" });
    }
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/collection-health`)) {
      return jsonResponse(collectionHealthResponse(snapshot));
    }
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/diagnostics`)) {
      return jsonResponse(deviceDiagnosticsResponse(snapshot));
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;
}

function installSkillWarehouseFetch(snapshot = fleetSnapshot) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = requestUrl(input);
    if (url.includes("/api/runtime-fleet")) return jsonResponse(runtimeFleetQueryResponse(snapshot));
    if (url.includes(`/api/runtimes/${encodeURIComponent(snapshot.runtimes[0].id)}/skill-probe`)) {
      return jsonResponse(runtimeSkillProbeResponse(snapshot));
    }
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/collection-health`)) {
      return jsonResponse(collectionHealthResponse(snapshot));
    }
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/diagnostics`)) {
      return jsonResponse(deviceDiagnosticsResponse(snapshot));
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;
}

function installScheduledTasksFetch(snapshot = fleetSnapshot) {
  const scheduleKey = `${snapshot.runtimes[0].id}:schedule:daily-report`;
  const scheduledExecution = task({
    agentId: snapshot.agents[0].id,
    createdAt: "2026-05-29T08:00:00.000Z",
    id: "scheduled-execution-daily-report",
    status: "done",
    taskType: "scheduled",
    updatedAt: "2026-05-29T08:03:00.000Z",
    userMessage: "Generate daily report",
  });
  globalThis.fetch = vi.fn(async (input) => {
    const url = requestUrl(input);
    if (url.includes("/api/runtime-scheduled-tasks/") && url.includes("/executions")) {
      const byStatus = taskStatusCounts([scheduledExecution]);
      byStatus.total = 1;
      return jsonResponse({
        items: [scheduledExecution],
        summary: { byStatus, total: 1 },
        total: 1,
      });
    }
    if (url.includes("/api/runtime-scheduled-tasks")) {
      return jsonResponse({
        items: [{
          agentIds: [snapshot.agents[0].id],
          agentNames: [snapshot.agents[0].name],
          deviceId: snapshot.devices[0].id,
          enabled: true,
          executionCount: 1,
          expression: "0 8 * * *",
          latestExecutionAt: "2026-05-29T08:03:00.000Z",
          latestStatus: "done",
          name: "每日数据报告",
          nextRunAt: "2026-05-30T08:00:00.000Z",
          runtimeId: snapshot.runtimes[0].id,
          runtimeKind: snapshot.runtimes[0].kind,
          runtimeName: snapshot.runtimes[0].name,
          scheduleKey,
          sourceId: "daily-report",
          summary: {
            byStatus: taskStatusCounts([scheduledExecution]),
          },
          timezone: "Asia/Shanghai",
        }],
        summary: {
          disabledCount: 0,
          enabledCount: 1,
          total: 1,
        },
        total: 1,
      });
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;
}

function installAgentDashboardFetch(snapshot = fleetSnapshot) {
  globalThis.fetch = vi.fn(async (input) => {
    const url = requestUrl(input);
    if (url.includes("/api/runtime-fleet")) return jsonResponse(runtimeFleetQueryResponse(snapshot));
    if (url.includes("/api/agent-analysis-reports")) return jsonResponse({ reports: [agentAnalysisReportResponse(snapshot)] });
    if (url.includes("/api/device-collector/manifest.json")) {
      return jsonResponse({ schemaVersion: "collector-package-v1", version: snapshot.devices[0].collector?.version ?? "0.1.0" });
    }
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/collection-health`)) {
      return jsonResponse(collectionHealthResponse(snapshot));
    }
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/diagnostics`)) {
      return jsonResponse(deviceDiagnosticsResponse(snapshot));
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;
}

function runtimeSkillProbeResponse(snapshot = fleetSnapshot) {
  return {
    deviceId: snapshot.devices[0].id,
    observedAt: "2026-05-21T10:05:00.000Z",
    runtimeId: snapshot.runtimes[0].id,
    runtimeKind: snapshot.runtimes[0].kind,
    status: "succeeded",
    summary: {
      agentScopeCount: 2,
      availableCount: 2,
      builtInCount: 1,
      runtimeScopeCount: 1,
      total: 3,
      unavailableCount: 1,
    },
    skills: [
      {
        agentIds: [],
        available: true,
        body: "# Browser\n\nUse browser automation for screenshots and inspection.",
        builtIn: true,
        description: "Runtime common browser automation.",
        localPath: "~/.codex/skills/.system/browser/SKILL.md",
        name: "browser",
        scope: "runtime",
      },
      {
        agentIds: [snapshot.agents[0].id],
        available: true,
        builtIn: false,
        description: "Review pull requests.",
        name: "code-review",
        scope: "agent",
      },
      {
        agentIds: [`${snapshot.runtimes[0].id}:agent:other`],
        available: false,
        builtIn: false,
        description: "Other Agent only.",
        name: "other-agent-skill",
        scope: "agent",
      },
    ],
  };
}

describe("Console shell", () => {
  it("renders a public home entry at the root without probing auth", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    window.history.pushState({}, "", "/");

    render(<App runtimeMode="production" />);

    expect(screen.getByRole("heading", { name: /Lorume/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入控制台" })).toHaveAttribute("href", "/runtime");
    const capabilities = screen.getByRole("region", { name: "当前已实现能力" });
    expect(capabilities).toBeInTheDocument();
    expect(within(capabilities).getByText("Runtime Fleet")).toBeInTheDocument();
    expect(within(capabilities).getByText("Runs")).toBeInTheDocument();
    expect(within(capabilities).getByText("定时任务")).toBeInTheDocument();
    expect(within(capabilities).getByText("Skill 仓库")).toBeInTheDocument();
    expect(within(capabilities).getByText("Agent 看板")).toBeInTheDocument();
    expect(within(capabilities).getByText("组织设置")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Agent Studio/ })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the public home preview scoped to implemented pages", () => {
    window.history.pushState({}, "", "/");

    render(<App runtimeMode="production" />);

    const homeNav = screen.getByRole("navigation", { name: "首页导航" });
    expect(within(homeNav).getByRole("link", { name: "登录" })).toHaveAttribute("href", "/login");
    expect(within(homeNav).queryByRole("link", { name: "Runtime Fleet" })).not.toBeInTheDocument();
    expect(within(homeNav).queryByRole("link", { name: "Runs" })).not.toBeInTheDocument();
    expect(within(homeNav).queryByRole("link", { name: "定时任务" })).not.toBeInTheDocument();
    expect(within(homeNav).queryByRole("link", { name: "Skill 仓库" })).not.toBeInTheDocument();
    expect(within(homeNav).queryByRole("link", { name: "Agent 看板" })).not.toBeInTheDocument();
    expect(within(homeNav).queryByRole("link", { name: "组织设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看 Runtime Fleet" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "当前已实现能力" })).getByRole("link", { name: "打开 Runtime Fleet" })).toHaveAttribute("href", "/runtime");
    expect(within(screen.getByRole("region", { name: "当前已实现能力" })).getByRole("link", { name: "打开 Runs" })).toHaveAttribute("href", "/runs");
    expect(within(screen.getByRole("region", { name: "当前已实现能力" })).getByRole("link", { name: "打开 定时任务" })).toHaveAttribute("href", "/scheduled-tasks");
    expect(within(screen.getByRole("region", { name: "当前已实现能力" })).getByRole("link", { name: "打开 Skill 仓库" })).toHaveAttribute("href", "/skills");
    expect(within(screen.getByRole("region", { name: "当前已实现能力" })).getByRole("link", { name: "打开 Agent 看板" })).toHaveAttribute("href", "/agent-dashboard");
    expect(within(screen.getByRole("region", { name: "当前已实现能力" })).getByRole("link", { name: "打开 组织设置" })).toHaveAttribute("href", "/settings");
    expect(screen.getByText("设备采集")).toBeInTheDocument();
    expect(screen.getByText("异步任务")).toBeInTheDocument();
    expect(screen.queryByText("Operations 与 Notifications 串联异步状态和提醒线程。")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "对象目录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "总控台" })).not.toBeInTheDocument();
  });

  it("uses URL routes for implemented console pages and hides unavailable nav entries", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-fleet")) return jsonResponse(runtimeFleetQueryResponse(fleetSnapshot));
      if (url.includes("/api/runtime-tasks")) return jsonResponse(taskQueryResponse([]));
      if (url.includes("/api/agent-analysis-reports")) return jsonResponse({ reports: [agentAnalysisReportResponse()] });
      if (url.includes("/api/devices/fixture-mac/collection-health")) return jsonResponse(collectionHealthResponse(fleetSnapshot));
      if (url.includes("/api/devices/fixture-mac/diagnostics")) return jsonResponse(deviceDiagnosticsResponse(fleetSnapshot));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    window.history.pushState({}, "", "/runtime");

    render(<App runtimeMode="agent" />);

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Lorume")).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["对象目录", "总控台", "Agent Studio", "Workflow Studio", "Worker Fleet", "People", "Integrations", "Governance"]) {
      expect(within(nav).queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    expect(within(nav).getByRole("button", { name: "Runtime Fleet" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Runs" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "定时任务" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Skill 仓库" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Agent 看板" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "组织设置" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "任务中心" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "通知中心" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开主导航" })).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "切换组织和账号" })).toHaveAttribute("data-sidebar", "menu-button");
    expect(screen.getByText("精选AI")).toBeInTheDocument();
    const workbar = screen.getByRole("banner");
    expect(workbar).toHaveAttribute("data-console-workbar", "true");
    expect(workbar).toHaveClass("border-b", "bg-background/85");
    expect(workbar).not.toHaveClass("bg-muted/30", "px-3", "py-1");
    const workbarSurface = workbar.querySelector("[data-console-workbar-surface='true']");
    expect(workbarSurface).toHaveClass("h-14");
    expect(workbarSurface).not.toHaveClass("rounded-[var(--radius)]", "border", "bg-card/95");
    const operationsButton = screen.getByRole("button", { name: "任务 0" });
    const notificationsButton = screen.getByRole("button", { name: "通知 0" });
    expect(operationsButton).toHaveAttribute("aria-expanded", "false");
    expect(notificationsButton).toHaveAttribute("aria-expanded", "false");

    expect(screen.queryByRole("button", { name: "打开个人入口" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "切换组织和账号" }));
    const workspaceMenu = await screen.findByRole("menu", { name: "切换组织和账号" });
    expect(workspaceMenu).toHaveClass("bg-card", "text-card-foreground");
    expect(workspaceMenu).not.toHaveClass("dark");
    expect(within(workspaceMenu).getByText("Agent")).toBeInTheDocument();
    expect(within(workspaceMenu).getByText("agent@local.lorume")).toBeInTheDocument();
    expect(within(workspaceMenu).getByText("组织")).toBeInTheDocument();
    expect(within(workspaceMenu).getByRole("menuitem", { name: /精选AI/ })).toHaveTextContent("owner");
    expect(within(workspaceMenu).getByRole("menuitem", { name: "创建组织" })).toHaveAttribute("aria-disabled", "true");
    expect(within(workspaceMenu).getByRole("menuitem", { name: "退出登录" })).toHaveClass("text-destructive");
    await user.keyboard("{Escape}");

    await user.click(within(nav).getByRole("button", { name: "Runs" }));

    expect(window.location.pathname).toBe("/runs");
    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(document.querySelector('[data-console-layout-tier="workspace"]')).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "定时任务" }));
    expect(window.location.pathname).toBe("/scheduled-tasks");
    expect(screen.getByRole("heading", { name: "定时任务" })).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Agent 看板" }));
    expect(window.location.pathname).toBe("/agent-dashboard");
    expect(screen.getByRole("heading", { name: "Agent 看板" })).toBeInTheDocument();
    expect(document.querySelector('[data-console-layout-tier="data-dense"]')).toBeInTheDocument();
    expect(await screen.findByText("Queue triage dominated the day.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "用户反馈" })).toBeInTheDocument();
    expect(screen.queryByText("satisfactionScore")).not.toBeInTheDocument();

    await user.click(operationsButton);
    expect(window.location.pathname).toBe("/operations");
    expect(operationsButton).toHaveAttribute("aria-expanded", "true");
    expect(notificationsButton).toHaveAttribute("aria-expanded", "false");
    const operationsDrawer = screen.getByRole("dialog", { name: "Operations" });
    expect(within(operationsDrawer).getByText("本地调试模式不读取远端任务。")).toBeInTheDocument();
    await user.click(within(operationsDrawer).getByRole("button", { name: /关闭|Close/i }));
    expect(window.location.pathname).toBe("/agent-dashboard");
    expect(operationsButton).toHaveAttribute("aria-expanded", "false");

    await user.click(notificationsButton);
    expect(window.location.pathname).toBe("/notifications");
    expect(operationsButton).toHaveAttribute("aria-expanded", "false");
    expect(notificationsButton).toHaveAttribute("aria-expanded", "true");
    const notificationsDrawer = screen.getByRole("dialog", { name: "Notifications" });
    expect(within(notificationsDrawer).getByText("本地调试模式不读取远端通知。")).toBeInTheDocument();
    await user.click(within(notificationsDrawer).getByRole("button", { name: /关闭|Close/i }));
    expect(window.location.pathname).toBe("/agent-dashboard");
    expect(notificationsButton).toHaveAttribute("aria-expanded", "false");

    await user.click(within(nav).getByRole("button", { name: "组织设置" }));
    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("heading", { name: "组织设置" })).toBeInTheDocument();
    expect(screen.getAllByText("精选AI").length).toBeGreaterThan(0);
  });

  it("opens Scheduled Tasks from the protected route and shows execution history", async () => {
    installScheduledTasksFetch();
    window.history.pushState({}, "", "/scheduled-tasks");

    render(<App runtimeMode="agent" />);

    expect(screen.getByRole("heading", { name: "定时任务" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(within(nav).getByRole("button", { name: "定时任务" })).toHaveAttribute("aria-current", "page");

    const scheduledTable = await screen.findByRole("table", { name: "定时任务列表" });
    expect(within(scheduledTable).queryByRole("columnheader", { name: "Runtime / Agent" })).not.toBeInTheDocument();
    expect(within(scheduledTable).queryByRole("columnheader", { name: "最近执行" })).not.toBeInTheDocument();
    expect(within(scheduledTable).queryByRole("columnheader", { name: "执行" })).not.toBeInTheDocument();
    for (const column of ["Runtime", "Agent", "最近状态", "最近时间", "执行次数"]) {
      expect(within(scheduledTable).getByRole("columnheader", { name: column })).toBeInTheDocument();
    }
    expect(within(scheduledTable).getByText("每日数据报告")).toBeInTheDocument();
    expect(within(scheduledTable).getByText("0 8 * * *")).toBeInTheDocument();
    expect(within(scheduledTable).getByText("OpenClaw Gateway")).toBeInTheDocument();
    expect(within(scheduledTable).getAllByText("成功").length).toBeGreaterThan(0);

    const detail = screen.getByRole("complementary", { name: "定时任务详情" });
    expect(within(detail).getByText("执行历史")).toBeInTheDocument();
    expect(await within(detail).findByText("Generate daily report")).toBeInTheDocument();
  });

  it("ignores pure modifier keys when deciding keyboard focus modality", async () => {
    const user = userEvent.setup();
    installRuntimeFleetFetch();
    window.history.pushState({}, "", "/runtime");

    render(<App runtimeMode="agent" />);

    await screen.findByRole("heading", { name: "运行资产" });
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(document.documentElement).toHaveAttribute("data-input-modality", "pointer");

    fireEvent.keyDown(window, { key: "Shift" });
    expect(document.documentElement).toHaveAttribute("data-input-modality", "pointer");

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.documentElement).toHaveAttribute("data-input-modality", "keyboard");

    fireEvent.pointerDown(document.body);
    expect(document.documentElement).toHaveAttribute("data-input-modality", "pointer");
  });

  it("opens the Skill warehouse from URL filters and shows Runtime common Skills for the selected Agent", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    installSkillWarehouseFetch();
    window.history.pushState(
      {},
      "",
      `/skills?runtimeId=${encodeURIComponent(defaultRuntimeId)}&agentId=${encodeURIComponent(defaultAgentId)}`,
    );

    render(<App runtimeMode="agent" />);

    expect(screen.getByRole("heading", { name: "Skill 仓库" })).toBeInTheDocument();
    const skillTable = await screen.findByRole("table", { name: "Skill 列表" });
    expect(within(skillTable).getByRole("columnheader", { name: "最近采集" })).toHaveClass("w-[14%]");
    expect(screen.getByRole("button", { name: /2 个筛选/ })).toBeInTheDocument();
    expect(within(skillTable).getByText("browser")).toBeInTheDocument();
    expect(within(skillTable).getByText("code-review")).toBeInTheDocument();
    expect(within(skillTable).queryByText("other-agent-skill")).not.toBeInTheDocument();
    const detail = screen.getByRole("complementary", { name: "Skill 详情" });
    expect(within(detail).getByText("可用 Agent")).toBeInTheDocument();
    expect(within(detail).getByText("OpenClaw Gateway")).toBeInTheDocument();
    expect(within(detail).queryByText("OpenClaw · OpenClaw Gateway")).not.toBeInTheDocument();
    expect(within(detail).queryByText("同名 Skill")).not.toBeInTheDocument();
    expect(screen.getAllByText("main").length).toBeGreaterThan(0);

    await user.click(within(detail).getByRole("button", { name: "查看 browser 详情" }));
    const fullDetail = await screen.findByRole("dialog", { name: "browser" });
    expect(within(fullDetail).getByText("本地路径")).toBeInTheDocument();
    expect(within(fullDetail).getByText("~/.codex/skills/.system/browser/SKILL.md")).toBeInTheDocument();
    expect(within(fullDetail).getByText("Skill 正文")).toBeInTheDocument();
    expect(within(fullDetail).getByText(/Use browser automation for screenshots and inspection/)).toBeInTheDocument();
    expect(within(fullDetail).queryByText("基础信息")).not.toBeInTheDocument();
    expect(within(fullDetail).queryByText("可用 Agent")).not.toBeInTheDocument();
    expect(within(fullDetail).queryByText(/^复制$/)).not.toBeInTheDocument();
    const pathCopyButton = within(fullDetail).getByRole("button", { name: "复制本地路径" });
    const bodyCopyButton = within(fullDetail).getByRole("button", { name: "复制 Skill 正文" });
    const skillBody = within(fullDetail).getByText(/Use browser automation for screenshots and inspection/).closest("pre");
    expect(skillBody).toHaveClass("overflow-auto", "pb-6");
    expect(skillBody?.parentElement).toHaveClass("min-h-0", "flex-1", "overflow-hidden");

    await user.click(pathCopyButton);
    expect(writeText).toHaveBeenCalledWith("~/.codex/skills/.system/browser/SKILL.md");
    expect(await screen.findByText("已复制")).toBeInTheDocument();

    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await user.click(bodyCopyButton);
    expect(writeText).toHaveBeenCalledWith("# Browser\n\nUse browser automation for screenshots and inspection.");
    expect(await screen.findByText("复制失败")).toBeInTheDocument();
  });

  it("deep-links Runtime Fleet Skill actions into the Skill warehouse", async () => {
    const user = userEvent.setup();
    installSkillWarehouseFetch();
    window.history.pushState({}, "", "/runtime");

    render(<App runtimeMode="agent" />);

    const runtimeTable = screen.getByRole("table", { name: "Runtime 列表" });
    const runtimeRow = within(runtimeTable).getByRole("row", { name: /OpenClaw Gateway/ });
    await user.click(within(runtimeRow).getByRole("button", { name: "查看 Skill" }));

    expect(window.location.pathname).toBe("/skills");
    expect(window.location.search).toContain(`runtimeId=${encodeURIComponent(defaultRuntimeId)}`);
    expect(await screen.findByRole("table", { name: "Skill 列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 个筛选/ })).toBeInTheDocument();
  });

  it("deep-links Runtime Fleet Agent actions into the Agent dashboard", async () => {
    const user = userEvent.setup();
    installAgentDashboardFetch();
    window.history.pushState({}, "", "/runtime");

    render(<App runtimeMode="agent" />);

    const agentTable = await screen.findByRole("table", { name: "Agent 列表" });
    const agentRow = within(agentTable).getByRole("row", { name: /main/ });
    await user.click(within(agentRow).getByRole("button", { name: "查看看板" }));

    expect(window.location.pathname).toBe("/agent-dashboard");
    expect(window.location.search).toContain(`agentId=${encodeURIComponent(defaultAgentId)}`);
    expect(screen.getByRole("heading", { name: "Agent 看板" })).toBeInTheDocument();
    expect(await screen.findByText("Queue triage dominated the day.")).toBeInTheDocument();
  });

  it("defaults unknown Console routes to Runtime Fleet", () => {
    window.history.pushState({}, "", "/unknown");

    render(<App runtimeMode="agent" />);

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
  });

  it("defaults the Console to Runtime Fleet when no protected page route is provided", () => {
    render(<App runtimeMode="agent" />);

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
  });

  it("opens Runs task board with task context and no adapter debug text", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks")) return jsonResponse({ error: "backend_unavailable" }, 503);
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));

    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    for (const lane of ["待处理", "进行中", "待验收", "已完成", "需关注"]) {
      expect(screen.getByRole("heading", { name: lane })).toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "已取消" })).not.toBeInTheDocument();
    for (const removedLane of ["阻塞", "失败", "未知"]) {
      expect(screen.queryByRole("heading", { name: removedLane })).not.toBeInTheDocument();
    }
    expect(screen.queryByText("查看 Agent 承接的会话任务、发起人、Channel、会话/群组、消息摘要和当前状态。")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("任务概览")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "状态" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "日期范围" })).toHaveTextContent("选择日期范围");
    await user.click(screen.getByRole("button", { name: "筛选" }));
    const filterMenu = screen.getByRole("menu", { name: "筛选" });
    expect(filterMenu).toHaveClass("bg-card", "text-card-foreground");
    const channelSubTrigger = within(filterMenu).getByRole("menuitem", { name: /渠道/ });
    expect(channelSubTrigger).toHaveAttribute("aria-haspopup", "menu");
    await user.hover(channelSubTrigger);
    channelSubTrigger.focus();
    await user.keyboard("{ArrowRight}");
    const channelMenu = await screen.findByRole("menu", { name: /渠道/ });
    const allChannelsItem = within(channelMenu).getByRole("menuitemcheckbox", { name: "全部" });
    expect(allChannelsItem).toHaveAttribute("aria-checked", "true");
    const dingtalkItem = within(channelMenu).getByRole("menuitemcheckbox", { name: /DingTalk/ });
    expect(dingtalkItem).toBeInTheDocument();
    expect(dingtalkItem).toHaveClass("[&_[data-slot=dropdown-menu-checkbox-item-indicator]]:border-border");
    await user.keyboard("{Escape}");

    await user.type(screen.getByPlaceholderText("搜索任务、消息、发起人、Agent 或会话/群组"), "PMO");

    const taskCard = screen.getByRole("button", { name: /PMO asked OpenClaw/ });
    expect(within(taskCard).queryByText("待处理")).not.toBeInTheDocument();
    expect(within(taskCard).getByText("DingTalk").closest("[data-pill-kind]")).toHaveAttribute("data-pill-kind", "channel");
    expect(within(taskCard).queryByText("DingTalk 群聊")).not.toBeInTheDocument();
    expect(within(taskCard).getByTestId("runtime-task-card-assignee")).toHaveTextContent("main");
    expect(within(taskCard).getByTestId("runtime-task-card-title")).toHaveTextContent("PMO asked OpenCl...");
    expect(within(taskCard).getByTestId("runtime-task-card-reply")).toHaveTextContent("The handoff is ready for review.");
    expect(within(taskCard).getByTestId("runtime-task-card-footer")).toHaveTextContent("2026/05/21 17:59:00");
    expect(within(taskCard).queryByText("未关联执行")).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw execution/)).not.toBeInTheDocument();
    expect(screen.queryByText("直接证据")).not.toBeInTheDocument();
    expect(screen.queryByText("能力缺口")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("来源 Runtime")).not.toBeInTheDocument();

    await user.click(taskCard);
    expect(taskCard).toHaveAttribute("data-state", "idle");
    expect(taskCard).toHaveAttribute("aria-pressed", "false");

    const detail = screen.getByRole("dialog", { name: "PMO asked OpenClaw to in..." });
    expect(within(detail).getByRole("heading", { name: "PMO asked OpenClaw to in..." })).toBeInTheDocument();
    expect(within(detail).getByText("任务信息")).toBeInTheDocument();
    expect(within(detail).getByText("发起人")).toBeInTheDocument();
    expect(within(detail).getByText("PMO")).toBeInTheDocument();
    expect(within(detail).getByText("承接 Agent")).toBeInTheDocument();
    expect(within(detail).getByText("main")).toBeInTheDocument();
    expect(within(detail).getByText("更新时间")).toBeInTheDocument();
    expect(within(detail).getByText("渠道")).toBeInTheDocument();
    expect(within(detail).getByText("DingTalk 群聊")).toBeInTheDocument();
    expect(within(detail).getByText("用户消息")).toBeInTheDocument();
    expect(within(detail).getByText("Agent 回复")).toBeInTheDocument();
    expect(within(detail).queryByText("会话/群组")).not.toBeInTheDocument();
    expect(within(detail).queryByText("任务状态")).not.toBeInTheDocument();
    expect(within(detail).queryByText("执行关联")).not.toBeInTheDocument();
    expect(within(detail).queryByText("未关联执行")).not.toBeInTheDocument();
    expect(within(detail).queryByText("采集来源")).not.toBeInTheDocument();
  });

  it("keeps task details readable when Agent reply is missing", async () => {
    const user = userEvent.setup();
    const tasks = [
      task({
        assignee: { name: "main" },
        channel: { kind: "dingtalk" },
        conversation: { title: "DingTalk 群聊", externalId: rawDingTalkCid },
        creator: { name: "PMO" },
        id: "task-no-execution",
        status: "in_progress",
        updatedAt: "2026-05-21T08:00:00.000Z",
        userMessage: "Task without execution record",
      }),
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks")) return jsonResponse(taskQueryResponse(tasks));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    await user.click(await screen.findByRole("button", { name: /Task without execution record/ }));

    const detail = screen.getByRole("dialog");
    expect(within(detail).getByTestId("runtime-task-detail-agent-reply")).toHaveTextContent("暂无 Agent 答复");
    expect(within(detail).queryByText("执行关联")).not.toBeInTheDocument();
    expect(within(detail).queryByText("未关联执行")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(rawDingTalkCid);
  });

  it("selects Runs task cards with keyboard activation", async () => {
    const user = userEvent.setup();
    const tasks = [
      task({
        assignee: { name: "main" },
        id: "keyboard-first-task",
        status: "todo",
        updatedAt: "2026-05-21T08:00:00.000Z",
        userMessage: "Keyboard first task",
      }),
      task({
        assignee: { name: "main" },
        id: "keyboard-second-task",
        status: "in_progress",
        updatedAt: "2026-05-21T08:01:00.000Z",
        userMessage: "Keyboard second task",
      }),
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks")) return jsonResponse(taskQueryResponse(tasks));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    const secondCard = await screen.findByRole("button", { name: /Keyboard second task/ });

    secondCard.focus();
    await user.keyboard("{Enter}");

    const detail = screen.getByRole("dialog", { name: "Keyboard second task" });
    expect(within(detail).getByRole("heading", { name: "Keyboard second task" })).toBeInTheDocument();
  });

  it("keeps long Runs detail titles constrained while preserving the full user message", async () => {
    const user = userEvent.setup();
    const longTitle = "使用Aetheris CLI帮我查询数据1、数据连接是：http://s-fat.dancf.com/4hzk 2、查询日期为多个周期内的数据并返回报告";
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks")) {
        return jsonResponse(taskQueryResponse([
          task({
            assignee: { name: "main" },
            creator: { name: "zhaoyang" },
            id: "fixture-long-title",
            status: "review",
            updatedAt: "2026-05-21T08:00:00.000Z",
            userMessage: longTitle,
          }),
        ]));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    await user.click(await screen.findByRole("button", { name: new RegExp(longTitle.slice(0, 12)) }));

    const detail = screen.getByRole("dialog");
    const title = within(detail).getByRole("heading", { name: new RegExp(longTitle.slice(0, 12)) });
    expect(title).toBeInTheDocument();
    expect(within(detail).getByTestId("runtime-task-detail-title")).toHaveAttribute("title", longTitle);
  });

  it("does not turn adapter diagnostics into Runs cards", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks")) return jsonResponse(taskQueryResponse([]));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(await screen.findByRole("heading", { name: "待处理" })).toBeInTheDocument();

    expect(screen.queryByText("Slock 监听未就绪")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw 执行监听已接入")).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw execution/)).not.toBeInTheDocument();
    expect(screen.queryByText("直接证据")).not.toBeInTheDocument();
    expect(screen.queryByText("能力缺口")).not.toBeInTheDocument();
  });

  it("loads additional Runs pages from the backend cursor", async () => {
    const user = userEvent.setup();
    const firstPage = [
      task({
        assignee: { name: "main" },
        creator: { name: "PMO" },
        id: "task-page-1",
        status: "in_progress",
        updatedAt: "2026-05-21T08:00:00.000Z",
        userMessage: "First backend task",
      }),
    ];
    const secondPage = [
      task({
        assignee: { name: "main" },
        creator: { name: "PMO" },
        id: "task-page-2",
        status: "in_progress",
        updatedAt: "2026-05-21T07:59:00.000Z",
        userMessage: "Second backend task",
      }),
    ];
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.includes("/api/runtime-tasks") && !url.includes("cursor=cursor-1")) {
        return jsonResponse(taskQueryResponse(firstPage, "cursor-1", 2));
      }
      if (url.includes("/api/runtime-tasks") && url.includes("cursor=cursor-1")) {
        return jsonResponse(taskQueryResponse(secondPage, undefined, 2));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));

    expect(await screen.findByRole("button", { name: /First backend task/ })).toBeInTheDocument();
    expect(screen.getByText("已显示 1 / 2")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "进行中泳道" })).getByRole("button", { name: "加载更多" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加载更多" }));

    expect(await screen.findByRole("button", { name: /Second backend task/ })).toBeInTheDocument();
    expect(screen.getByText("已显示 2 / 2")).toBeInTheDocument();
    expect(requests.some((url) => url.includes("cursor=cursor-1"))).toBe(true);
  });

  it("hides stale Runs pagination when filters change before the next query returns", async () => {
    const user = userEvent.setup();
    const initialTasks = [
      task({
        id: "initial-todo-task",
        status: "todo",
        updatedAt: "2026-05-21T08:00:00.000Z",
        userMessage: "Initial todo task",
      }),
      task({
        id: "initial-running-task",
        status: "in_progress",
        updatedAt: "2026-05-21T08:00:00.000Z",
        userMessage: "Initial running task",
      }),
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks") && url.includes("search=Initial+running")) {
        return jsonResponse(taskQueryResponse([initialTasks[1]], undefined, 1));
      }
      if (url.includes("/api/runtime-tasks")) {
        return jsonResponse(taskQueryResponse(initialTasks, "stale-cursor", 3));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    await screen.findAllByRole("button", { name: "加载更多" });

    await user.type(screen.getByPlaceholderText("搜索任务、消息、发起人、Agent 或会话/群组"), "Initial running");

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    });
    expect(screen.getByText("已显示 1 / 1")).toBeInTheDocument();
  });

  it("loads Runs from the backend task query API when available", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks")) {
        return jsonResponse(taskQueryResponse([
          task({
            assignee: { name: "main" },
            channel: { kind: "dingtalk" },
            conversation: { title: "DingTalk 群聊" },
            creator: { name: "PMO" },
            id: "task-query-1",
            status: "in_progress",
            updatedAt: "2026-05-21T10:00:00.000Z",
            userMessage: "AGTD-001 Fix queue handoff. PMO asked OpenClaw to inspect queue handoff.",
          }),
        ]));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="agent" />);
    await user.click(screen.getByRole("button", { name: "Runs" }));

    expect(await screen.findByRole("button", { name: /AGTD-001 Fix queue handoff/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /PMO asked OpenClaw/ })).toBeInTheDocument();
  });

  it("keeps current Runs filters when automatic refresh reloads backend query data", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const allTasks = [
      task({
        id: "fixture-todo-task",
        status: "todo",
        updatedAt: "2026-05-21T08:00:00.000Z",
        userMessage: "Unfiltered todo task",
      }),
      task({
        id: "fixture-running-task",
        status: "in_progress",
        updatedAt: "2026-05-21T08:00:00.000Z",
        userMessage: "Filtered running task",
      }),
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.includes("/api/runtime-tasks") && url.includes("search=Filtered+running")) {
        return jsonResponse(taskQueryResponse([allTasks[1]]));
      }
      if (url.includes("/api/runtime-tasks")) return jsonResponse(taskQueryResponse(allTasks));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /Unfiltered todo task/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("搜索任务、消息、发起人、Agent 或会话/群组"), {
      target: { value: "Filtered running" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /Unfiltered todo task/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filtered running task/ })).toBeInTheDocument();

    requests.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });

    expect(requests.at(-1)).toContain("search=Filtered+running");
  });

  it("filters Runs cards by date range without quick-range state", async () => {
    const user = userEvent.setup();
    const selectedDate = new Date();
    selectedDate.setHours(12, 0, 0, 0);
    const olderDate = new Date(selectedDate);
    olderDate.setDate(selectedDate.getDate() - 1);
    const selectedDateLabel = `${selectedDate.getFullYear()}/${String(selectedDate.getMonth() + 1).padStart(2, "0")}/${String(selectedDate.getDate()).padStart(2, "0")}`;
    const tasks = [
      task({
        id: "fixture-old-task",
        status: "done",
        updatedAt: olderDate.toISOString(),
        userMessage: "Old task",
      }),
      task({
        id: "fixture-new-task",
        status: "done",
        updatedAt: selectedDate.toISOString(),
        userMessage: "New task",
      }),
    ];
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-tasks")) return jsonResponse(taskQueryResponse(tasks));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(await screen.findByRole("button", { name: /Old task/ })).toBeInTheDocument();
    const lanes = screen.getByLabelText("任务泳道");
    expect(within(lanes).getAllByText("Old task").length).toBeGreaterThan(0);
    expect(within(lanes).getAllByText("New task").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "日期范围" })).toHaveTextContent("选择日期范围");
    expect(screen.queryByLabelText("开始时间")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("结束时间")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除时间" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "日期范围" }));
    const targetDay = document.querySelector<HTMLElement>(`button[data-day="${selectedDate.toLocaleDateString()}"]`);
    if (!targetDay) throw new Error("expected selected date range cell");
    await user.click(targetDay);

    await waitFor(() => {
      expect(within(lanes).queryByText("Old task")).not.toBeInTheDocument();
    });
    expect(within(lanes).getAllByText("New task").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "日期范围" })).toHaveTextContent(selectedDateLabel);
  });

  it("opens Runtime Fleet and renders runtime fixture data", async () => {
    const user = userEvent.setup();
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("设备")).getByText("fixture-mac")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Runtime 列表" })).getByText("OpenClaw Gateway")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Agent 列表" })).getByText("main")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Runtime 列表" })).queryByRole("columnheader", { name: "Runtime" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "所属设备" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "归属 Runtime" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: "最近活跃" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByLabelText("运行资产筛选")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜索设备、Runtime、Agent 或任务")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Runtime")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("同步时间")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("可用性")).not.toBeInTheDocument();
  });

  it("keeps Runtime Fleet body compact after counts move into the workbar", async () => {
    const user = userEvent.setup();
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect(screen.queryByLabelText("运行资产概览")).not.toBeInTheDocument();
    expect(screen.queryByText(/台已注册设备/)).not.toBeInTheDocument();
    expect(screen.queryByText(/个已采集 Runtime/)).not.toBeInTheDocument();
    expect(screen.queryByText(/个已采集 Agent/)).not.toBeInTheDocument();

    const runtimeTable = screen.getByRole("table", { name: "Runtime 列表" });
    expect(within(runtimeTable).queryByText("OpenClaw")).not.toBeInTheDocument();
    const runtimeSkillHeader = within(runtimeTable).getByRole("columnheader", { name: "Skill 操作" });
    const runtimeSkillCell = within(runtimeTable).getAllByRole("button", { name: "查看 Skill" })[0].closest("td");
    expect(runtimeSkillHeader).toHaveClass("w-[10%]");
    expect(runtimeSkillHeader).not.toHaveClass("text-right");
    expect(runtimeSkillCell).toHaveClass("whitespace-nowrap");
    expect(runtimeSkillCell).not.toHaveClass("text-right");

    const agentTable = screen.getByRole("table", { name: "Agent 列表" });
    const taskHeader = within(agentTable).getByRole("columnheader", { name: "Task" });
    const activeHeader = within(agentTable).getByRole("columnheader", { name: "最近活跃" });
    const actionHeader = within(agentTable).getByRole("columnheader", { name: "操作" });
    const actionCell = within(agentTable).getAllByRole("button", { name: "查看看板" })[0].closest("td");
    expect(taskHeader).toHaveClass("w-[8%]");
    expect(activeHeader).toHaveClass("w-[15%]");
    expect(actionHeader).toHaveClass("w-[20%]");
    expect(actionHeader).not.toHaveClass("text-right");
    expect(actionCell).toHaveTextContent("查看看板");
    expect(actionCell).toHaveTextContent("查看 Skill");
    expect(actionCell).not.toHaveClass("text-right");
  });

  it("loads Runtime Fleet from the backend query API when available", async () => {
    const user = userEvent.setup();
    installRuntimeFleetFetch();

    render(<App runtimeMode="agent" />);
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect((await screen.findAllByText("fixture-mac")).length).toBeGreaterThan(0);
    expect(screen.queryByText("查看设备、Runtime、Agent 的采集状态、归属关系和最近活动。")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("采集健康")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("运行资产概览")).not.toBeInTheDocument();
    expect(screen.queryByText("异常")).not.toBeInTheDocument();
    expect(screen.queryByText("未知")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "请求设备刷新" })).not.toBeInTheDocument();
  });

  it("renders Device status from diagnostics without using Runtime or Agent state", async () => {
    const user = userEvent.setup();
    const snapshot = fleetWithStatus("error", "error");
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-fleet")) return jsonResponse(runtimeFleetQueryResponse(snapshot));
      if (url.includes("/api/devices/fixture-mac/collection-health")) return jsonResponse(collectionHealthResponse(snapshot));
      if (url.includes("/api/devices/fixture-mac/diagnostics")) {
        return jsonResponse(deviceDiagnosticsResponse(snapshot, "online", "在线"));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;

    render(<App runtimeMode="agent" />);
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    const devicePanel = await screen.findByLabelText("设备");
    expect(within(devicePanel).getByText("在线")).toBeInTheDocument();

    await user.click(within(devicePanel).getByRole("button", { name: /fixture-mac/ }));

    expect(within(screen.getByLabelText("运行资产详情")).getByText("状态: 在线")).toBeInTheDocument();
  });

  it("shows Runtime and Agent collection status without deriving working or idle from tasks", async () => {
    const user = userEvent.setup();
    const snapshot = fleetWithStatus("offline", "error");
    installRuntimeFleetFetch(snapshot);

    render(<App runtimeMode="agent" />);
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    const runtimeTable = await screen.findByRole("table", { name: "Runtime 列表" });
    const runtimeRow = within(runtimeTable).getByRole("row", { name: /OpenClaw Gateway/ });
    expect(within(runtimeRow).getByText("离线")).toBeInTheDocument();
    expect(within(runtimeRow).queryByText("工作中")).not.toBeInTheDocument();

    await user.click(runtimeRow);
    const runtimeDetail = screen.getByRole("complementary", { name: "运行资产详情" });
    expect(within(runtimeDetail).getByText("状态: 离线")).toBeInTheDocument();
    expect(within(runtimeDetail).getByText("全部任务: 2")).toBeInTheDocument();
    expect(within(runtimeDetail).getByText("待处理: 1")).toBeInTheDocument();
    expect(within(runtimeDetail).getByText("进行中: 1")).toBeInTheDocument();

    const agentTable = screen.getByRole("table", { name: "Agent 列表" });
    const agentRow = within(agentTable).getByRole("row", { name: /main/ });
    expect(within(agentRow).getByText("异常")).toBeInTheDocument();
    expect(within(agentRow).queryByText("工作中")).not.toBeInTheDocument();
  });

  it("shows omitted historical Agents as invisible instead of offline", async () => {
    const snapshot = fleetWithStatus("online", "invisible");
    installRuntimeFleetFetch(snapshot);

    render(<App runtimeMode="agent" />);
    await userEvent.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    const agentTable = await screen.findByRole("table", { name: "Agent 列表" });
    const agentRow = within(agentTable).getByRole("row", { name: /main/ });
    expect(within(agentRow).getByText("不可见")).toBeInTheDocument();
    expect(within(agentRow).queryByText("离线")).not.toBeInTheDocument();
    expect(within(agentRow).getByRole("button", { name: "查看 Skill" })).toBeDisabled();

    await userEvent.hover(within(agentRow).getByLabelText(/不可见：/));
    expect((await screen.findAllByText("该 Agent 曾被采集到，但最新全量采集中未再出现。可能已被删除、停用，或已移出当前采集范围。")).length).toBeGreaterThan(0);
  });

  it("opens Runtime Fleet agent details without a filter toolbar", async () => {
    const user = userEvent.setup();
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(screen.queryByLabelText("运行资产筛选")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("搜索设备、Runtime、Agent 或任务")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();

    const agentTable = screen.getByRole("table", { name: "Agent 列表" });
    expect(within(agentTable).getByText("main")).toBeInTheDocument();

    await user.click(screen.getByRole("row", { name: /main/ }));

    const detail = screen.getByRole("complementary", { name: "运行资产详情" });
    expect(within(detail).getByRole("heading", { name: "main" })).toBeInTheDocument();
    expect(within(detail).getByText("归属关系")).toBeInTheDocument();
    expect(within(detail).getByText("所属 Runtime: OpenClaw Gateway")).toBeInTheDocument();
    expect(within(detail).getByText("所属设备: fixture-mac")).toBeInTheDocument();
    expect(within(detail).getByText("任务统计")).toBeInTheDocument();
    expect(within(detail).getByText("全部任务: 2")).toBeInTheDocument();
    expect(within(detail).queryByText("关联渠道")).not.toBeInTheDocument();
    expect(within(detail).queryByText("origin")).not.toBeInTheDocument();
    expect(within(detail).queryByText("sourceRefs")).not.toBeInTheDocument();
    expect(within(detail).queryByText("load")).not.toBeInTheDocument();
  });

  it("copies Runtime Fleet object ids without rendering long Lorume IDs in details", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(globalThis.navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    await user.click(screen.getByRole("row", { name: /main/ }));

    const detail = screen.getByRole("complementary", { name: "运行资产详情" });
    expect(within(detail).queryByText(/Lorume ID:/)).not.toBeInTheDocument();

    await user.click(within(detail).getByRole("button", { name: "复制 ID" }));

    expect(within(detail).queryByText("已复制")).not.toBeInTheDocument();
    expect(await screen.findByText("已复制")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("fixture-mac:runtime:openclaw:agent:main");
  });

  it("automatically refreshes Runtime Fleet query data while mounted", async () => {
    vi.useFakeTimers();
    let latestRequests = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-fleet")) {
        latestRequests += 1;
        const snapshot: RuntimeFleetSnapshot = {
          ...fleetSnapshot,
          devices: fleetSnapshot.devices.map((device) => ({
            ...device,
            lastSeenAt: `2026-05-21T08:00:0${latestRequests}.000Z`,
          })),
          collectedAt: `2026-05-21T08:00:0${latestRequests}.000Z`,
        };
        return jsonResponse(runtimeFleetQueryResponse(snapshot));
      }
      if (url.includes("/api/devices/fixture-mac/collection-health")) return jsonResponse(collectionHealthResponse(fleetSnapshot));
      if (url.includes("/api/devices/fixture-mac/diagnostics")) return jsonResponse(deviceDiagnosticsResponse(fleetSnapshot));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    fireEvent.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("fixture-mac").length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });

    expect(screen.getAllByText("fixture-mac").length).toBeGreaterThan(0);
    expect(latestRequests).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/更新/)).toBeInTheDocument();
  });
});
