import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import fixtureSnapshot from "../fixtures/runtime/collector-snapshot.sample.json";
import type { RuntimeInventorySnapshot, RuntimeWorkStateSnapshot } from "./runtime";

const originalFetch = globalThis.fetch;
const originalPath = window.location.pathname;

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.history.pushState({}, "", originalPath);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function runtimeFleetQueryResponse(snapshot: RuntimeInventorySnapshot, deviceName?: string) {
  return {
    observedAt: snapshot.observedAt,
    devices: [{ ...snapshot.device, name: deviceName ?? snapshot.device.name }],
    runtimes: snapshot.runtimes,
    agents: snapshot.agents,
    summary: {
      agentCount: snapshot.agents.length,
      deviceCount: 1,
      runtimeCount: snapshot.runtimes.length,
    },
  };
}

function workStateQueryResponse(snapshot: RuntimeWorkStateSnapshot) {
  return {
    items: snapshot.workItems.map((item) => ({
      agentId: item.agentId ?? null,
      assignee: item.assignee,
      channelKind: item.channel?.kind ?? null,
      channelLabel: item.channel?.label ?? null,
      conversationId: item.conversationId ?? null,
      creator: item.creator,
      description: item.description ?? null,
      externalId: item.externalId,
      id: item.id,
      lastSeenAt: item.lastSeenAt ?? null,
      runtimeId: item.runtimeId ?? null,
      source: item.source,
      stage: stageFromWorkItemStatus(item.status),
      status: item.status,
      title: item.title,
    })),
    total: snapshot.workItems.length,
  };
}

function emptyWorkStateQueryResponse() {
  return { items: [], total: 0 };
}

function collectionHealthResponse(snapshot: RuntimeInventorySnapshot) {
  return {
    deviceId: snapshot.device.id,
    status: "warning",
    summary: "工作态采集有警告",
    lastObservedAt: "2026-05-10T10:00:00.000Z",
    lastReceivedAt: "2026-05-10T10:00:01.000Z",
    checks: [
      {
        id: "inventory",
        label: "设备资产",
        status: "healthy",
        lastObservedAt: "2026-05-10T09:59:00.000Z",
        lastReceivedAt: "2026-05-10T09:59:01.000Z",
        counts: { agents: snapshot.agents.length, channelBindings: 2, devices: 1, runtimes: snapshot.runtimes.length },
        warnings: [],
        error: null,
        message: "采集正常",
      },
      {
        id: "work_state",
        label: "工作态",
        status: "warning",
        lastObservedAt: "2026-05-10T10:00:00.000Z",
        lastReceivedAt: "2026-05-10T10:00:01.000Z",
        counts: { conversations: 4, executions: 2, workItems: 8 },
        warnings: ["Slock task board probe warning"],
        error: null,
        message: "采集成功，但有 1 条警告",
      },
    ],
  };
}

function stageFromWorkItemStatus(status: RuntimeWorkStateSnapshot["workItems"][number]["status"]): string {
  if (status === "todo") return "pending";
  if (status === "in_progress") return "processing";
  if (status === "in_review") return "review";
  if (status === "done" || status === "cancelled") return "closed";
  return "attention";
}

