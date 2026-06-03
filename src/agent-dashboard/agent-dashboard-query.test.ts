import { describe, expect, it, vi } from "vitest";
import {
  createAgentAnalysisReportUrl,
  createAgentAnalysisReportsUrl,
  createAgentAnalysisRun,
  createOperationDetailUrl,
  normalizeAgentAnalysisReportResponse,
  normalizeAgentAnalysisReportsResponse,
} from "./agent-dashboard-query";

const reportPayload = {
  id: "agr_1",
  organizationId: "org_1",
  operationId: "op_1",
  deviceId: "gezilinll-claw",
  runtimeId: "gezilinll-claw:runtime:openclaw",
  agentId: "gezilinll-claw:runtime:openclaw:agent:main",
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
    periodStart: "2026-06-01T16:00:00.000Z",
    periodEnd: "2026-06-02T16:00:00.000Z",
    statusCounts: { cancelled: 3, done: 31, failed: 5, total: 42, unknown: 3 },
    taskTypeCounts: { conversation: 29, scheduled: 10, unknown: 3 },
    totalTasks: 42,
    unknownCount: 3,
  },
  analysis: {
    schemaVersion: "agent-analysis-v1",
    promptKind: "daily_operation_review",
    summary: "Queue triage dominated the day.",
    satisfactionScore: 0.9,
    taskTypeBreakdown: [{
      type: "collector_ops",
      label: "collector / 设备运维",
      countEstimate: 14,
      confidence: "high",
      evidenceTaskIds: ["task_9bd3"],
    }],
    typicalCases: [{
      taskId: "task_9bd3",
      title: "真实设备分析执行失败排查",
      whyTypical: "反映服务环境差异。",
      outcome: "修复 collector 命令发现策略。",
      status: "failed",
      evidence: "PATH 中没有 openclaw。",
    }],
    risks: [{
      title: "collector 环境差异",
      severity: "medium",
      evidenceTaskIds: ["task_9bd3"],
      description: "服务进程 PATH 可能不同。",
    }],
    dataQualityNotes: ["Only sampled tasks were reviewed."],
  },
  modelMetadata: {
    provider: "openai",
    model: "gpt-test",
    usage: { cacheRead: 0, input: 1, output: 2, total: 3 },
  },
  createdAt: "2026-06-03T04:14:00.000Z",
};

describe("agent dashboard query helpers", () => {
  it("builds organization-scoped report URLs", () => {
    const listUrl = createAgentAnalysisReportsUrl("https://lorume.test", {
      agentId: "device:runtime:openclaw:agent:main",
      limit: 5,
      organizationId: "org_1",
    });
    expect(listUrl.pathname).toBe("/api/agent-analysis-reports");
    expect(listUrl.searchParams.get("organizationId")).toBe("org_1");
    expect(listUrl.searchParams.get("agentId")).toBe("device:runtime:openclaw:agent:main");
    expect(listUrl.searchParams.get("limit")).toBe("5");

    const detailUrl = createAgentAnalysisReportUrl("https://lorume.test", "agr_1", "org_1");
    expect(detailUrl.pathname).toBe("/api/agent-analysis-reports/agr_1");
    expect(detailUrl.searchParams.get("organizationId")).toBe("org_1");

    const operationUrl = createOperationDetailUrl("https://lorume.test", "op_1");
    expect(operationUrl.pathname).toBe("/api/operations/op_1");
  });

  it("normalizes report list responses and removes satisfaction fields", () => {
    const reports = normalizeAgentAnalysisReportsResponse({
      reports: [
        reportPayload,
        { ...reportPayload, id: "" },
        { ...reportPayload, runtimeKind: "codex" },
      ],
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentId: "gezilinll-claw:runtime:openclaw:agent:main",
      deviceId: "gezilinll-claw",
      id: "agr_1",
      runtimeKind: "openclaw",
    });
    expect(JSON.stringify(reports[0]?.analysis)).not.toContain("satisfaction");
    expect(reports[0]?.analysis.taskTypeBreakdown[0]).toMatchObject({
      confidence: "high",
      countEstimate: 14,
      label: "collector / 设备运维",
    });
  });

  it("normalizes report detail responses", () => {
    expect(normalizeAgentAnalysisReportResponse({ report: reportPayload })?.id).toBe("agr_1");
    expect(normalizeAgentAnalysisReportResponse({ report: { ...reportPayload, analysis: {} } })).toBeNull();
    expect(normalizeAgentAnalysisReportsResponse({ reports: "invalid" })).toEqual([]);
  });

  it("creates Agent analysis runs and returns operation/job summary", async () => {
    const fetcher = vi.fn(async (_input: URL, _init?: RequestInit) => new Response(JSON.stringify({
      operation: {
        id: "op_1",
        status: "queued",
        summary: "Analyze OpenClaw main",
        type: "agent_analysis",
        createdAt: "2026-06-03T04:00:00.000Z",
        updatedAt: "2026-06-03T04:00:00.000Z",
      },
      job: {
        id: "opjob_1",
        operationId: "op_1",
        status: "queued",
        type: "agent_analysis_openclaw",
        payload: { stage: "queued" },
      },
    }), {
      headers: { "content-type": "application/json" },
      status: 202,
    }));

    const run = await createAgentAnalysisRun("https://lorume.test", {
      agentId: "device:runtime:openclaw:agent:main",
      organizationId: "org_1",
      periodEnd: "2026-06-02T16:00:00.000Z",
      periodStart: "2026-06-01T16:00:00.000Z",
    }, fetcher);

    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: "POST",
    }));
    const [requestUrl, init] = fetcher.mock.calls[0];
    expect(String(requestUrl)).toContain("organizationId=org_1");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      agentId: "device:runtime:openclaw:agent:main",
      periodEnd: "2026-06-02T16:00:00.000Z",
    });
    expect(run).toMatchObject({
      job: { id: "opjob_1", status: "queued" },
      operation: { id: "op_1", status: "queued", type: "agent_analysis" },
    });
  });
});
