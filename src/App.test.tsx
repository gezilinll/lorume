import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fleetFixture from "../fixtures/runtime/runtime-fleet-device-state.sample.json";
import { App } from "./App";
import type { RuntimeFleetSnapshot } from "./runtime/runtime-fleet-query";
import type { CollectionStatus, Task } from "./runtime/runtime-model";

const originalFetch = globalThis.fetch;
const originalPath = window.location.pathname;
const fleetSnapshot = fleetFixture as RuntimeFleetSnapshot;
const defaultAgentId = fleetSnapshot.agents[0].id;

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
    tasks: snapshot.tasks,
    summary: {
      agentCount: snapshot.agents.length,
      deviceCount: snapshot.devices.length,
      runtimeCount: snapshot.runtimes.length,
      taskCount: snapshot.tasks.length,
    },
  };
}

function taskQueryResponse(tasks: unknown[], nextCursor?: string, total = tasks.length) {
  return {
    items: tasks,
    total,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function collectionHealthResponse(snapshot: RuntimeFleetSnapshot) {
  return {
    checks: [
      {
        counts: {
          agents: snapshot.agents.length,
          devices: snapshot.devices.length,
          runtimes: snapshot.runtimes.length,
          tasks: snapshot.tasks.length,
        },
        error: null,
        id: "device_state",
        label: "设备状态",
        lastCollectedAt: snapshot.collectedAt,
        lastReceivedAt: snapshot.collectedAt,
        message: "采集正常",
        status: "healthy",
        warnings: [],
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
    message: "设备在线且采集正常",
    reason: "heartbeat_and_device_state_fresh",
    status,
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
    status: "todo",
    taskType: "conversation",
    ...overrides,
  };
}

function fleetWithStatus(runtimeStatus: CollectionStatus, agentStatus: CollectionStatus): RuntimeFleetSnapshot {
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
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/collection-health`)) {
      return jsonResponse(collectionHealthResponse(snapshot));
    }
    if (url.includes(`/api/devices/${snapshot.devices[0].id}/diagnostics`)) {
      return jsonResponse(deviceDiagnosticsResponse(snapshot));
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;
}

describe("Console shell", () => {
  it("renders a public home entry at the root without probing auth", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    window.history.pushState({}, "", "/");

    render(<App runtimeMode="production" />);

    expect(screen.getByRole("heading", { name: /把分散的 Agent 变成可运营的工作网络/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "登录" })).toHaveAttribute("href", "/login");
    expect(screen.queryByTestId("home-pixel-decorations")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "运营总览" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent 网络结构预览" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agent Studio" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the public home preview scoped to implemented pages", () => {
    window.history.pushState({}, "", "/");

    render(<App runtimeMode="production" />);

    const previewNav = screen.getByRole("navigation", { name: "预览导航" });
    expect(within(previewNav).getByText("Runtime")).toBeInTheDocument();
    expect(within(previewNav).getByText("Runs")).toBeInTheDocument();
    expect(within(previewNav).getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("运行资产层")).toBeInTheDocument();
    expect(screen.getByText("工作状态层")).toBeInTheDocument();
    expect(within(previewNav).queryByText("对象目录")).not.toBeInTheDocument();
    expect(within(previewNav).queryByText("总览")).not.toBeInTheDocument();
  });

  it("uses URL routes for implemented console pages and hides unavailable nav entries", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/runtime-fleet")) return jsonResponse(runtimeFleetQueryResponse(fleetSnapshot));
      if (url.includes("/api/runtime-tasks")) return jsonResponse(taskQueryResponse([]));
      if (url.includes("/api/devices/fixture-mac/collection-health")) return jsonResponse(collectionHealthResponse(fleetSnapshot));
      if (url.includes("/api/devices/fixture-mac/diagnostics")) return jsonResponse(deviceDiagnosticsResponse(fleetSnapshot));
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    window.history.pushState({}, "", "/runtime");

    render(<App runtimeMode="agent" />);

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "主导航" });
    for (const label of ["对象目录", "总控台", "Agent Studio", "Workflow Studio", "Worker Fleet", "People", "Integrations", "Governance"]) {
      expect(within(nav).queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    expect(within(nav).getByRole("button", { name: "Runtime Fleet" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Runs" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "组织设置" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "任务中心" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "通知中心" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "任务 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通知 0" })).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Runs" }));

    expect(window.location.pathname).toBe("/runs");
    expect(screen.getByRole("heading", { name: "工作看板" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "任务 0" }));
    expect(window.location.pathname).toBe("/operations");
    const operationsDrawer = screen.getByRole("dialog", { name: "任务" });
    expect(within(operationsDrawer).getByText("本地调试模式不读取远端任务。")).toBeInTheDocument();
    await user.click(within(operationsDrawer).getByRole("button", { name: "关闭任务" }));
    expect(window.location.pathname).toBe("/runs");

    await user.click(screen.getByRole("button", { name: "通知 0" }));
    expect(window.location.pathname).toBe("/notifications");
    const notificationsDrawer = screen.getByRole("dialog", { name: "通知" });
    expect(within(notificationsDrawer).getByText("本地调试模式不读取远端通知。")).toBeInTheDocument();
    await user.click(within(notificationsDrawer).getByRole("button", { name: "关闭通知" }));
    expect(window.location.pathname).toBe("/runs");

    await user.click(within(nav).getByRole("button", { name: "组织设置" }));
    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("heading", { name: "组织设置" })).toBeInTheDocument();
    expect(screen.getAllByText("精选AI").length).toBeGreaterThan(0);
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

    expect(screen.getByRole("heading", { name: "工作看板" })).toBeInTheDocument();
    for (const lane of ["待处理", "进行中", "待验收", "已完成", "阻塞", "失败", "已取消", "未知"]) {
      expect(screen.getByRole("heading", { name: lane })).toBeInTheDocument();
    }
    expect(await screen.findByText("统一查看 Agent 承接的任务、发起人、Channel、会话/群组、消息摘要和当前状态。")).toBeInTheDocument();
    const channelSelect = screen.getByLabelText("渠道") as HTMLSelectElement;
    expect(channelSelect.value).toBe("all");
    expect(within(channelSelect).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "全部",
      "DingTalk",
    ]);

    await user.type(screen.getByPlaceholderText("搜索任务、消息、发起人、Agent 或会话/群组"), "PMO");

    const taskCard = screen.getByRole("button", { name: /PMO asked OpenClaw/ });
    expect(within(taskCard).getByText("待处理")).toBeInTheDocument();
    expect(screen.getAllByText(/PMO/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/main/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/DingTalk 群聊/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/OpenClaw execution/)).not.toBeInTheDocument();
    expect(screen.queryByText("直接证据")).not.toBeInTheDocument();
    expect(screen.queryByText("能力缺口")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("来源 Runtime")).not.toBeInTheDocument();

    await user.click(taskCard);

    const detail = screen.getByRole("complementary", { name: "任务详情" });
    expect(within(detail).getByRole("heading", { name: /PMO asked OpenClaw/ })).toBeInTheDocument();
    expect(within(detail).getByText("Channel: DingTalk")).toBeInTheDocument();
    expect(within(detail).getByText("发起人: PMO")).toBeInTheDocument();
    expect(within(detail).getByText("承接 Agent: main")).toBeInTheDocument();
    expect(within(detail).getByText("会话/群组: DingTalk 群聊")).toBeInTheDocument();
    expect(within(detail).getByText("任务状态: 待处理")).toBeInTheDocument();
    expect(within(detail).queryByText(/来源 Runtime:/)).not.toBeInTheDocument();
    expect(within(detail).queryByText(/执行状态:/)).not.toBeInTheDocument();
  });

  it("keeps task details readable when no execution record exists", async () => {
    const user = userEvent.setup();
    const tasks = [
      task({
        assignee: { name: "main" },
        channel: { kind: "dingtalk", name: "DingTalk 群聊" },
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

    const detail = screen.getByRole("complementary", { name: "任务详情" });
    expect(within(detail).getByText("任务状态: 进行中")).toBeInTheDocument();
    expect(within(detail).queryByText(/执行状态:/)).not.toBeInTheDocument();
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

    const detail = screen.getByRole("complementary", { name: "任务详情" });
    const title = within(detail).getByRole("heading", { name: new RegExp(longTitle.slice(0, 12)) });
    expect(title).toHaveClass("detailTitle");
    expect(title).toHaveAttribute("title", longTitle);
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
    expect(await screen.findByText("统一查看 Agent 承接的任务、发起人、Channel、会话/群组、消息摘要和当前状态。")).toBeInTheDocument();

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
        status: "todo",
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
    expect(screen.getByRole("button", { name: "加载更多" }).closest(".boardResultMeta")).not.toBeNull();
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
      if (url.includes("/api/runtime-tasks") && url.includes("status=in_progress")) {
        return jsonResponse(taskQueryResponse([initialTasks[1]], undefined, 1));
      }
      if (url.includes("/api/runtime-tasks")) {
        return jsonResponse(taskQueryResponse(initialTasks, "stale-cursor", 3));
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    }) as unknown as typeof fetch;
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(await screen.findByRole("button", { name: "加载更多" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("状态"), "in_progress");

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
            channel: { kind: "dingtalk", name: "DingTalk 群聊" },
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
    expect(screen.getAllByText(/PMO asked OpenClaw/).length).toBeGreaterThan(0);
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
      if (url.includes("/api/runtime-tasks") && url.includes("status=in_progress")) {
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

    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "in_progress" } });
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

    expect(requests.at(-1)).toContain("status=in_progress");
  });

  it("filters Runs cards by manual time range without quick-range state", async () => {
    const user = userEvent.setup();
    const tasks = [
      task({
        id: "fixture-old-task",
        status: "done",
        updatedAt: "2026-05-20T10:00:00.000Z",
        userMessage: "Old task",
      }),
      task({
        id: "fixture-new-task",
        status: "done",
        updatedAt: "2026-05-21T12:00:00.000Z",
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
    expect(screen.getByLabelText("开始时间")).toBeInTheDocument();
    expect(screen.getByLabelText("结束时间")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /选择时间范围/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除时间" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-05-21T00:00:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-05-21T23:59:59" } });

    await waitFor(() => {
      expect(within(lanes).queryByText("Old task")).not.toBeInTheDocument();
    });
    expect(within(lanes).getAllByText("New task").length).toBeGreaterThan(0);
  });

  it("opens Runtime Fleet and renders the OpenClaw-first fixture data", async () => {
    const user = userEvent.setup();
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("设备")).getByText("fixture-mac")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Runtime 列表" })).getByText("OpenClaw Gateway")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Agent 列表" })).getByText("main")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "所属设备" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "归属 Runtime" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: "最近同步" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Runtime")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "全部",
      "OpenClaw",
    ]);
    expect(screen.queryByLabelText("可用性")).not.toBeInTheDocument();
  });

  it("loads Runtime Fleet from the backend query API when available", async () => {
    const user = userEvent.setup();
    installRuntimeFleetFetch();

    render(<App runtimeMode="agent" />);
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect((await screen.findAllByText("fixture-mac")).length).toBeGreaterThan(0);
    expect(screen.getByText("查看设备、Runtime、Agent 的采集状态、归属关系和最近活动。")).toBeInTheDocument();
    expect(screen.queryByLabelText("采集健康")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("运行资产概览")).queryByText("异常")).not.toBeInTheDocument();
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

  it("filters Runtime Fleet agents by search and opens agent details", async () => {
    const user = userEvent.setup();
    render(<App runtimeMode="agent" />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("搜索设备、Runtime、Agent 或任务"), "main");

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
    expect(screen.getByText(/上次刷新/)).toBeInTheDocument();
  });
});
