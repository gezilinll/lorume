import { describe, expect, it } from "vitest";
import {
  countActiveScheduledTaskFilters,
  filterRuntimeScheduledTaskGroups,
  runtimeScheduledTaskExecutionsFromResponse,
  runtimeScheduledTasksFromResponse,
  scheduledTaskNeedsAttention,
} from "./runtime-scheduled-task-query";

describe("runtime scheduled task query adapter", () => {
  it("normalizes scheduled task groups and fills status counts", () => {
    const result = runtimeScheduledTasksFromResponse({
      items: [{
        agentIds: ["runtime:agent:main"],
        agentNames: ["main"],
        enabled: true,
        executionCount: 3,
        expression: "*/5 * * * *",
        latestExecutionAt: "2026-05-29T23:44:02.116Z",
        latestStatus: "failed",
        name: "Argus 巡检",
        runtimeId: "device:runtime:openclaw",
        runtimeKind: "openclaw",
        runtimeName: "OpenClaw Gateway",
        scheduleKey: "device:runtime:openclaw:schedule:cron-1",
        sourceId: "cron-1",
        summary: { byStatus: { failed: 2, done: 1, total: 3 } },
        timezone: "Asia/Shanghai",
      }],
      summary: { disabledCount: 0, enabledCount: 1, total: 1 },
      total: 1,
    });

    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({
      enabled: true,
      executionCount: 3,
      latestExecutionAt: "2026-05-29T23:44:02.116Z",
      latestStatus: "failed",
      name: "Argus 巡检",
      runtimeName: "OpenClaw Gateway",
    });
    expect(result?.items[0].summary.byStatus.failed).toBe(2);
    expect(result?.items[0].summary.byStatus.todo).toBe(0);
    expect(result?.summary.enabledCount).toBe(1);
  });

  it("filters by search, Runtime, Agent, enabled state and latest status", () => {
    const result = runtimeScheduledTasksFromResponse({
      items: [
        {
          agentIds: ["agent-main"],
          agentNames: ["main"],
          enabled: true,
          executionCount: 1,
          latestStatus: "done",
          name: "日报",
          runtimeId: "runtime-openclaw",
          runtimeKind: "openclaw",
          runtimeName: "OpenClaw Gateway",
          scheduleKey: "runtime-openclaw:schedule:daily",
          sourceId: "daily",
          summary: { byStatus: { done: 1, total: 1 } },
        },
        {
          agentIds: ["agent-codex"],
          agentNames: ["Codex"],
          enabled: false,
          executionCount: 1,
          latestStatus: "failed",
          name: "失败巡检",
          runtimeId: "runtime-codex",
          runtimeKind: "codex",
          runtimeName: "Codex",
          scheduleKey: "runtime-codex:schedule:failed",
          sourceId: "failed",
          summary: { byStatus: { failed: 1, total: 1 } },
        },
      ],
      summary: { disabledCount: 1, enabledCount: 1, total: 2 },
      total: 2,
    });

    expect(filterRuntimeScheduledTaskGroups(result?.items ?? [], { search: "openclaw" }).map((item) => item.name)).toEqual(["日报"]);
    expect(filterRuntimeScheduledTaskGroups(result?.items ?? [], { runtimeId: "runtime-codex" }).map((item) => item.name)).toEqual(["失败巡检"]);
    expect(filterRuntimeScheduledTaskGroups(result?.items ?? [], { agentId: "agent-main" }).map((item) => item.name)).toEqual(["日报"]);
    expect(filterRuntimeScheduledTaskGroups(result?.items ?? [], { enabled: "disabled", status: "failed" }).map((item) => item.name)).toEqual(["失败巡检"]);
    expect(scheduledTaskNeedsAttention(result?.items[1]!)).toBe(true);
    expect(countActiveScheduledTaskFilters({ agentId: "agent-main", enabled: "enabled", search: "日报" })).toBe(2);
  });

  it("normalizes execution rows without exposing unknown records", () => {
    const result = runtimeScheduledTaskExecutionsFromResponse({
      items: [
        {
          adapter: { kind: "openclaw" },
          agentId: "agent-main",
          agentReply: "完成",
          id: "task-1",
          status: "done",
          taskType: "scheduled",
          updatedAt: "2026-05-29T23:44:02.116Z",
          userMessage: "[cron:daily 日报] 生成日报",
        },
        { id: "bad", status: "not-real" },
      ],
      summary: { byStatus: { done: 1, total: 1 }, total: 1 },
      total: 2,
    });

    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({
      agentReply: "完成",
      status: "done",
      taskType: "scheduled",
    });
    expect(result?.summary.byStatus.done).toBe(1);
  });
});
