import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceStateSnapshot, Task } from "../src/runtime/runtime-model";
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
const rawDingTalkCid = "cid-private-raw-123";
const reviewTask: Task = {
  ...fixture.tasks[0],
  conversation: {
    ...(fixture.tasks[0].conversation ?? {}),
    externalId: rawDingTalkCid,
  },
  updatedAt: "2026-05-09T15:50:00.000Z",
};
const runningTask: Task = {
  ...fixture.tasks[1],
  updatedAt: "2026-05-09T15:59:00.000Z",
};
const longTask: Task = {
  agentId: defaultAgentId,
  assignee: { name: "main" },
  adapter: { kind: "openclaw" },
  channel: { kind: "dingtalk" },
  conversation: { title: "DingTalk 群聊", lastActivityAt: "2026-05-09T15:55:00.000Z" },
  creator: { name: "AjiHuang" },
  id: `${defaultAgentId}:task:merge-request-184`,
  status: "done",
  taskType: "conversation",
  updatedAt: "2026-05-09T15:55:00.000Z",
  userMessage: "https://git.intra.gaoding.com/gdesign/meta/-/merge_requests/184 让大卷执行review，如果有问题让codex继续修复并回报结果",
};

const backendDeviceState: DeviceStateSnapshot = {
  agents: fixture.agents,
  collectedAt: "2026-05-09T16:00:00.000Z",
  device: fixture.devices[0],
  runtimes: fixture.runtimes,
  tasks: [reviewTask, runningTask, longTask],
};

