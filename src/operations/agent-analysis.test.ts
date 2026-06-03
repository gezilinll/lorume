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
      promptVersion: "openclaw-agent-analysis-v1",
      runtimeId: "fixture-mac:runtime:openclaw",
      timeoutSeconds: 120,
    });
    expect(requests[0]?.prompt).toContain("\"hardMetrics\"");
    expect(requests[0]?.prompt).not.toContain("--deliver");
    expect(payloadPatches[0]).toMatchObject({
      allowedTaskIds: ["task_done"],
      dispatchedAt: "2026-06-03T08:00:00.000Z",
      promptVersion: "openclaw-agent-analysis-v1",
      stage: "dispatched",
      status: "running",
    });
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
          allowedTaskIds: ["task_done"],
          hardMetrics: createHardMetrics(),
          promptVersion: "openclaw-agent-analysis-v1",
          stage: "dispatched",
          status: "running",
        })],
      } as unknown as OperationStore,
    }, {
      analysis: {
        schemaVersion: "agent-analysis-v1",
        promptKind: "daily_operation_review",
        summary: "Queue triage dominated the day.",
        taskTypeBreakdown: [
          {
            type: "triage",
            label: "Triage",
            countEstimate: 1,
            confidence: "high",
            evidenceTaskIds: ["task_done"],
          },
        ],
        typicalCases: [
          {
            taskId: "task_done",
            title: "Queue triage",
            whyTypical: "It reflects the main work pattern.",
            outcome: "Completed",
            status: "done",
            evidence: "The sampled task asks for queue summarization.",
          },
        ],
        risks: [],
        dataQualityNotes: ["Only sampled tasks were reviewed."],
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
      sampledTasks: [
        {
          id: "task_done",
          status: "done",
          taskType: "conversation",
          updatedSourceAt: "2026-06-01T18:02:00.000Z",
          userMessage: "Summarize the queue.",
        },
      ],
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
      runtimeId: "fixture-mac:runtime:openclaw",
      runtimeKind: "openclaw",
      timeoutSeconds: 120,
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
