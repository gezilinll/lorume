import { describe, expect, it } from "vitest";
import type { AgentAnalysisStore } from "../agent-analysis/agent-analysis-store";
import type { AgentAnalysisRequestMessage } from "../server/runtime-control-channel";
import {
  applyAgentAnalysisResult,
  dispatchAgentAnalysisJob,
} from "./agent-analysis";
import type { OperationJobRow, OperationStore } from "./operation-store";

describe("agent analysis operation handler", () => {
  it("dispatches an OpenClaw analysis request and leaves the Job externally running", async () => {
    const requests: AgentAnalysisRequestMessage[] = [];
    const payloadPatches: Record<string, unknown>[] = [];
    const result = await dispatchAgentAnalysisJob({
      agentAnalysisStore: createAgentAnalysisStore(),
      controlChannel: {
        sendAgentAnalysisRequest: (message) => {
          requests.push(message);
          return true;
        },
      },
      now: () => new Date("2026-06-03T08:00:00.000Z"),
      operationStore: {
        updateJobPayload: async (input: Parameters<OperationStore["updateJobPayload"]>[0]) => {
          payloadPatches.push(input.payloadPatch);
          return null;
        },
      } as unknown as OperationStore,
    }, createAnalysisJob());

    expect(result).toEqual({ status: "external_running" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      deviceId: "fixture-mac",
      jobId: "opjob_analysis",
      openclawAgentId: "main",
      operationId: "op_analysis",
      promptKind: "daily_operation_review",
      promptVersion: "openclaw-agent-operation-analysis-v2",
      runtimeId: "fixture-mac:runtime:openclaw",
      timeoutSeconds: 300,
    });
    expect(requests[0]?.prompt).toContain("\"hardMetrics\"");
    expect(requests[0]?.prompt).toContain("以会话/session 为主要分析粒度");
    expect(requests[0]?.prompt).not.toContain("--deliver");
    expect(payloadPatches[0]).toMatchObject({
      dispatchedAt: "2026-06-03T08:00:00.000Z",
      promptVersion: "openclaw-agent-operation-analysis-v2",
      stage: "dispatched",
      status: "running",
    });
    expect(payloadPatches[0]).not.toHaveProperty("allowedTaskIds");
  });

  it("validates result JSON, writes a report, and completes the external Job", async () => {
    const reports: Array<Parameters<AgentAnalysisStore["upsertReport"]>[0]> = [];
    const completions: Record<string, unknown>[] = [];
    const result = await applyAgentAnalysisResult({
      agentAnalysisStore: {
        ...createAgentAnalysisStore(),
        upsertReport: async (input: Parameters<AgentAnalysisStore["upsertReport"]>[0]) => {
          reports.push(input);
          return {
            ...input,
            createdAt: new Date("2026-06-03T08:01:00.000Z"),
            id: "agr_1",
            periodEnd: new Date(input.periodEnd),
            periodStart: new Date(input.periodStart),
          };
        },
      } as unknown as AgentAnalysisStore,
      now: () => new Date("2026-06-03T08:01:00.000Z"),
      operationStore: {
        completeExternalJob: async (input: Parameters<OperationStore["completeExternalJob"]>[0]) => {
          completions.push(input);
          return null;
        },
        listJobs: async () => [createAnalysisJob({
          hardMetrics: createHardMetrics(),
          promptVersion: "openclaw-agent-operation-analysis-v2",
          stage: "dispatched",
          status: "running",
        })],
      } as unknown as OperationStore,
    }, {
      analysis: {
        periodPerformance: {
          workload: "任务量稳定。",
          completion: "多数任务已完成。",
          latency: "耗时集中在 20 分钟内。",
          failurePattern: "未发现集中失败。",
        },
        taskTypes: [
          {
            label: "队列整理",
            countEstimate: 1,
            description: "处理队列整理和摘要请求。",
            satisfaction: {
              level: "positive",
              reason: "用户目标清晰且任务闭环。",
              evidenceIds: ["session_1"],
            },
            cases: [
              {
                id: "session_1",
                title: "Queue triage",
                signal: "positive",
                outcome: "Completed",
                reason: "It reflects the main work pattern.",
              },
            ],
          },
        ],
        risks: [],
        actions: [
          {
            title: "沉淀队列摘要模板",
            reason: "减少重复说明成本。",
            evidenceIds: ["session_1"],
          },
        ],
      },
      deviceId: "fixture-mac",
      durationMs: 10842,
      jobId: "opjob_analysis",
      modelMetadata: { model: "gpt-test", provider: "openai" },
      nonce: "analysis_nonce",
      operationId: "op_analysis",
      protocolVersion: 1,
      runtimeRunId: "run_123",
      status: "succeeded",
    });

    expect(result).toEqual({ status: "completed" });
    expect(reports[0]).toMatchObject({
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      deviceId: "fixture-mac",
      modelMetadata: { model: "gpt-test", provider: "openai" },
      operationId: "op_analysis",
      promptVersion: "openclaw-agent-operation-analysis-v2",
      runtimeKind: "openclaw",
    });
    expect(completions[0]).toMatchObject({
      jobId: "opjob_analysis",
      payloadPatch: {
        durationMs: 10842,
        reportId: "agr_1",
        runtimeRunId: "run_123",
        stage: "succeeded",
        status: "succeeded",
      },
      status: "succeeded",
    });
  });

  it("ignores result messages whose nonce does not match the Job payload", async () => {
    const result = await applyAgentAnalysisResult({
      agentAnalysisStore: createAgentAnalysisStore(),
      operationStore: {
        listJobs: async () => [createAnalysisJob()],
      } as unknown as OperationStore,
    }, {
      deviceId: "fixture-mac",
      jobId: "opjob_analysis",
      nonce: "wrong_nonce",
      operationId: "op_analysis",
      protocolVersion: 1,
      status: "failed",
    });

    expect(result).toEqual({ status: "ignored" });
  });
});

