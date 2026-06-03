import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDashboardPage } from "./AgentDashboardPage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function requestUrl(input: Parameters<typeof fetch>[0] | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

const agentId = "gezilinll-claw:runtime:openclaw:agent:main";
const codexAgentId = "gezilinll-claw:runtime:codex:agent:main";

const fleetResponse = {
  agents: [
    {
      collectionStatus: "online",
      id: agentId,
      lastSeenAt: "2026-06-02T15:41:00.000Z",
      name: "main",
      runtimeId: "gezilinll-claw:runtime:openclaw",
    },
    {
      collectionStatus: "online",
      id: codexAgentId,
      lastSeenAt: "2026-06-02T15:41:00.000Z",
      name: "main",
      runtimeId: "gezilinll-claw:runtime:codex",
    },
  ],
  collectedAt: "2026-06-03T04:14:00.000Z",
  devices: [{
    collectionStatus: "online",
    collector: { version: "0.1.4" },
    hostname: "gezilinll-claw.local",
    id: "gezilinll-claw",
    lastSeenAt: "2026-06-02T15:41:00.000Z",
    os: "darwin",
  }],
  runtimes: [
    {
      collectionStatus: "online",
      deviceId: "gezilinll-claw",
      id: "gezilinll-claw:runtime:openclaw",
      kind: "openclaw",
      lastSeenAt: "2026-06-02T15:41:00.000Z",
      name: "OpenClaw",
    },
    {
      collectionStatus: "online",
      deviceId: "gezilinll-claw",
      id: "gezilinll-claw:runtime:codex",
      kind: "codex",
      lastSeenAt: "2026-06-02T15:41:00.000Z",
      name: "Codex",
    },
  ],
  summary: {
    agentCount: 2,
    deviceCount: 1,
    runtimeCount: 2,
    taskCount: 42,
  },
  taskSummary: {
    byAgentId: {},
    byDeviceId: {},
    byRuntimeId: {},
    latestTaskAtByAgentId: {},
    latestTaskAtByDeviceId: {},
    latestTaskAtByRuntimeId: {},
  },
};

const report = {
  id: "agr_1",
  organizationId: "org_1",
  operationId: "op_1",
  deviceId: "gezilinll-claw",
  runtimeId: "gezilinll-claw:runtime:openclaw",
  agentId,
  runtimeKind: "openclaw",
  periodStart: "2026-06-01T16:00:00.000Z",
  periodEnd: "2026-06-02T16:00:00.000Z",
  promptKind: "daily_operation_review",
  promptVersion: "openclaw-agent-analysis-v1",
  hardMetrics: {
    duration: {
      basis: "trajectoryElapsed",
      includedStatuses: ["done", "failed"],
      sampleCount: 36,
      avgMs: 1_092_000,
      p50Ms: 760_000,
      p90Ms: 2_763_000,
    },
    failedCount: 5,
    lastActiveAt: "2026-06-02T15:41:00.000Z",
    periodEnd: "2026-06-02T16:00:00.000Z",
    periodStart: "2026-06-01T16:00:00.000Z",
    statusCounts: { cancelled: 3, done: 31, failed: 5, total: 42, unknown: 3 },
    taskTypeCounts: { conversation: 29, scheduled: 10, unknown: 3 },
    totalTasks: 42,
    unknownCount: 3,
  },
  analysis: {
    schemaVersion: "agent-analysis-v1",
    promptKind: "daily_operation_review",
    summary: "Queue triage dominated the day.",
    satisfactionScore: 0.98,
    taskTypeBreakdown: [{
      confidence: "high",
      countEstimate: 14,
      evidenceTaskIds: ["task_9bd3"],
      label: "collector / 设备运维",
      type: "collector_ops",
    }],
    typicalCases: [{
      evidence: "PATH 中没有 openclaw。",
      outcome: "修复 collector 命令发现策略。",
      status: "failed",
      taskId: "task_9bd3",
      title: "真实设备分析执行失败排查",
      whyTypical: "反映服务环境差异。",
    }],
    risks: [{
      description: "服务进程 PATH 可能不同。",
      evidenceTaskIds: ["task_9bd3"],
      severity: "medium",
      title: "collector 环境差异",
    }],
    dataQualityNotes: ["Only sampled tasks were reviewed."],
  },
  modelMetadata: {
    model: "gpt-test",
    provider: "openai",
    usage: { cacheRead: 0, input: 1, output: 2, total: 3 },
  },
  createdAt: "2026-06-03T04:14:00.000Z",
};

