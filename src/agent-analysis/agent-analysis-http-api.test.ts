import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthSessionContext } from "../auth/auth-store";
import type { AgentAnalysisStore } from "./agent-analysis-store";
import type { OperationRow, OperationStore } from "../operations/operation-store";
import { createAgentAnalysisHttpApiHandler } from "./agent-analysis-http-api";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe("agent analysis HTTP API", () => {
  it("creates an OpenClaw main Agent analysis Operation and Job", async () => {
    const calls: unknown[] = [];
    const operation = createOperation();
    const api = await startApi({
      agentAnalysisStore: {
        readOpenClawAgentTarget: async (input: Parameters<AgentAnalysisStore["readOpenClawAgentTarget"]>[0]) => {
          calls.push({ readTarget: input });
          return {
            agentId: "fixture-mac:runtime:openclaw:agent:main",
            agentName: "main",
            deviceId: "fixture-mac",
            openclawAgentId: "main",
            organizationId: "org_1",
            runtimeId: "fixture-mac:runtime:openclaw",
            runtimeKind: "openclaw",
          };
        },
      } as unknown as AgentAnalysisStore,
      operationStore: {
        createOperation: async (input: Parameters<OperationStore["createOperation"]>[0]) => {
          calls.push({ createOperation: input });
          return operation;
        },
        enqueueJob: async (input: Parameters<OperationStore["enqueueJob"]>[0]) => {
          calls.push({ enqueueJob: input });
          return {} as never;
        },
      } as unknown as OperationStore,
      session: createSession(),
    });

    const response = await fetch(`${api.url}/api/agent-analysis-runs`, {
      body: JSON.stringify({ agentId: "fixture-mac:runtime:openclaw:agent:main" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      operation: { id: "op_analysis", type: "agent_analysis" },
    });
    expect(calls).toEqual([
      { readTarget: { agentId: "fixture-mac:runtime:openclaw:agent:main", organizationId: "org_1" } },
      {
        createOperation: expect.objectContaining({
          organizationId: "org_1",
          resourceId: "fixture-mac:runtime:openclaw:agent:main",
          resourceType: "agent",
          targetId: "fixture-mac",
          targetType: "device",
          type: "agent_analysis",
        }),
      },
      {
        enqueueJob: expect.objectContaining({
          organizationId: "org_1",
          operationId: "op_analysis",
          type: "agent_analysis_openclaw",
          payload: expect.objectContaining({
            agentId: "fixture-mac:runtime:openclaw:agent:main",
            openclawAgentId: "main",
            periodEnd: expect.any(String),
            periodStart: expect.any(String),
            promptKind: "daily_operation_review",
            runtimeKind: "openclaw",
            timeoutSeconds: 600,
            deadlineAt: expect.any(String),
          }),
        }),
      },
    ]);
  });

  it("lists and reads member-visible Agent analysis reports", async () => {
    const report = createReport();
    const api = await startApi({
      agentAnalysisStore: {
        listReports: async () => [report],
        readReport: async ({ reportId }: Parameters<AgentAnalysisStore["readReport"]>[0]) => reportId === report.id ? report : null,
      } as unknown as AgentAnalysisStore,
      operationStore: {} as OperationStore,
      session: createSession(),
    });

    const listResponse = await fetch(`${api.url}/api/agent-analysis-reports?organizationId=org_1&agentId=fixture-mac%3Aruntime%3Aopenclaw%3Aagent%3Amain`);
    const detailResponse = await fetch(`${api.url}/api/agent-analysis-reports/agr_1?organizationId=org_1`);
    const forbiddenResponse = await fetch(`${api.url}/api/agent-analysis-reports?organizationId=org_2`);

    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(forbiddenResponse.status).toBe(403);
    await expect(listResponse.json()).resolves.toMatchObject({
      reports: [expect.objectContaining({ id: "agr_1" })],
    });
    await expect(detailResponse.json()).resolves.toMatchObject({
      report: expect.objectContaining({ id: "agr_1" }),
    });
  });
});

function createOperation(): OperationRow {
  const now = new Date("2026-06-03T08:00:00.000Z");
  return {
    createdAt: now,
    errorSummary: null,
    finishedAt: null,
    id: "op_analysis",
    manualInstruction: null,
    metadata: {},
    organizationId: "org_1",
    requestedByUserId: "user_1",
    resourceId: "fixture-mac:runtime:openclaw:agent:main",
    resourceType: "agent",
    startedAt: null,
    status: "queued",
    summary: "Analyze OpenClaw Agent daily operation",
    targetId: "fixture-mac",
    targetType: "device",
    type: "agent_analysis",
    updatedAt: now,
  };
}

function createReport() {
  return {
    agentId: "fixture-mac:runtime:openclaw:agent:main",
    analysis: {
      periodPerformance: {
        completion: "多数任务完成。",
        failurePattern: "暂无明显重复失败。",
        latency: "耗时稳定。",
        workload: "队列整理占主导。",
      },
      taskTypes: [{
        cases: [{
          id: "task_1",
          outcome: "完成队列整理。",
          reason: "代表本周期主要任务。",
          signal: "positive",
          title: "队列整理",
        }],
        countEstimate: 1,
        description: "整理队列任务并输出结论。",
        label: "队列整理",
        satisfaction: {
          evidenceIds: ["task_1"],
          level: "positive",
          reason: "用户确认结果可用。",
        },
      }],
      risks: [],
      actions: [{
        evidenceIds: ["task_1"],
        reason: "将稳定流程沉淀为模板。",
        title: "沉淀任务模板",
      }],
    },
    createdAt: new Date("2026-06-03T08:02:00.000Z"),
    deviceId: "fixture-mac",
    hardMetrics: {
      duration: {
        basis: "trajectoryElapsed",
        includedStatuses: ["done", "failed"],
        sampleCount: 1,
      },
      failedCount: 0,
      periodEnd: "2026-06-02T16:00:00.000Z",
      periodStart: "2026-06-01T16:00:00.000Z",
      statusCounts: { done: 1, total: 1 },
      taskTypeCounts: { conversation: 1 },
      totalTasks: 1,
      unknownCount: 0,
    },
    id: "agr_1",
    modelMetadata: { model: "gpt-test" },
    operationId: "op_analysis",
    organizationId: "org_1",
    periodEnd: new Date("2026-06-02T16:00:00.000Z"),
    periodStart: new Date("2026-06-01T16:00:00.000Z"),
    promptKind: "daily_operation_review",
    promptVersion: "openclaw-agent-operation-analysis-v2",
    runtimeId: "fixture-mac:runtime:openclaw",
    runtimeKind: "openclaw",
  };
}

function createSession(): AuthSessionContext {
  const now = new Date("2026-06-03T08:00:00.000Z");
  return {
    id: "session_1",
    organizations: [{
      id: "membership_1",
      name: "Lorume Team",
      organizationId: "org_1",
      role: "owner",
      slug: "lorume-team",
    }],
    user: {
      createdAt: now,
      displayName: null,
      email: "owner@example.com",
      id: "user_1",
      updatedAt: now,
    },
  };
}

async function startApi(options: {
  agentAnalysisStore: AgentAnalysisStore;
  operationStore: OperationStore;
  session: AuthSessionContext | null;
}) {
  const handler = createAgentAnalysisHttpApiHandler({
    agentAnalysisStore: options.agentAnalysisStore,
    operationStore: options.operationStore,
    requireUserSession: async () => options.session,
    now: () => new Date("2026-06-03T08:00:00.000Z"),
  });
  const server = createServer((request, response) => {
    void handler(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const api = {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    url: `http://127.0.0.1:${address.port}`,
  };
  servers.push(api);
  return api;
}