function createAgentAnalysisStore(): AgentAnalysisStore {
  return {
    close: async () => undefined,
    computeOpenClawAgentMetrics: async () => ({
      hardMetrics: createHardMetrics(),
    }),
  } as unknown as AgentAnalysisStore;
}

function createAnalysisJob(payloadPatch: Record<string, unknown> = {}): OperationJobRow {
  return {
    attemptCount: 1,
    createdAt: new Date("2026-06-03T07:59:00.000Z"),
    id: "opjob_analysis",
    maxAttempts: 3,
    operationId: "op_analysis",
    organizationId: "org_1",
    payload: {
      agentId: "fixture-mac:runtime:openclaw:agent:main",
      deadlineAt: "2026-06-03T08:05:00.000Z",
      deviceId: "fixture-mac",
      nonce: "analysis_nonce",
      openclawAgentId: "main",
      periodEnd: "2026-06-02T16:00:00.000Z",
      periodStart: "2026-06-01T16:00:00.000Z",
      promptKind: "daily_operation_review",
      promptVersion: "openclaw-agent-operation-analysis-v2",
      runtimeId: "fixture-mac:runtime:openclaw",
      runtimeKind: "openclaw",
      timeoutSeconds: 300,
      ...payloadPatch,
    },
    runAfter: new Date("2026-06-03T08:00:00.000Z"),
    startedAt: new Date("2026-06-03T08:00:00.000Z"),
    status: "running",
    type: "agent_analysis_openclaw",
    updatedAt: new Date("2026-06-03T08:00:00.000Z"),
  };
}

function createHardMetrics() {
  return {
    duration: {
      avgMs: 120_000,
      basis: "trajectoryElapsed" as const,
      includedStatuses: ["done", "failed"] as const,
      p50Ms: 120_000,
      p90Ms: 120_000,
      sampleCount: 1,
    },
    failedCount: 0,
    periodEnd: "2026-06-02T16:00:00.000Z",
    periodStart: "2026-06-01T16:00:00.000Z",
    statusCounts: { done: 1, total: 1 },
    taskTypeCounts: { conversation: 1 },
    totalTasks: 1,
    unknownCount: 0,
  };
}
