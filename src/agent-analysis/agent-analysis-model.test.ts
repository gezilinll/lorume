import { describe, expect, it } from "vitest";
import {
  buildAgentAnalysisPrompt,
  computeOpenClawHardMetrics,
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

  it("builds a JSON-only OpenClaw analysis prompt with hard metrics and sampled Task evidence", () => {
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
      promptVersion: "openclaw-agent-analysis-v1",
      sampledTasks: [
        {
          id: "task_done",
          status: "done",
          taskType: "conversation",
          updatedSourceAt: "2026-06-01T18:02:00.000Z",
          userMessage: "Summarize yesterday's queue.",
        },
      ],
    });

    expect(prompt).toContain("\"hardMetrics\"");
    expect(prompt).toContain("\"task_done\"");
    expect(prompt).toContain("\"schemaVersion\": \"agent-analysis-v1\"");
    expect(prompt).not.toContain("\"satisfaction\"");
    expect(prompt).not.toContain("\"satisfactionScore\"");
  });

  it("validates raw agent JSON and rejects markdown, satisfaction fields, and unknown Task evidence", () => {
    const valid = validateAgentAnalysisText(JSON.stringify({
      schemaVersion: "agent-analysis-v1",
      promptKind: "daily_operation_review",
      summary: "The day was dominated by queue triage.",
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
          whyTypical: "Matches the main observed pattern.",
          outcome: "Completed",
          status: "done",
          evidence: "Task summary mentions queue triage.",
        },
      ],
      risks: [],
      dataQualityNotes: ["Only sampled tasks were reviewed."],
    }), { allowedTaskIds: new Set(["task_done"]) });

    expect(valid.ok).toBe(true);
    expect(validateAgentAnalysisText("```json\n{}\n```", { allowedTaskIds: new Set() })).toMatchObject({
      ok: false,
    });
    expect(validateAgentAnalysisText(JSON.stringify({
      schemaVersion: "agent-analysis-v1",
      promptKind: "daily_operation_review",
      summary: "Contains an unsupported estimate.",
      satisfactionScore: 0.9,
      taskTypeBreakdown: [],
      typicalCases: [],
      risks: [],
      dataQualityNotes: [],
    }), { allowedTaskIds: new Set() })).toMatchObject({ ok: false });
    expect(validateAgentAnalysisText(JSON.stringify({
      schemaVersion: "agent-analysis-v1",
      promptKind: "daily_operation_review",
      summary: "References a task that was not sampled.",
      taskTypeBreakdown: [],
      typicalCases: [
        {
          taskId: "task_missing",
          title: "Missing",
          whyTypical: "No evidence.",
          outcome: "Unknown",
          status: "unknown",
          evidence: "No evidence.",
        },
      ],
      risks: [],
      dataQualityNotes: [],
    }), { allowedTaskIds: new Set(["task_done"]) })).toMatchObject({ ok: false });
  });
});