describe("Console shell", () => {
  it("renders a public home entry at the root without probing auth", () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    window.history.pushState({}, "", "/");

    render(<App authMode="required" />);

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

    render(<App authMode="required" />);

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
    window.history.pushState({}, "", "/runtime");

    render(<App />);

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
    expect(screen.queryByText("@")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "任务 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "通知 0" })).toBeInTheDocument();

    await user.click(within(nav).getByRole("button", { name: "Runs" }));

    expect(window.location.pathname).toBe("/runs");
    expect(screen.getByRole("heading", { name: "工作看板" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "任务 0" }));
    expect(window.location.pathname).toBe("/operations");
    const operationsDrawer = screen.getByRole("dialog", { name: "任务" });
    expect(within(operationsDrawer).getByText("请选择组织后查看任务。")).toBeInTheDocument();
    await user.click(within(operationsDrawer).getByRole("button", { name: "关闭任务" }));
    expect(window.location.pathname).toBe("/runs");

    await user.click(screen.getByRole("button", { name: "通知 0" }));
    expect(window.location.pathname).toBe("/notifications");
    const notificationsDrawer = screen.getByRole("dialog", { name: "通知" });
    expect(within(notificationsDrawer).getByText("请选择组织后查看通知。")).toBeInTheDocument();
    await user.click(within(notificationsDrawer).getByRole("button", { name: "关闭通知" }));
    expect(window.location.pathname).toBe("/runs");

    await user.click(within(nav).getByRole("button", { name: "组织设置" }));
    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("heading", { name: "组织设置" })).toBeInTheDocument();
    expect(screen.getByText("请选择组织后管理成员与权限。")).toBeInTheDocument();
  });

  it("falls back from the removed Catalog route to Runtime Fleet", () => {
    window.history.pushState({}, "", "/catalog");

    render(<App />);

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "对象目录" })).not.toBeInTheDocument();
  });

  it("defaults the Console to Runtime Fleet when no protected page route is provided", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
  });

  it("opens Runs work board with task context and no adapter debug text", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify({ error: "backend_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runs" }));

    expect(screen.getByRole("heading", { name: "工作看板" })).toBeInTheDocument();
    for (const lane of ["待处理", "处理中", "待验收", "已关闭", "需关注"]) {
      expect(screen.getByRole("heading", { name: lane })).toBeInTheDocument();
    }
    expect(await screen.findByText(/当前数据源：Fixture/)).toBeInTheDocument();
    const channelSelect = screen.getByLabelText("渠道") as HTMLSelectElement;
    expect(channelSelect.value).toBe("all");
    expect(within(channelSelect).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "全部",
      "DingTalk",
    ]);

    await user.selectOptions(screen.getByLabelText("来源 Runtime"), "slock");
    await user.type(screen.getByPlaceholderText("搜索任务、消息、发起人、Agent 或会话/群组"), "@fixture-human");

    const slockCard = screen.getByRole("button", { name: /Example in progress card/ });
    expect(within(slockCard).queryByText("处理中")).not.toBeInTheDocument();
    expect(screen.getAllByText("Example in progress card").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/@fixture-human/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/@example-agent/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/#example-board/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/OpenClaw execution/)).not.toBeInTheDocument();
    expect(screen.queryByText("直接证据")).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw has no/)).not.toBeInTheDocument();
    expect(screen.queryByText("能力缺口")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Example in progress card/ }));

    const detail = screen.getByRole("complementary", { name: "工作项详情" });
    expect(within(detail).getByRole("heading", { name: "Example in progress card" })).toBeInTheDocument();
    expect(within(detail).getByText("来源 Runtime: Slock")).toBeInTheDocument();
    expect(within(detail).getByText("Channel: 默认渠道")).toBeInTheDocument();
    expect(within(detail).getByText("发起人: @fixture-human")).toBeInTheDocument();
    expect(within(detail).getByText("承接 Agent: @example-agent")).toBeInTheDocument();
    expect(within(detail).getByText("会话/群组: #example-board")).toBeInTheDocument();
    expect(within(detail).queryByText("执行状态: 不支持采集")).not.toBeInTheDocument();
  });

  it("keeps Slock task-board items readable when no execution record is linked", async () => {
    const user = userEvent.setup();
    const backendSnapshot: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [
        {
          id: "fixture-slock-no-execution",
          source: "slock",
          externalId: "fixture-slock-no-execution",
          title: "Task without execution record",
          status: "in_progress",
          channel: { kind: "slock", label: "#example-board" },
          assignee: { kind: "agent", label: "@example-agent" },
          creator: { kind: "human", label: "@fixture-human" },
          lastSeenAt: "2026-05-09T08:00:00.000Z",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(workStateQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    await user.click(await screen.findByRole("button", { name: /Task without execution record/ }));

    const detail = screen.getByRole("complementary", { name: "工作项详情" });
    expect(within(detail).getByText("工作项状态: 处理中")).toBeInTheDocument();
    expect(within(detail).queryByText(/执行状态:/)).not.toBeInTheDocument();
    expect(within(detail).queryByText("执行状态: 不支持采集")).not.toBeInTheDocument();
  });

  it("keeps long Runs detail titles constrained while preserving the full title", async () => {
    const user = userEvent.setup();
    const longTitle = "使用Aetheris CLI帮我查询数据1、数据连接是：http://s-fat.dancf.com/4hzk 2、查询日期为多个周期内的数据并返回报告";
    const backendSnapshot: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [
        {
          id: "fixture-long-title",
          source: "slock",
          externalId: "fixture-long-title",
          title: longTitle,
          status: "in_review",
          assignee: { kind: "agent", label: "ZyangSenefactor" },
          creator: { kind: "human", label: "zhaoyang" },
          lastSeenAt: "2026-05-09T08:00:00.000Z",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(workStateQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    await user.click(await screen.findByRole("button", { name: new RegExp(longTitle.slice(0, 12)) }));

    const detail = screen.getByRole("complementary", { name: "工作项详情" });
    const title = within(detail).getByRole("heading", { name: longTitle });
    expect(title).toHaveClass("detailTitle");
    expect(title).toHaveAttribute("title", longTitle);
  });

  it("does not turn OpenClaw executions or Slock listening gaps into Runs cards", async () => {
    const user = userEvent.setup();
    const backendSnapshot: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [],
      conversations: [{
        id: "fixture-device:openclaw:gateway:conversation:session-1",
        source: "openclaw",
        externalId: "session-1",
        status: "active",
        runtimeId: "fixture-device:openclaw:gateway",
        agentId: "fixture-device:openclaw:gateway:agent:main",
        lastSeenAt: "2026-05-09T08:00:00.000Z",
      }],
      executions: [{
        id: "fixture-device:openclaw:gateway:execution:run-1",
        source: "openclaw",
        externalId: "run-1",
        runtimeId: "fixture-device:openclaw:gateway",
        agentId: "fixture-device:openclaw:gateway:agent:main",
        status: "succeeded",
        lastSeenAt: "2026-05-09T08:00:00.000Z",
      }],
      capabilities: [
        {
          source: "openclaw",
          collectedAt: "2026-05-09T08:00:00.000Z",
          workItems: { support: "unsupported", strategies: ["cli"], evidence: [], limitations: [] },
          conversations: { support: "partial", strategies: ["cli"], evidence: [], limitations: [] },
          executions: { support: "supported", strategies: ["cli"], evidence: [], limitations: [] },
        },
        {
          source: "slock",
          collectedAt: "2026-05-09T08:00:00.000Z",
          workItems: { support: "unknown", strategies: ["local_state"], evidence: [], limitations: [] },
          conversations: { support: "unknown", strategies: ["local_state"], evidence: [], limitations: [] },
          executions: { support: "unknown", strategies: ["local_state"], evidence: [], limitations: [] },
        },
      ],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(workStateQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(await screen.findByText(/当前数据源：后端查询/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("来源 Runtime"), "slock");
    expect(screen.queryByText("Slock 监听未就绪")).not.toBeInTheDocument();
    expect(screen.queryByText("OpenClaw 执行监听已接入")).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenClaw execution/)).not.toBeInTheDocument();
    expect(screen.queryByText("直接证据")).not.toBeInTheDocument();
    expect(screen.queryByText("能力缺口")).not.toBeInTheDocument();
  });

  it("loads additional Runs pages from the backend cursor", async () => {
    const user = userEvent.setup();
    const firstPage: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [{
        id: "work-page-1",
        source: "slock",
        externalId: "work-page-1",
        title: "First backend card",
        status: "in_progress",
        creator: { kind: "human", label: "PMO" },
        assignee: { kind: "agent", label: "tester" },
        lastSeenAt: "2026-05-09T08:00:00.000Z",
      }],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    const secondPage: RuntimeWorkStateSnapshot = {
      ...firstPage,
      workItems: [{
        ...firstPage.workItems[0],
        id: "work-page-2",
        externalId: "work-page-2",
        title: "Second backend card",
        lastSeenAt: "2026-05-09T07:59:00.000Z",
      }],
    };
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes("/api/runtime-work-items") && !url.includes("cursor=cursor-1")) {
        return new Response(JSON.stringify({ ...workStateQueryResponse(firstPage), nextCursor: "cursor-1", total: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items") && url.includes("cursor=cursor-1")) {
        return new Response(JSON.stringify({ ...workStateQueryResponse(secondPage), total: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runs" }));

    expect(await screen.findByRole("button", { name: /First backend card/ })).toBeInTheDocument();
    expect(screen.getByText("已显示 1 / 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加载更多" }).closest(".boardResultMeta")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "加载更多" }));

    expect(await screen.findByRole("button", { name: /Second backend card/ })).toBeInTheDocument();
    expect(screen.getByText("已显示 2 / 2")).toBeInTheDocument();
    expect(requests.some((url) => url.includes("cursor=cursor-1"))).toBe(true);
  });

  it("hides stale Runs pagination when filters change before the next query returns", async () => {
    const user = userEvent.setup();
    const initialPage: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [
        {
          id: "initial-openclaw-card",
          source: "openclaw",
          externalId: "initial-openclaw-card",
          title: "Initial OpenClaw card",
          status: "todo",
          lastSeenAt: "2026-05-09T08:00:00.000Z",
        },
        {
          id: "initial-slock-card",
          source: "slock",
          externalId: "initial-slock-card",
          title: "Initial Slock card",
          status: "todo",
          lastSeenAt: "2026-05-09T08:00:00.000Z",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items") && url.includes("source=openclaw")) {
        return new Response(JSON.stringify({
          items: [workStateQueryResponse(initialPage).items[0]],
          total: 1,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify({ ...workStateQueryResponse(initialPage), nextCursor: "stale-cursor", total: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(await screen.findByRole("button", { name: "加载更多" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("来源 Runtime"), "openclaw");

    expect(screen.queryByRole("button", { name: "加载更多" })).not.toBeInTheDocument();
    expect(screen.getByText("已显示 1 / 1")).toBeInTheDocument();
  });

  it("opens Runtime Fleet and renders the fixture runtime inventory", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect(screen.getByRole("heading", { name: "运行资产" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("设备")).getByText("Fixture Mac")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Runtime 列表" })).getByText("OpenClaw Gateway")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Agent 列表" })).getByText("tester")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "所属设备" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "归属 Runtime" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: "最近同步" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Runtime")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "全部",
      "OpenClaw",
      "Slock",
    ]);
    expect(within(screen.getByLabelText("可用性")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "全部",
      "在线",
    ]);
  });

  it("loads Runtime Fleet from the backend query API when available", async () => {
    const user = userEvent.setup();
    const backendSnapshot = fixtureSnapshot as RuntimeInventorySnapshot;
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify(runtimeFleetQueryResponse(backendSnapshot, "Backend DB Mac")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(emptyWorkStateQueryResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/devices/fixture-mac/collection-health")) {
        return new Response(JSON.stringify(collectionHealthResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect((await screen.findAllByText("Backend DB Mac")).length).toBeGreaterThan(0);
    expect(screen.getByText(/当前数据源：后端查询/)).toBeInTheDocument();
    const healthPanel = screen.getByLabelText("采集健康");
    expect(within(healthPanel).getByText("工作态采集有警告")).toBeInTheDocument();
    expect(within(healthPanel).getByText("采集成功，但有 1 条警告")).toBeInTheDocument();
    expect(within(healthPanel).getByText("工作项 8 · 会话 4 · 执行 2")).toBeInTheDocument();
  });

  it("loads every backend work-item page before deriving Runtime Fleet operating status", async () => {
    const user = userEvent.setup();
    const backendSnapshot = fixtureSnapshot as RuntimeInventorySnapshot;
    const slockRuntime = backendSnapshot.runtimes.find((runtime) => runtime.kind === "slock");
    if (!slockRuntime) throw new Error("missing Slock runtime fixture");
    const secondPage: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: backendSnapshot.device.id,
      workItems: [{
        id: "second-page-slock-processing",
        source: "slock",
        externalId: "second-page-slock-processing",
        title: "Slock work only visible on page two",
        status: "in_progress",
        runtimeId: slockRuntime.id,
        agentId: "fixture-mac:slock:slock-daemon:agent:tester",
        lastSeenAt: "2026-05-09T08:00:00.000Z",
      }],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify(runtimeFleetQueryResponse(backendSnapshot, "Backend DB Mac")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items") && !url.includes("cursor=work-page-2")) {
        return new Response(JSON.stringify({ items: [], total: 501, nextCursor: "work-page-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items") && url.includes("cursor=work-page-2")) {
        return new Response(JSON.stringify({ ...workStateQueryResponse(secondPage), total: 501 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect(await screen.findByRole("row", { name: /Slock daemon.*工作中/ })).toBeInTheDocument();
    expect(requests.some((url) => url.includes("cursor=work-page-2"))).toBe(true);
  });

  it("does not fall back to the legacy latest inventory API when Runtime Fleet query fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify({ error: "backend_unavailable" }), { status: 503 });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify({ items: [], total: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "legacy endpoint should not be requested" }), { status: 500 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    await waitFor(() => {
      expect(vi.mocked(fetchMock).mock.calls.some((call) => call[0].toString().includes("/api/runtime-fleet"))).toBe(true);
    });
    expect(vi.mocked(fetchMock).mock.calls.some((call) =>
      call[0].toString().includes("/api/runtime-inventory/latest"),
    )).toBe(false);
  });

  it("loads Runs from the backend work-item query API when available", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify({
          items: [{
            agentId: "fixture-mac:slock:slock-daemon:agent:tester",
            assignee: { kind: "agent", label: "tester" },
            channelKind: "other",
            channelLabel: "#AjisGTD",
            conversationId: "fixture-mac:slock:slock-daemon:conversation:thread-1",
            creator: { kind: "human", label: "PMO" },
            description: "PMO asked the Slock agent to inspect queue handoff.",
            externalId: "task-1",
            id: "fixture-mac:slock:slock-daemon:work-item:task-1",
            lastSeenAt: "2026-05-10T10:00:00.000Z",
            runtimeId: "fixture-mac:slock:slock-daemon",
            source: "slock",
            stage: "processing",
            status: "in_progress",
            title: "AGTD-001 Fix queue handoff",
          }],
          total: 1,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Runs" }));

    expect(await screen.findByRole("button", { name: /AGTD-001 Fix queue handoff/ })).toBeInTheDocument();
    expect(screen.getByText(/当前数据源：后端查询/)).toBeInTheDocument();
  });

  it("keeps current Runs filters when automatic refresh reloads backend query data", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const allWorkItems: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [
        {
          id: "fixture-openclaw-card",
          source: "openclaw",
          externalId: "fixture-openclaw-card",
          title: "OpenClaw unfiltered card",
          status: "todo",
          lastSeenAt: "2026-05-09T08:00:00.000Z",
        },
        {
          id: "fixture-slock-card",
          source: "slock",
          externalId: "fixture-slock-card",
          title: "Slock filtered card",
          status: "in_progress",
          lastSeenAt: "2026-05-09T08:00:00.000Z",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      requests.push(url);
      if (url.includes("/api/runtime-work-items") && url.includes("source=slock")) {
        return new Response(JSON.stringify(workStateQueryResponse({
          ...allWorkItems,
          workItems: [allWorkItems.workItems[1]],
        })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(workStateQueryResponse(allWorkItems)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: /OpenClaw unfiltered card/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("来源 Runtime"), { target: { value: "slock" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /OpenClaw unfiltered card/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Slock filtered card/ })).toBeInTheDocument();

    requests.length = 0;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });

    expect(requests.at(-1)).toContain("source=slock");
  });

  it("does not fall back to the legacy latest work-state API when Runs query fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify({ error: "backend_unavailable" }), { status: 503 });
      }
      return new Response(JSON.stringify({ error: "legacy endpoint should not be requested" }), { status: 500 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    render(<App />);
    await user.click(screen.getByRole("button", { name: "Runs" }));

    await waitFor(() => {
      expect(vi.mocked(fetchMock).mock.calls.some((call) => call[0].toString().includes("/api/runtime-work-items"))).toBe(true);
    });
    expect(vi.mocked(fetchMock).mock.calls.some((call) =>
      call[0].toString().includes("/api/runtime-work-state/latest"),
    )).toBe(false);
  });

  it("filters Runs cards by manual time range and exposes quick ranges", async () => {
    const user = userEvent.setup();
    const backendSnapshot: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: "fixture-device",
      workItems: [
        {
          id: "fixture-old-card",
          source: "openclaw",
          externalId: "fixture-old-card",
          title: "Old card",
          status: "done",
          lastSeenAt: "2026-05-08T10:00:00.000Z",
        },
        {
          id: "fixture-new-card",
          source: "openclaw",
          externalId: "fixture-new-card",
          title: "New card",
          status: "done",
          lastSeenAt: "2026-05-09T12:00:00.000Z",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(workStateQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runs" }));
    expect(await screen.findByText(/当前数据源：后端查询/)).toBeInTheDocument();
    const lanes = screen.getByLabelText("工作态泳道");
    expect(within(lanes).getAllByText("Old card").length).toBeGreaterThan(0);
    expect(within(lanes).getAllByText("New card").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("开始时间")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("结束时间")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除时间" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /选择时间范围/ }));
    expect(screen.getByRole("button", { name: "今天" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除时间" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "日历中选择" }));
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-05-09T00:00:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-05-09T23:59:59" } });
    await user.click(screen.getByRole("button", { name: "立即查询" }));

    expect(within(lanes).queryByText("Old card")).not.toBeInTheDocument();
    expect(within(lanes).getAllByText("New card").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /选择时间范围/ }));
    await user.click(screen.getByRole("button", { name: "清除时间" }));
    expect(within(lanes).getAllByText("Old card").length).toBeGreaterThan(0);
    expect(within(lanes).getAllByText("New card").length).toBeGreaterThan(0);
  });

  it("shows Runtime operating status from the latest Agent work state", async () => {
    const user = userEvent.setup();
    const backendSnapshot = fixtureSnapshot as RuntimeInventorySnapshot;
    const workState: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: backendSnapshot.device.id,
      workItems: [
        {
          id: "fixture-slock-task-1",
          source: "slock",
          externalId: "fixture-slock-task-1",
          title: "Example in progress card",
          status: "in_progress",
          runtimeId: "fixture-mac:slock:slock-daemon",
          agentId: "fixture-mac:slock:slock-daemon:agent:tester",
        },
      ],
      conversations: [],
      executions: [],
      capabilities: [],
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify(runtimeFleetQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(workStateQueryResponse(workState)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));

    expect(await screen.findByRole("columnheader", { name: "运行状态" })).toBeInTheDocument();
    const runtimeTable = screen.getByRole("table", { name: "Runtime 列表" });
    const slockRuntimeRow = within(runtimeTable).getByRole("row", { name: /Slock daemon/ });
    expect(within(slockRuntimeRow).getByText("工作中")).toBeInTheDocument();

    await user.click(slockRuntimeRow);
    const detail = screen.getByRole("complementary", { name: "运行资产详情" });
    expect(within(detail).getByText("运行状态: 工作中")).toBeInTheDocument();
    expect(within(detail).getByText("可用性: 在线")).toBeInTheDocument();
  });

  it("shows Slock Agent status and workload statistics from task-board work state", async () => {
    const user = userEvent.setup();
    const backendSnapshot = fixtureSnapshot as RuntimeInventorySnapshot;
    const workState: RuntimeWorkStateSnapshot = {
      observedAt: "2026-05-09T08:00:00.000Z",
      deviceId: backendSnapshot.device.id,
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
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify(runtimeFleetQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(workStateQueryResponse(workState)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();

    const agentTable = screen.getByRole("table", { name: "Agent 列表" });
    const testerRow = within(agentTable).getByRole("row", { name: /tester/ });
    expect(within(testerRow).getByText("活跃")).toBeInTheDocument();

    await user.click(testerRow);

    const detail = screen.getByRole("complementary", { name: "运行资产详情" });
    expect(within(detail).getByRole("heading", { name: "tester" })).toBeInTheDocument();
    expect(within(detail).getByText("状态: 活跃")).toBeInTheDocument();
    expect(within(detail).getByText("活跃任务: 1")).toBeInTheDocument();
    expect(within(detail).getByText("队列深度: 1")).toBeInTheDocument();
    expect(within(detail).getByText("活跃会话: 1")).toBeInTheDocument();
    expect(within(detail).getByText("历史会话: 2")).toBeInTheDocument();
  });

  it("filters Runtime Fleet agents by search and opens agent details", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("搜索设备、Runtime、Agent 或渠道"), "tester");

    const agentTable = screen.getByRole("table", { name: "Agent 列表" });
    expect(within(agentTable).getByText("tester")).toBeInTheDocument();
    expect(within(agentTable).queryByText("main")).not.toBeInTheDocument();

    await user.click(screen.getByRole("row", { name: /tester/ }));

    const detail = screen.getByRole("complementary", { name: "运行资产详情" });
    expect(within(detail).getByRole("heading", { name: "tester" })).toBeInTheDocument();
    expect(within(detail).getByText("归属关系")).toBeInTheDocument();
    expect(within(detail).getByText("所属 Runtime: Slock daemon")).toBeInTheDocument();
    expect(within(detail).getByText("所属设备: Fixture Mac")).toBeInTheDocument();
    expect(within(detail).getByText("关联渠道")).toBeInTheDocument();
    expect(within(detail).getByText("Slock")).toBeInTheDocument();
    expect(within(detail).queryByText("slock: tester")).not.toBeInTheDocument();
    expect(within(detail).queryByText("事实")).not.toBeInTheDocument();
    expect(within(detail).queryByText("可用渠道")).not.toBeInTheDocument();
  });

  it("renders Runtime Fleet agents with multiple same-kind channel bindings without duplicate key warnings", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const backendSnapshot: RuntimeInventorySnapshot = {
      ...(fixtureSnapshot as RuntimeInventorySnapshot),
      agents: (fixtureSnapshot as RuntimeInventorySnapshot).agents.map((agent) => {
        if (agent.id !== "fixture-mac:openclaw:gateway-18789:agent:main") return agent;
        return {
          ...agent,
          channelBindings: [
            { kind: "dingtalk", label: "DingTalk default", externalId: "default", status: "enabled" },
            { kind: "dingtalk", label: "DingTalk backup", externalId: "backup", status: "enabled" },
          ],
        };
      }),
    };
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify(runtimeFleetQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(emptyWorkStateQueryResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(await screen.findByText("DingTalk backup")).toBeInTheDocument();

    const duplicateKeyWarning = consoleError.mock.calls.some((call) =>
      call.some((argument) => String(argument).includes("Encountered two children with the same key")),
    );
    expect(duplicateKeyWarning).toBe(false);
  });

  it("automatically refreshes Runtime Fleet query data while mounted", async () => {
    vi.useFakeTimers();
    let latestRequests = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        latestRequests += 1;
        const snapshot: RuntimeInventorySnapshot = {
          ...(fixtureSnapshot as RuntimeInventorySnapshot),
          device: {
            ...(fixtureSnapshot as RuntimeInventorySnapshot).device,
            name: `Auto Refresh Mac ${latestRequests}`,
          },
          observedAt: `2026-05-08T08:00:0${latestRequests}.000Z`,
        };
        return new Response(JSON.stringify(runtimeFleetQueryResponse(snapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(emptyWorkStateQueryResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("Auto Refresh Mac 1")).toHaveLength(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });

    expect(screen.getAllByText("Auto Refresh Mac 2").length).toBeGreaterThan(0);
    expect(latestRequests).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/上次刷新/)).toBeInTheDocument();
  });

  it("requests a remote device refresh and reloads backend query data", async () => {
    const user = userEvent.setup();
    let latestRequests = 0;
    const backendSnapshot: RuntimeInventorySnapshot = {
      ...(fixtureSnapshot as RuntimeInventorySnapshot),
      device: {
        ...(fixtureSnapshot as RuntimeInventorySnapshot).device,
        name: "Backend Fixture Mac",
      },
    };
    const refreshedSnapshot: RuntimeInventorySnapshot = {
      ...backendSnapshot,
      device: {
        ...backendSnapshot.device,
        name: "Refreshed Fixture Mac",
      },
    };
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        latestRequests += 1;
        return new Response(JSON.stringify(runtimeFleetQueryResponse(
          latestRequests === 1 ? backendSnapshot : refreshedSnapshot,
        )), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(emptyWorkStateQueryResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/devices/fixture-mac/refresh") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, commandId: "cmd-refresh-1", status: "sent" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/devices/fixture-mac/commands/cmd-refresh-1")) {
        return new Response(JSON.stringify({ commandId: "cmd-refresh-1", status: "succeeded" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(await screen.findAllByText("Backend Fixture Mac")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "请求设备刷新" }));

    expect(await screen.findByText("刷新完成")).toBeInTheDocument();
    expect((await screen.findAllByText("Refreshed Fixture Mac")).length).toBeGreaterThan(0);
    expect(vi.mocked(globalThis.fetch).mock.calls.some((call) => call[0].toString().includes("/refresh"))).toBe(true);
  });

  it("polls a remote refresh command until it reaches a terminal state", async () => {
    const user = userEvent.setup();
    let latestRequests = 0;
    let commandRequests = 0;
    const backendSnapshot: RuntimeInventorySnapshot = {
      ...(fixtureSnapshot as RuntimeInventorySnapshot),
      device: {
        ...(fixtureSnapshot as RuntimeInventorySnapshot).device,
        name: "Backend Fixture Mac",
      },
    };
    const refreshedSnapshot: RuntimeInventorySnapshot = {
      ...backendSnapshot,
      device: {
        ...backendSnapshot.device,
        name: "Polled Fixture Mac",
      },
    };
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        latestRequests += 1;
        return new Response(JSON.stringify(runtimeFleetQueryResponse(
          latestRequests === 1 ? backendSnapshot : refreshedSnapshot,
        )), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(emptyWorkStateQueryResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/devices/fixture-mac/refresh") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, commandId: "cmd-refresh-1", status: "sent" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/devices/fixture-mac/commands/cmd-refresh-1")) {
        commandRequests += 1;
        return new Response(JSON.stringify({
          commandId: "cmd-refresh-1",
          status: commandRequests === 1 ? "accepted" : "succeeded",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect(await screen.findAllByText("Backend Fixture Mac")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "请求设备刷新" }));

    expect(await screen.findByText("刷新完成", {}, { timeout: 3000 })).toBeInTheDocument();
    expect((await screen.findAllByText("Polled Fixture Mac")).length).toBeGreaterThan(0);
    expect(commandRequests).toBe(2);
  });

  it("shows a clear remote refresh error when the device is disconnected", async () => {
    const user = userEvent.setup();
    const backendSnapshot = fixtureSnapshot as RuntimeInventorySnapshot;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = input.toString();
      if (url.includes("/api/runtime-fleet")) {
        return new Response(JSON.stringify(runtimeFleetQueryResponse(backendSnapshot)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/runtime-work-items")) {
        return new Response(JSON.stringify(emptyWorkStateQueryResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/devices/fixture-mac/refresh") && init?.method === "POST") {
        return new Response(JSON.stringify({
          error: "device_not_connected",
          message: "device is not connected: fixture-mac",
        }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected request" }), { status: 500 });
    }) as unknown as typeof fetch;
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Runtime Fleet" }));
    expect((await screen.findAllByText("Fixture Mac")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "请求设备刷新" }));

    expect(await screen.findByText("设备控制通道未连接，已保留最近一次采集数据。请确认设备 Collector 在线后再刷新。")).toBeInTheDocument();
  });
});
