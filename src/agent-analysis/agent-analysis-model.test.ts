import { describe, expect, it } from "vitest";
import {
  buildAgentAnalysisPrompt,
  computeOpenClawHardMetrics,
  deriveOverallSatisfaction,
  validateAgentAnalysisText,
} from "./agent-analysis-model";

describe("agent analysis model", () => {
  it("computes OpenClaw hard metrics using trajectory elapsed for done and failed Tasks only", () => {
    const result = computeOpenClawHardMetrics({
      periodEnd: "2026-06-02T16:00:00.000Z",
      periodStart: "2026-06-01T16:00:00.000Z",
      tasks: [
        {
          id: "task_done",
          status: "done",
          taskType: "conversation",
          createdSourceAt: "2026-06-01T18:00:00.000Z",
          updatedSourceAt: "2026-06-01T18:02:00.000Z",
        },
        {
          id: "task_failed",
          status: "failed",
          taskType: "conversation",
          createdSourceAt: "2026-06-01T19:00:00.000Z",
          updatedSourceAt: "2026-06-01T19:06:00.000Z",
        },
        {
          id: "task_running",
          status: "in_progress",
          taskType: "scheduled",
          createdSourceAt: "2026-06-01T20:00:00.000Z",
          updatedSourceAt: "2026-06-01T20:10:00.000Z",
        },
        {
          id: "task_unknown",
          status: "unknown",
          taskType: "conversation",
          createdSourceAt: "2026-06-01T21:00:00.000Z",
          updatedSourceAt: "2026-06-01T21:01:00.000Z",
        },
        {
          id: "task_cancelled",
          status: "cancelled",
          taskType: "conversation",
          createdSourceAt: "2026-06-01T22:00:00.000Z",
          updatedSourceAt: "2026-06-01T22:03:00.000Z",
        },
      ],
    });

    expect(result.hardMetrics).toMatchObject({
      duration: {
        avgMs: 240_000,
        basis: "trajectoryElapsed",
        includedStatuses: ["done", "failed"],
        p50Ms: 120_000,
        p90Ms: 360_000,
        sampleCount: 2,
      },
      failedCount: 1,
      statusCounts: {
        cancelled: 1,
        done: 1,
        failed: 1,
        in_progress: 1,
        total: 5,
        unknown: 1,
      },
      taskTypeCounts: {
        conversation: 4,
        scheduled: 1,
      },
      totalTasks: 5,
      unknownCount: 1,
    });
  });

  it("builds a Chinese JSON-only OpenClaw operation prompt with period and session-analysis constraints", () => {
    const prompt = buildAgentAnalysisPrompt({
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      hardMetrics: {
        duration: {
          basis: "trajectoryElapsed",
          includedStatuses: ["done", "failed"],
          sampleCount: 1,
          avgMs: 120_000,
          p50Ms: 120_000,
          p90Ms: 120_000,
        },
        failedCount: 0,
        periodEnd: "2026-06-02T16:00:00.000Z",
        periodStart: "2026-06-01T16:00:00.000Z",
        statusCounts: { done: 1, total: 1 },
        taskTypeCounts: { conversation: 1 },
        totalTasks: 1,
        unknownCount: 0,
      },
      promptKind: "daily_operation_review",
      promptVersion: "openclaw-agent-operation-analysis-v2",
    });

    expect(prompt).toContain("你是一名 Agent 运行分析助手");
    expect(prompt).toContain("periodStart <= eventTime < periodEnd");
    expect(prompt).toContain("以会话/session 为主要分析粒度");
    expect(prompt).toContain("跨周期 session");
    expect(prompt).toContain("不要增加其他字段");
    expect(prompt).toContain("\"hardMetrics\"");
    expect(prompt).toContain("\"periodPerformance\"");
    expect(prompt).toContain("\"taskTypes\"");
    expect(prompt).toContain("\"positive|mixed|negative|unknown\"");
    expect(prompt).not.toContain("Lorume 会");
    expect(prompt).not.toContain("\"schemaVersion\"");
    expect(prompt).not.toContain("\"sampledTasks\"");
    expect(prompt).not.toContain("\"confidence\"");
  });

  it("validates raw v2 agent JSON and rejects markdown, extra fields, global satisfaction, and empty evidence", () => {
    const valid = validateAgentAnalysisText(JSON.stringify({
      periodPerformance: {
        workload: "任务量稳定。",
        completion: "多数任务已完成。",
        latency: "耗时集中在 20 分钟内。",
        failurePattern: "失败主要来自环境差异。",
      },
      taskTypes: [
        {
          label: "设备运维",
          countEstimate: 1,
          description: "主要处理 collector 和运行环境问题。",
          satisfaction: {
            level: "mixed",
            reason: "用户推进问题解决，但有重复排查。",
            evidenceIds: ["session_1"],
          },
          cases: [
            {
              id: "session_1",
              title: "真实设备分析失败排查",
              signal: "mixed",
              outcome: "定位到环境差异。",
              reason: "该会话体现了重复排查和最终推进。",
            },
          ],
        },
      ],
      risks: [
        {
          title: "设备环境差异",
          description: "服务进程 PATH 与交互 shell 不一致。",
          evidenceIds: ["trajectory_1"],
        },
      ],
      actions: [
        {
          title: "补充环境诊断",
          reason: "减少同类问题重复排查。",
          evidenceIds: ["trajectory_1"],
        },
      ],
    }));

    expect(valid.ok).toBe(true);
    expect(valid.ok && valid.result.taskTypes[0]?.satisfaction.level).toBe("mixed");
    expect(validateAgentAnalysisText("```json\n{}\n```")).toMatchObject({
      ok: false,
    });
    expect(validateAgentAnalysisText(JSON.stringify({
      periodPerformance: {
        workload: "ok",
        completion: "ok",
        latency: "ok",
        failurePattern: "ok",
      },
      taskTypes: [],
      risks: [],
      actions: [],
      userSatisfaction: { level: "positive" },
    }))).toMatchObject({ ok: false });
    expect(validateAgentAnalysisText(JSON.stringify({
      periodPerformance: {
        workload: "ok",
        completion: "ok",
        latency: "ok",
        failurePattern: "ok",
      },
      taskTypes: [
        {
          label: "设备运维",
          countEstimate: 1,
          description: "处理设备问题。",
          satisfaction: {
            level: "positive",
            reason: "用户确认推进。",
            evidenceIds: [],
          },
          cases: [],
        },
      ],
      risks: [],
      actions: [],
    }))).toMatchObject({ ok: false });
    expect(validateAgentAnalysisText(JSON.stringify({
      periodPerformance: {
        workload: "ok",
        completion: "ok",
        latency: "ok",
        failurePattern: "ok",
      },
      taskTypes: [],
      risks: [],
      actions: [],
      extra: "not allowed",
    }))).toMatchObject({ ok: false });
  });

  it("derives overall satisfaction from task type satisfaction and count estimates", () => {
    expect(deriveOverallSatisfaction([
      { countEstimate: 8, satisfaction: { level: "positive" } },
      { countEstimate: 2, satisfaction: { level: "negative" } },
      { countEstimate: 3, satisfaction: { level: "unknown" } },
    ])).toEqual({
      level: "positive",
      score: 0.8,
    });
    expect(deriveOverallSatisfaction([
      { countEstimate: 4, satisfaction: { level: "mixed" } },
      { countEstimate: 4, satisfaction: { level: "negative" } },
    ])).toEqual({
      level: "mixed",
      score: 0.25,
    });
    expect(deriveOverallSatisfaction([
      { countEstimate: 3, satisfaction: { level: "unknown" } },
    ])).toEqual({
      level: "unknown",
    });
  });
});
