import { describe, expect, it } from "vitest";
import { createPostgresAuthStore } from "../auth/auth-store";
import { createPostgresOperationStore } from "../operations/operation-store";
import { createDeviceStateSnapshot } from "../runtime/runtime-model";
import { createRuntimeTaskBatches } from "../runtime/runtime-task-sync";
import { createPostgresStore } from "../server/postgres-store";
import { createTemporaryPostgresDatabase, runDatabaseSchemaScript, shouldRunPostgresTests } from "../test/postgres";
import { createPostgresAgentAnalysisStore, type AgentAnalysisStore } from "./agent-analysis-store";

const describeDb = shouldRunPostgresTests() ? describe : describe.skip;

describeDb("Postgres agent analysis store", () => {
  it("reads organization-owned OpenClaw main targets, computes metrics, and upserts reports idempotently", async () => {
    const database = await createTemporaryPostgresDatabase();
    try {
      runDatabaseSchemaScript(database.url);
      const authStore = createPostgresAuthStore({ connectionString: database.url });
      const runtimeStore = createPostgresStore({ connectionString: database.url });
      const operationStore = createPostgresOperationStore({ connectionString: database.url });
      const analysisStore = createPostgresAgentAnalysisStore({ connectionString: database.url });
      try {
        const user = await authStore.upsertUserForEmail("agent-analysis@example.com");
        const organization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Agent Analysis Team",
          slug: "agent-analysis-team",
        });
        const otherOrganization = await authStore.createOrganization({
          createdByUserId: user.id,
          name: "Other Team",
          slug: "other-agent-analysis-team",
        });
        const snapshot = createAnalysisSnapshot();
        await runtimeStore.upsertDeviceStateSnapshot({ ...snapshot, tasks: [] }, { organizationId: organization.id });
        const batches = createRuntimeTaskBatches(snapshot.tasks, {
          batchMaxBytes: 1_000_000,
          batchMaxTasks: 100,
          collectedAt: snapshot.collectedAt,
          deviceId: snapshot.device.id,
        });
        await runtimeStore.upsertRuntimeTaskBatch(batches[0]!, { organizationId: organization.id });

        await expect(analysisStore.readOpenClawAgentTarget({
          agentId: "fixture-mac:runtime:openclaw:agent:main",
          organizationId: organization.id,
        })).resolves.toMatchObject({
          agentId: "fixture-mac:runtime:openclaw:agent:main",
          deviceId: "fixture-mac",
          openclawAgentId: "main",
          runtimeId: "fixture-mac:runtime:openclaw",
          runtimeKind: "openclaw",
        });
        await expect(analysisStore.readOpenClawAgentTarget({
          agentId: "fixture-mac:runtime:openclaw:agent:main",
          organizationId: otherOrganization.id,
        })).resolves.toBeNull();

        const metrics = await analysisStore.computeOpenClawAgentMetrics({
          agentId: "fixture-mac:runtime:openclaw:agent:main",
          organizationId: organization.id,
          periodEnd: "2026-06-02T16:00:00.000Z",
          periodStart: "2026-06-01T16:00:00.000Z",
        });

        expect(metrics.hardMetrics).toMatchObject({
          duration: { avgMs: 240_000, p50Ms: 120_000, p90Ms: 360_000, sampleCount: 2 },
          failedCount: 1,
          statusCounts: { done: 1, failed: 1, in_progress: 1, total: 3 },
          taskTypeCounts: { conversation: 2, scheduled: 1 },
          totalTasks: 3,
        });
        const operation = await operationStore.createOperation({
          organizationId: organization.id,
          resourceId: "fixture-mac:runtime:openclaw:agent:main",
          resourceType: "agent",
          summary: "Analyze OpenClaw Agent daily operation",
          targetId: "fixture-mac",
          targetType: "device",
          type: "agent_analysis",
        });
        const reportInput: Parameters<AgentAnalysisStore["upsertReport"]>[0] = {
          agentId: "fixture-mac:runtime:openclaw:agent:main",
          analysis: {
            periodPerformance: {
              completion: "多数任务完成。",
              failurePattern: "少量工具失败需要关注。",
              latency: "耗时集中在数分钟内。",
              workload: "队列整理是主要工作。",
            },
            taskTypes: [{
              cases: [{
                id: "fixture-mac:runtime:openclaw:agent:main:task:done",
                outcome: "完成队列总结。",
                reason: "能代表本周期常见整理需求。",
                signal: "positive",
                title: "队列总结",
              }],
              countEstimate: 1,
              description: "整理和总结队列中的任务。",
              label: "队列整理",
              satisfaction: {
                evidenceIds: ["fixture-mac:runtime:openclaw:agent:main:task:done"],
                level: "positive",
                reason: "任务顺利完成并得到确认。",
              },
            }],
            risks: [],
            actions: [{
              evidenceIds: ["fixture-mac:runtime:openclaw:agent:main:task:done"],
              reason: "常见整理任务可沉淀复用流程。",
              title: "沉淀队列整理流程",
            }],
          },
          deviceId: "fixture-mac",
          hardMetrics: metrics.hardMetrics,
          modelMetadata: { model: "gpt-test", provider: "openai" },
          operationId: operation.id,
          organizationId: organization.id,
          periodEnd: "2026-06-02T16:00:00.000Z",
          periodStart: "2026-06-01T16:00:00.000Z",
          promptKind: "daily_operation_review",
          promptVersion: "openclaw-agent-operation-analysis-v2",
          runtimeId: "fixture-mac:runtime:openclaw",
          runtimeKind: "openclaw",
        };
        const firstReport = await analysisStore.upsertReport(reportInput);
        const duplicateReport = await analysisStore.upsertReport(reportInput);

        expect(duplicateReport.id).toBe(firstReport.id);
        await expect(analysisStore.listReports({
          agentId: "fixture-mac:runtime:openclaw:agent:main",
          limit: 10,
          organizationId: organization.id,
        })).resolves.toHaveLength(1);
        await expect(analysisStore.readReport({
          reportId: firstReport.id,
          organizationId: otherOrganization.id,
        })).resolves.toBeNull();
      } finally {
        await Promise.all([
          analysisStore.close(),
          authStore.close(),
          operationStore.close(),
          runtimeStore.close(),
        ]);
      }
    } finally {
      await database.drop();
    }
  });
});

