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
    await expect(page.getByText("查看 Agent 承接的会话任务、发起人、Channel、会话/群组、消息摘要和当前状态。")).toHaveCount(0);
    const sidebarBox = await page.locator('[data-slot="sidebar-container"]').boundingBox();
    expect(sidebarBox?.width ?? 0).toBeLessThanOrEqual(224);
    for (const lane of ["待处理", "进行中", "待验收", "已完成", "需关注", "已取消"]) {
      await expect(page.getByRole("heading", { name: lane })).toBeVisible();
    }
    for (const removedLane of ["阻塞", "失败", "未知"]) {
      await expect(page.getByRole("heading", { name: removedLane })).toHaveCount(0);
    }
    await expect(page.getByLabel("任务概览")).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "状态" })).toHaveCount(0);
    await page.getByRole("button", { name: "筛选" }).click();
    await expect(page.getByRole("combobox", { name: "渠道" })).toContainText("全部");
    await page.getByRole("combobox", { name: "渠道" }).click();
    await expect(page.getByRole("option", { name: "DingTalk（3）" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("开始时间")).toHaveCount(1);
    await expect(page.getByLabel("结束时间")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /选择时间范围/ })).toHaveCount(0);

    const searchBox = await page.getByPlaceholder("搜索任务、消息、发起人、Agent 或会话/群组").boundingBox();
    const filterButtonBox = await page.getByRole("button", { name: "筛选" }).boundingBox();
    expect(searchBox?.width ?? 0).toBeGreaterThan(300);
    expect(filterButtonBox?.x ?? 0).toBeGreaterThan(searchBox?.x ?? 0);
    await page.keyboard.press("Escape");

    const boardScroll = page.getByLabel("任务泳道");
    const boardBox = await boardScroll.boundingBox();
    expect((boardBox?.y ?? 0) + (boardBox?.height ?? 0)).toBeLessThanOrEqual((page.viewportSize()?.height ?? 900) - 8);
    const pageHasVerticalScroll = await page.evaluate(
      () => (document.scrollingElement?.scrollHeight ?? 0) > window.innerHeight + 1,
    );
    expect(pageHasVerticalScroll).toBe(false);

    await expect(page.getByRole("button", { name: /PMO asked OpenClaw/ })).toBeVisible();
    const todoLane = page.getByRole("region", { name: "待处理泳道" });
    await expect(todoLane.getByRole("button", { name: /PMO asked OpenClaw/ })).toBeVisible();
    await expect(todoLane.getByRole("button", { name: /Execute OpenClaw run/ })).toHaveCount(0);
    const todoLaneBox = await page.locator('[data-lane-key="todo"]').boundingBox();
    expect(todoLaneBox?.width ?? 0).toBeGreaterThanOrEqual(260);
    expect(todoLaneBox?.width ?? 0).toBeLessThanOrEqual(300);
    expect(todoLaneBox?.height ?? 0).toBeGreaterThanOrEqual((page.viewportSize()?.height ?? 900) - 210);

    await page.getByRole("button", { name: "筛选" }).click();
    await page.getByLabel("开始时间").fill("2026-05-08T00:00");
    await page.getByLabel("结束时间").fill("2026-05-10T23:59");
    await expect(page.getByRole("button", { name: /PMO asked OpenClaw/ })).toBeVisible();
    await page.getByLabel("开始时间").fill("2026-05-10T00:00");
    await page.getByLabel("结束时间").fill("2026-05-10T23:59");
    await expect(page.getByRole("button", { name: /PMO asked OpenClaw/ })).not.toBeVisible();
    await page.getByLabel("开始时间").fill("");
    await page.getByLabel("结束时间").fill("");
    await page.keyboard.press("Escape");

    await page.getByPlaceholder("搜索任务、消息、发起人、Agent 或会话/群组").fill("PMO");
    const reviewCard = page.getByRole("button", { name: /PMO asked OpenClaw/ });
    const reviewCardSurface = page.locator('[data-view="mail-list-item"]').filter({ hasText: "PMO asked OpenCl..." }).first();
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard).not.toContainText("待处理");
    await expect(reviewCard).toContainText("main");
    await expect(reviewCard).toContainText("PMO asked OpenCl...");
    await expect(reviewCard).toContainText("The handoff is ready for review.");
    await expect(reviewCard).toContainText("DingTalk");
    await expect(reviewCard).not.toContainText("DingTalk 群聊");
    await expect(reviewCard).not.toContainText("未关联执行");
    await expect(page.getByText(/OpenClaw execution/)).not.toBeVisible();
    await expect(page.getByText("直接证据")).not.toBeVisible();
    await expect(page.getByText("能力缺口")).not.toBeVisible();
    await expect(page.locator("body")).not.toContainText(rawDingTalkCid);
    await expect(page.getByLabel("来源 Runtime")).toHaveCount(0);

    await reviewCardSurface.hover();
    await expect.poll(async () => reviewCardSurface.evaluate((element) => window.getComputedStyle(element).boxShadow), {
      message: "task card hover should apply the subtle spotlight depth",
    }).toContain("24px");
    const hoverStyle = await reviewCardSurface.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        boxShadow: style.boxShadow,
        spotlight: element.getAttribute("data-spotlight"),
        rotate: style.rotate,
        transform: style.transform,
        translate: style.translate,
      };
    });
    expect(hoverStyle.spotlight).toBe("task-card");
    expect([hoverStyle.transform, hoverStyle.translate, hoverStyle.rotate].some((value) => value && value !== "none")).toBe(true);
    expect(hoverStyle.boxShadow).not.toBe("none");
    expect(hoverStyle.boxShadow).toContain("24px");

    await reviewCard.click();
    await expect(reviewCardSurface).toHaveAttribute("data-state", "idle");
    const detail = page.getByRole("dialog", { name: /PMO asked OpenClaw/ });
    await expect(detail).toHaveAttribute("data-surface", "task-detail");
    await expect(detail).toHaveAttribute("data-depth", "modal-3d");
    await expect(detail).toHaveAttribute("data-layout", "task-detail-simple");
    const detailBox = await detail.boundingBox();
    expect(detailBox?.width ?? 0).toBeGreaterThanOrEqual(600);
    expect(detailBox?.width ?? 0).toBeLessThanOrEqual(680);
    expect(Math.abs(((detailBox?.x ?? 0) + (detailBox?.width ?? 0) / 2) - (page.viewportSize()?.width ?? 1440) / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(((detailBox?.y ?? 0) + (detailBox?.height ?? 0) / 2) - (page.viewportSize()?.height ?? 900) / 2)).toBeLessThanOrEqual(2);
    const detailPlane = detail.locator('[data-depth-plane="true"]');
    const detailDepthStyle = await detail.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.right + 320,
        clientY: rect.bottom + 240,
      }));
      const plane = element.querySelector<HTMLElement>('[data-depth-plane="true"]');
      const planeStyle = plane ? window.getComputedStyle(plane) : null;
      const style = window.getComputedStyle(element);
      return {
        planeTransform: planeStyle?.transform ?? "",
        planeTransformStyle: planeStyle?.transformStyle ?? "",
        scale: style.getPropertyValue("--detail-scale"),
      };
    });
    await expect(detailPlane).toBeVisible();
    expect(detailDepthStyle.scale.trim()).toBe("1.015");
    expect(detailDepthStyle.planeTransformStyle).toBe("preserve-3d");
    expect(detailDepthStyle.planeTransform).toContain("matrix3d");
    await expect(detail).toContainText("任务信息");
    await expect(detail).toContainText("渠道");
    await expect(detail).toContainText("DingTalk");
    await expect(detail).toContainText("发起人");
    await expect(detail).toContainText("PMO");
    await expect(detail).toContainText("承接 Agent");
    await expect(detail).toContainText("main");
    await expect(detail).toContainText("更新时间");
    await expect(detail).toContainText("用户消息");
    await expect(detail).toContainText("Agent 回复");
    await expect(detail).not.toContainText("会话/群组");
    await expect(detail).not.toContainText("任务状态");
    await expect(detail).not.toContainText("未关联执行");
    await expect(detail).not.toContainText("采集来源");
    await expect(detail).not.toContainText(rawDingTalkCid);
    await expect(detail).not.toContainText("来源 Runtime:");
    await expect(detail).not.toContainText("执行状态:");
    await detail.getByRole("button", { name: /关闭|Close/i }).click();

    await page.getByPlaceholder("搜索任务、消息、发起人、Agent 或会话/群组").fill("merge_requests/184");
    const longCard = page.getByRole("button", { name: /merge_requests\/184/ });
    await expect(longCard).toBeVisible();
    const longCardFits = await longCard.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    );
    expect(longCardFits).toBe(true);

    await longCard.click();
    const longDetail = page.locator('[data-surface="task-detail"]');
    const longDetailFits = await longDetail.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    );
    expect(longDetailFits).toBe(true);
    await longDetail.getByRole("button", { name: /关闭|Close/i }).click();

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
    await expect(page.getByText("当前筛选条件下没有会话任务").first()).toBeVisible();
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