test.describe("Runs conversation tasks", () => {
  test.beforeEach(async () => {
    await resetE2eDatabase();
  });

  test("filters OpenClaw tasks by task context, opens details, and stays responsive", async ({ page, request }) => {
    await seedWorkBoardData(request, backendDeviceState);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "Runs" }).click();

    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    await expect(page.getByText("查看 Agent 承接的会话任务、发起人、Channel、会话/群组、消息摘要和当前状态。")).toBeVisible();
    for (const lane of ["待处理", "进行中", "待验收", "已完成", "阻塞", "失败", "已取消", "未知"]) {
      await expect(page.getByRole("heading", { name: lane })).toBeVisible();
    }
    await expect(page.getByRole("combobox", { name: "渠道" })).toContainText("全部");
    await page.getByRole("combobox", { name: "渠道" }).click();
    await expect(page.getByRole("option", { name: "DingTalk（3）" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tab", { name: "全部" })).toHaveAttribute("data-state", "active");
    await expect(page.getByLabel("开始时间")).toHaveCount(1);
    await expect(page.getByLabel("结束时间")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /选择时间范围/ })).toHaveCount(0);

    const searchBox = await page.getByPlaceholder("搜索任务、消息、发起人、Agent 或会话/群组").boundingBox();
    const startBox = await page.getByLabel("开始时间").boundingBox();
    const endBox = await page.getByLabel("结束时间").boundingBox();
    expect(searchBox?.width ?? 0).toBeLessThan(620);
    expect(searchBox?.width ?? 0).toBeGreaterThan(300);
    expect(endBox?.x ?? 0).toBeGreaterThan(startBox?.x ?? 0);

    await expect(page.getByRole("button", { name: /PMO asked OpenClaw/ })).toBeVisible();
    await page.getByRole("tab", { name: "待处理" }).click();
    await expect(page.getByRole("button", { name: /PMO asked OpenClaw/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Execute OpenClaw run/ })).not.toBeVisible();
    await page.getByRole("tab", { name: "全部" }).click();

    await page.getByLabel("开始时间").fill("2026-05-08T00:00");
    await page.getByLabel("结束时间").fill("2026-05-10T23:59");
    await expect(page.getByRole("button", { name: /PMO asked OpenClaw/ })).toBeVisible();
    await page.getByLabel("开始时间").fill("2026-05-10T00:00");
    await page.getByLabel("结束时间").fill("2026-05-10T23:59");
    await expect(page.getByRole("button", { name: /PMO asked OpenClaw/ })).not.toBeVisible();
    await page.getByLabel("开始时间").fill("");
    await page.getByLabel("结束时间").fill("");

    await page.getByPlaceholder("搜索任务、消息、发起人、Agent 或会话/群组").fill("PMO");
    const reviewCard = page.getByRole("button", { name: /PMO asked OpenClaw/ });
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard).toContainText("待处理");
    await expect(page.getByText(/OpenClaw execution/)).not.toBeVisible();
    await expect(page.getByText("直接证据")).not.toBeVisible();
    await expect(page.getByText("能力缺口")).not.toBeVisible();
    await expect(page.locator("body")).not.toContainText(rawDingTalkCid);
    await expect(page.getByLabel("来源 Runtime")).toHaveCount(0);

    await reviewCard.click();
    const detail = page.getByRole("complementary", { name: "任务详情" });
    await expect(detail).toContainText("Channel: DingTalk");
    await expect(detail).toContainText("发起人: PMO");
    await expect(detail).toContainText("承接 Agent: main");
    await expect(detail).toContainText("会话/群组: DingTalk 群聊");
    await expect(detail).toContainText("任务状态: 待处理");
    await expect(detail).not.toContainText(rawDingTalkCid);
    await expect(detail).not.toContainText("来源 Runtime:");
    await expect(detail).not.toContainText("执行状态:");

    await page.getByPlaceholder("搜索任务、消息、发起人、Agent 或会话/群组").fill("merge_requests/184");
    const longCard = page.getByRole("button", { name: /merge_requests\/184/ });
    await expect(longCard).toBeVisible();
    const longCardFits = await longCard.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    );
    expect(longCardFits).toBe(true);

    await longCard.click();
    const longDetail = page.getByRole("complementary", { name: "任务详情" });
    const longDetailFits = await longDetail.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    );
    expect(longDetailFits).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

    const pageOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(pageOverflows).toBe(false);
  });

  test("keeps the board within the viewport on laptop widths", async ({ page, request }) => {
    await seedWorkBoardData(request, backendDeviceState);

    for (const width of [768, 1185]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.getByRole("button", { name: "Runs" }).click();
      await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();

      const pageOverflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(pageOverflows).toBe(false);
    }
  });

  test("closes the mobile sidebar after selecting a route", async ({ page, request }) => {
    await seedWorkBoardData(request, backendDeviceState);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "打开主导航" }).click();
    const mobileSidebar = page.getByRole("dialog", { name: "Sidebar" });
    await expect(mobileSidebar).toBeVisible();

    await mobileSidebar.getByRole("button", { name: "Runs" }).click();

    await expect(page).toHaveURL(/\/runs$/);
    await expect(mobileSidebar).toBeHidden();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  });

  test("keeps adapter diagnostic gaps out of task cards when no tasks are available", async ({ page, request }) => {
    await seedWorkBoardData(request, { ...backendDeviceState, tasks: [] });

    await page.goto("/");
    await page.getByRole("button", { name: "Runs" }).click();

    await expect(page.getByRole("button", { name: /Slock 监听未就绪/ })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /缺少 Slock task board 或 API adapter/ })).not.toBeVisible();
    await expect(page.getByText("无匹配项").first()).toBeVisible();
    await expect(page.getByText("直接证据")).not.toBeVisible();
    await expect(page.getByText("能力缺口")).not.toBeVisible();
    await expect(page.getByLabel("来源 Runtime")).toHaveCount(0);
  });
});

async function seedWorkBoardData(
  request: APIRequestContext,
  deviceStateSnapshot: DeviceStateSnapshot,
): Promise<void> {
  const response = await request.post("/api/device-state-snapshots", {
    data: { ...deviceStateSnapshot, tasks: [] },
  });
  expect(response.ok()).toBe(true);
  for (const batch of createRuntimeTaskBatches(deviceStateSnapshot.tasks, {
    batchMaxBytes: 1_000_000,
    batchMaxTasks: 1_000,
    collectedAt: deviceStateSnapshot.collectedAt,
    deviceId: deviceStateSnapshot.device.id,
  })) {
    const batchResponse = await request.post("/api/device-task-batches", { data: batch });
    expect(batchResponse.ok()).toBe(true);
  }
}