function createAnalysisSnapshot() {
  const agentId = "fixture-mac:runtime:openclaw:agent:main";
  return createDeviceStateSnapshot({
    collectedAt: "2026-06-02T16:05:00.000Z",
    device: {
      id: "fixture-mac",
      hostname: "fixture-mac.local",
      os: "darwin",
      collectionStatus: "online",
    },
    runtimes: [
      {
        id: "fixture-mac:runtime:openclaw",
        deviceId: "fixture-mac",
        kind: "openclaw",
        name: "OpenClaw",
        collectionStatus: "online",
      },
    ],
    agents: [
      {
        id: agentId,
        runtimeId: "fixture-mac:runtime:openclaw",
        name: "main",
        collectionStatus: "online",
      },
    ],
    tasks: [
      {
        id: `${agentId}:task:done`,
        agentId,
        taskType: "conversation",
        status: "done",
        adapter: { kind: "openclaw" },
        userMessage: "Summarize the queue.",
        agentReply: "Done.",
        createdAt: "2026-06-01T18:00:00.000Z",
        updatedAt: "2026-06-01T18:02:00.000Z",
      },
      {
        id: `${agentId}:task:failed`,
        agentId,
        taskType: "conversation",
        status: "failed",
        adapter: { kind: "openclaw" },
        userMessage: "Investigate a failure.",
        error: "Tool failed",
        createdAt: "2026-06-01T19:00:00.000Z",
        updatedAt: "2026-06-01T19:06:00.000Z",
      },
      {
        id: `${agentId}:task:running`,
        agentId,
        taskType: "scheduled",
        status: "in_progress",
        adapter: { kind: "openclaw" },
        userMessage: "Run scheduled review.",
        createdAt: "2026-06-01T20:00:00.000Z",
        updatedAt: "2026-06-01T20:10:00.000Z",
      },
      {
        id: `${agentId}:task:out-of-period`,
        agentId,
        taskType: "conversation",
        status: "done",
        adapter: { kind: "openclaw" },
        createdAt: "2026-05-31T18:00:00.000Z",
        updatedAt: "2026-05-31T18:02:00.000Z",
      },
    ],
  });
}
