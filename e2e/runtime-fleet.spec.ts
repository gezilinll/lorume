import { expect, test, type APIRequestContext } from "@playwright/test";
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

const backendDeviceState: DeviceStateSnapshot = {
  agents: fixture.agents,
  collectedAt: fixture.collectedAt,
  device: fixture.devices[0],
  runtimes: fixture.runtimes,
  tasks: fixture.tasks,
};

test.describe("Runtime Fleet", () => {
  test.beforeEach(async () => {
    await resetE2eDatabase();
  });

  test("opens agent details and stays responsive without a filter toolbar", async ({ page, request }) => {
    await seedRuntimeFleetData(request);
    const skillProbeResponse = await request.post("/api/runtime-skill-probe-snapshots", {
      data: {
        deviceId: "fixture-mac",
        runtimeId: "fixture-mac:runtime:openclaw",
        runtimeKind: "openclaw",
        status: "succeeded",
        observedAt: "2026-05-18T10:00:00.000Z",
        skills: [
          {
            name: "browser",
            description: "Browser automation for local targets.",
            scope: "runtime",
            available: true,
            builtIn: true,
            agentIds: [],
          },
          {
            name: "reviewer",
            description: "Review local metadata without exposing file paths.",
            scope: "agent",
            available: true,
            builtIn: false,
            agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
          },
          {
            name: "weather",
            description: "Runtime-level weather query.",
            scope: "runtime",
            available: false,
            builtIn: false,
            agentIds: [],
          },
        ],
      },
    });
    expect(skillProbeResponse.ok()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: "Runtime Fleet" }).click();
    await expect(page.getByRole("heading", { name: "运行资产" })).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新" })).toBeVisible();
    await expect(page.getByLabel("设备").getByRole("button", { name: /fixture-mac fixture-mac\.local/ })).toBeVisible();
    await expect(page.getByRole("table", { name: "Runtime 列表" })).toContainText("OpenClaw Gateway");
    await expect(page.getByRole("table", { name: "Runtime 列表" })).toContainText("状态");
    await expect(page.getByRole("table", { name: "Runtime 列表" })).toContainText("在线");
    await expect(page.getByRole("table", { name: "Runtime 列表" })).not.toContainText("工作中");
    await expect(page.getByRole("table", { name: "Runtime 列表" }).getByRole("columnheader", { name: "Runtime" })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Agent 列表" })).toContainText("main");
    await expect(page.getByRole("row", { name: /main/ })).toContainText("在线");
    await expect(page.getByRole("table", { name: "Runtime 列表" })).toContainText("所属设备");
    await expect(page.getByRole("table", { name: "Agent 列表" })).toContainText("归属 Runtime");
    await expect(page.getByRole("table", { name: "Agent 列表" })).toContainText("最近活跃");
    await expect(page.getByRole("table", { name: "Agent 列表" })).toContainText("Skill");
    await expect(page.getByLabel("运行资产筛选")).toHaveCount(0);
    await expect(page.getByPlaceholder("搜索设备、Runtime、Agent 或任务")).toHaveCount(0);
    await expect(page.getByLabel("Channel")).toHaveCount(0);
    await expect(page.getByLabel("同步时间")).toHaveCount(0);
    await expect(page.getByLabel("可用性")).toHaveCount(0);

    await page.getByRole("row", { name: /main/ }).click();
    const detail = page.getByRole("complementary", { name: "运行资产详情" });
    await expect(detail).toHaveCSS("position", "sticky");
    const runtimeDetailTop = await detail.evaluate((node) => Number.parseFloat(getComputedStyle(node).top));
    expect(runtimeDetailTop).toBeGreaterThanOrEqual(70);
    await expect(detail).toContainText("归属关系");
    await expect(detail).toContainText("状态: 在线");
    await expect(detail).toContainText("所属 Runtime: OpenClaw Gateway");
    await expect(detail).toContainText("任务统计");
    await expect(detail).toContainText("全部任务: 2");
    await expect(detail).not.toContainText("关联渠道");
    await expect(detail).toContainText("最近活跃:");
    await page.getByRole("button", { name: "main Skill" }).click();
    await expect(page).toHaveURL(/\/skills\?runtimeId=fixture-mac%3Aruntime%3Aopenclaw&agentId=fixture-mac%3Aruntime%3Aopenclaw%3Aagent%3Amain/);
    await expect(page.getByRole("heading", { name: "Skill 仓库" })).toBeVisible();
    await expect(page.getByRole("button", { name: "2 个筛选" })).toBeVisible();
    const skillTable = page.getByRole("table", { name: "Skill 列表" });
    await expect(skillTable).toContainText("browser");
    await expect(skillTable).toContainText("reviewer");
    await expect(skillTable).toContainText("Runtime");
    await expect(skillTable).toContainText("Agent");
    await expect(skillTable).not.toContainText("weather");
    const skillDetail = page.getByRole("complementary", { name: "Skill 详情" });
    const skillDetailTop = await skillDetail.evaluate((node) => Number.parseFloat(getComputedStyle(node).top));
    expect(skillDetailTop).toBeGreaterThanOrEqual(70);
    await expect(skillDetail).toContainText("可用 Agent");
    await expect(skillDetail).toContainText("main");
    await expect(skillDetail).not.toContainText("/Users/example/.codex/skills/reviewer");
    const skillPageOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(skillPageOverflows).toBe(false);

    await page.getByRole("button", { name: "Runtime Fleet" }).click();
    await expect(page.getByRole("heading", { name: "运行资产" })).toBeVisible();

    const sideNavPosition = await page
      .getByRole("navigation", { name: "主导航" })
      .evaluate((node) => getComputedStyle(node.closest('[data-slot="sidebar-container"]') ?? node).position);
    expect(sideNavPosition).toBe("fixed");

    await expect(page.getByRole("button", { name: "请求设备刷新" })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "运行资产" })).toBeVisible();

    const pageOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(pageOverflows).toBe(false);
  });

  test("keeps Runtime Fleet content within the viewport on laptop widths", async ({ page, request }) => {
    await seedRuntimeFleetData(request);

    await page.setViewportSize({ width: 1185, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Runtime Fleet" }).click();
    await expect(page.getByRole("heading", { name: "运行资产" })).toBeVisible();

    const pageOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(pageOverflows).toBe(false);
  });
});

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