describe("AgentDashboardPage", () => {
  it("renders hard metrics and Agent self-analysis from the latest report", async () => {
    installDashboardFetch({ reports: [report] });

    render(<AgentDashboardPage initialAgentId={agentId} organizationId="org_1" />);

    expect(await screen.findByRole("heading", { name: "Agent 看板" })).toBeInTheDocument();
    expect(screen.getByText("OpenClaw main")).toBeInTheDocument();
    expect(screen.getAllByText("系统计算").length).toBeGreaterThan(0);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("5 / 3")).toBeInTheDocument();
    expect(screen.getByText("18m 12s / 46m 03s")).toBeInTheDocument();
    expect(screen.getByText("Agent 自评")).toBeInTheDocument();
    expect(screen.getByText("Queue triage dominated the day.")).toBeInTheDocument();
    expect(screen.getAllByText("collector / 设备运维").length).toBeGreaterThan(0);
    expect(screen.getByText("真实设备分析执行失败排查")).toBeInTheDocument();
    expect(screen.getByText("collector 环境差异")).toBeInTheDocument();
    expect(screen.getByText("Only sampled tasks were reviewed.")).toBeInTheDocument();
    expect(screen.queryByText(/satisfaction/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.98/)).not.toBeInTheDocument();
  });

  it("creates an analysis run and displays Operation progress", async () => {
    const fetcher = installDashboardFetch({ reports: [report] });

    render(<AgentDashboardPage initialAgentId={agentId} organizationId="org_1" />);

    await userEvent.click(await screen.findByRole("button", { name: "运行分析" }));

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({
        pathname: "/api/agent-analysis-runs",
      }), expect.objectContaining({ method: "POST" }));
    });
    const operationPanel = await screen.findByLabelText("分析任务");
    expect(within(operationPanel).getByText("executing")).toBeInTheDocument();
    expect(within(operationPanel).getByText("执行中")).toBeInTheDocument();
    expect(within(operationPanel).queryByText(/nonce/i)).not.toBeInTheDocument();
  });

  it("shows empty and unsupported states without exposing fake analysis", async () => {
    installDashboardFetch({ reports: [] });

    const { rerender } = render(<AgentDashboardPage initialAgentId={agentId} organizationId="org_1" />);

    expect(await screen.findByText("暂无分析报告")).toBeInTheDocument();
    expect(screen.queryByText("Agent 自评")).not.toBeInTheDocument();

    rerender(<AgentDashboardPage initialAgentId={codexAgentId} organizationId="org_1" />);

    await waitFor(() => expect(screen.getAllByText("不支持分析").length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "运行分析" })).toBeDisabled();
  });
});

function installDashboardFetch({ reports }: { reports: unknown[] }) {
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0] | URL) => {
    const url = requestUrl(input);
    if (url.includes("/api/runtime-fleet")) return jsonResponse(fleetResponse);
    if (url.includes("/api/agent-analysis-reports") && !url.includes("/agr_")) {
      return jsonResponse({ reports });
    }
    if (url.includes("/api/agent-analysis-runs")) {
      return jsonResponse({
        operation: {
          createdAt: "2026-06-03T04:20:00.000Z",
          id: "op_created",
          resourceId: agentId,
          resourceType: "agent",
          status: "running",
          summary: "Analyze OpenClaw main",
          targetId: "gezilinll-claw",
          targetType: "device",
          type: "agent_analysis",
          updatedAt: "2026-06-03T04:20:01.000Z",
        },
        job: {
          id: "opjob_created",
          operationId: "op_created",
          payload: { stage: "queued" },
          status: "running",
          type: "agent_analysis_openclaw",
        },
      }, 202);
    }
    if (url.includes("/api/operations/op_created")) {
      return jsonResponse({
        operation: {
          createdAt: "2026-06-03T04:20:00.000Z",
          id: "op_created",
          status: "running",
          summary: "Analyze OpenClaw main",
          type: "agent_analysis",
          updatedAt: "2026-06-03T04:20:01.000Z",
        },
        jobs: [{
          id: "opjob_created",
          operationId: "op_created",
          payload: { message: "Running OpenClaw Agent analysis", stage: "executing" },
          status: "running",
          type: "agent_analysis_openclaw",
        }],
      });
    }
    return jsonResponse({ error: "unexpected request" }, 500);
  }) as unknown as typeof fetch;
  globalThis.fetch = fetcher;
  return fetcher;
}
