import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceStateSnapshot } from "../src/runtime/runtime-model";
import { createRuntimeTaskBatches } from "../src/runtime/runtime-task-sync";
import { resetE2eDatabase } from "./db";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  readFileSync(path.join(repoRoot, "fixtures", "runtime", "runtime-fleet-device-state.sample.json"), "utf8"),
) as {
  agents: DeviceStateSnapshot["agents"];
  collectedAt: string;
  devices: DeviceStateSnapshot["device"][];
  runtimes: DeviceStateSnapshot["runtimes"];
  tasks: DeviceStateSnapshot["tasks"];
};

const defaultAgentId = fixture.agents[0].id;
const defaultDeviceId = fixture.devices[0].id;
const defaultRuntimeId = fixture.runtimes[0].id;

const backendDeviceState: DeviceStateSnapshot = {
  agents: fixture.agents,
  collectedAt: fixture.collectedAt,
  device: fixture.devices[0],
  runtimes: fixture.runtimes,
  tasks: fixture.tasks,
};

test.describe("Agent 看板", () => {
  test.beforeEach(async () => {
    await resetE2eDatabase();
  });

  test("shows OpenClaw analysis reports, operation progress, and responsive layout", async ({ page, request }) => {
    await seedRuntimeFleetData(request);
    await mockAgentAnalysisApis(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Agent 看板" }).click();

    await expect(page).toHaveURL(/\/agent-dashboard$/);
    await expect(page.getByRole("heading", { name: "Agent 看板" })).toBeVisible();
    await expect(page.getByText("Queue triage dominated the day.")).toBeVisible();
    await expect(page.getByText("系统计算").first()).toBeVisible();
    await expect(page.getByText("Agent 自评").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "任务类型归纳" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "典型案例" })).toBeVisible();
    await expect(page.getByText("结果证据不足")).toBeVisible();
    await expect(page.getByText("Agent 自评只基于 prompt 样本。")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("satisfactionScore");
    await expect(page.locator("body")).not.toContainText("nonce");
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "任务中心" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "通知中心" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "运行分析" }).click();
    await expect(page.getByRole("complementary", { name: "报告和任务状态" })).toContainText("执行中");
    await expect(page.getByRole("complementary", { name: "报告和任务状态" })).toContainText("fake collector executing analysis");

    await page.getByRole("button", { name: "Runtime Fleet" }).click();
    await page.getByRole("row", { name: /main/ }).getByRole("button", { name: "查看看板" }).click();
    await expect(page).toHaveURL(new RegExp(`/agent-dashboard\\?agentId=${encodeURIComponent(defaultAgentId)}`));
    await expect(page.getByRole("heading", { name: "Agent 看板" })).toBeVisible();

    for (const size of [
      { width: 1185, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await expect(page.getByRole("heading", { name: "Agent 看板" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});

async function mockAgentAnalysisApis(page: Page): Promise<void> {
  await page.route("**/api/agent-analysis-reports**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { reports: [agentAnalysisReportResponse()] },
    });
  });
  await page.route("**/api/agent-analysis-runs**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        job: operationJobResponse({ stage: "accepted", message: "fake collector accepted request" }),
        operation: operationResponse("running"),
      },
    });
  });
  await page.route("**/api/operations/operation_e2e_2**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        jobs: [operationJobResponse({ stage: "executing", message: "fake collector executing analysis" })],
        operation: operationResponse("running"),
      },
    });
  });
}

function agentAnalysisReportResponse() {
  return {
    agentId: defaultAgentId,
    analysis: {
      schemaVersion: "agent-analysis-v1",
      promptKind: "daily_operation_review",
      summary: "Queue triage dominated the day.",
      taskTypeBreakdown: [
        {
          confidence: "high",
          countEstimate: 2,
          evidenceTaskIds: [fixture.tasks[0].id],
          label: "需求澄清",
          type: "conversation",
        },
      ],
      typicalCases: [
        {
          evidence: "The sampled task requested implementation and validation.",
          outcome: "Delivered a reviewed implementation path.",
          status: "done",
          taskId: fixture.tasks[0].id,
          title: "Collector upgrade analysis",
          whyTypical: "Combines planning, backend work, and validation.",
        },
      ],
      risks: [
        {
          description: "Some sampled tasks have limited result evidence.",
          evidenceTaskIds: [fixture.tasks[0].id],
          severity: "medium",
          title: "结果证据不足",
        },
      ],
      dataQualityNotes: ["Agent 自评只基于 prompt 样本。"],
      satisfactionScore: 97,
    },
    createdAt: "2026-06-03T08:20:00.000Z",
    deviceId: defaultDeviceId,
    hardMetrics: {
      duration: {
        basis: "trajectoryElapsed",
        includedStatuses: ["done", "failed"],
        sampleCount: 2,
        avgMs: 120000,
        p50Ms: 90000,
        p90Ms: 240000,
      },
      failedCount: 1,
      lastActiveAt: "2026-06-03T07:55:00.000Z",
      periodEnd: "2026-06-03T16:00:00.000Z",
      periodStart: "2026-06-02T16:00:00.000Z",
      statusCounts: { done: 1, failed: 1, unknown: 0, cancelled: 0 },
      taskTypeCounts: { conversation: 2 },
      totalTasks: 2,
      unknownCount: 0,
    },
    id: "report_e2e_1",
    modelMetadata: {
      model: "gpt-5-mini",
      provider: "openai",
      usage: { input: 1000, output: 300, total: 1300 },
    },
    operationId: "operation_e2e_1",
    organizationId: "agent-local-organization",
    periodEnd: "2026-06-03T16:00:00.000Z",
    periodStart: "2026-06-02T16:00:00.000Z",
    promptKind: "daily_operation_review",
    promptVersion: "openclaw-agent-analysis-v1",
    runtimeId: defaultRuntimeId,
    runtimeKind: "openclaw",
  };
}

function operationResponse(status: "running" | "succeeded" | "failed") {
  return {
    createdAt: "2026-06-03T08:21:00.000Z",
    id: "operation_e2e_2",
    resourceId: defaultAgentId,
    resourceType: "agent",
    status,
    summary: "Agent analysis",
    targetId: defaultDeviceId,
    targetType: "device",
    type: "agent_analysis",
    updatedAt: "2026-06-03T08:21:08.000Z",
  };
}

function operationJobResponse(payload: { message: string; stage: string }) {
  return {
    createdAt: "2026-06-03T08:21:00.000Z",
    id: "job_e2e_1",
    operationId: "operation_e2e_2",
    payload,
    status: "running",
    type: "agent_analysis_openclaw",
    updatedAt: "2026-06-03T08:21:08.000Z",
  };
}

async function seedRuntimeFleetData(request: APIRequestContext): Promise<void> {
  const seedResponse = await request.post("/api/device-state-snapshots", {
    data: { ...backendDeviceState, tasks: [] },
  });
  expect(seedResponse.ok()).toBe(true);
  for (const batch of createRuntimeTaskBatches(backendDeviceState.tasks, {
    batchMaxBytes: 1_000_000,
    batchMaxTasks: 1_000,
    collectedAt: backendDeviceState.collectedAt,
    deviceId: backendDeviceState.device.id,
  })) {
    const batchResponse = await request.post("/api/device-task-batches", { data: batch });
    expect(batchResponse.ok()).toBe(true);
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const pageOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(pageOverflows).toBe(false);
}
