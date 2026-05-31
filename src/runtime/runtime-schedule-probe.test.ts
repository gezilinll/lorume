import { describe, expect, it } from "vitest";
import {
  createOpenClawRuntimeScheduleSnapshot,
  makeRuntimeScheduleKey,
  normalizeRuntimeScheduleProbeSnapshot,
} from "./runtime-schedule-probe";

describe("runtime schedule probe metadata", () => {
  it("normalizes runtime schedule snapshots to the minimal product contract", () => {
    const snapshot = normalizeRuntimeScheduleProbeSnapshot({
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:runtime:openclaw",
      runtimeKind: "openclaw",
      status: "succeeded",
      observedAt: "2026-05-29T08:00:00.000Z",
      schedules: [{
        sourceId: "daily-report",
        name: "Daily report",
        agentIds: ["fixture-mac:runtime:openclaw:agent:main", "", "fixture-mac:runtime:openclaw:agent:main"],
        enabled: true,
        expression: "0 9 * * *",
        timezone: "Asia/Shanghai",
        nextRunAt: "2026-05-30T01:00:00.000Z",
        lastRunAt: "2026-05-29T01:00:00.000Z",
        command: "openclaw cron list",
        raw: { shouldNotSurvive: true },
      }],
    });

    expect(snapshot).toMatchObject({
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:runtime:openclaw",
      runtimeKind: "openclaw",
      status: "succeeded",
      summary: {
        total: 1,
        enabledCount: 1,
        disabledCount: 0,
        agentCount: 1,
      },
    });
    expect(snapshot?.schedules).toEqual([{
      key: "fixture-mac:runtime:openclaw:schedule:daily-report",
      sourceId: "daily-report",
      name: "Daily report",
      agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
      enabled: true,
      expression: "0 9 * * *",
      timezone: "Asia/Shanghai",
      nextRunAt: "2026-05-30T01:00:00.000Z",
      lastRunAt: "2026-05-29T01:00:00.000Z",
    }]);
    expect(snapshot?.schedules[0]).not.toHaveProperty("command");
    expect(snapshot?.schedules[0]).not.toHaveProperty("raw");
    expect(normalizeRuntimeScheduleProbeSnapshot({ status: "installed" })).toBeNull();
  });

  it("maps OpenClaw cron list output to Runtime schedule definitions", () => {
    const snapshot = createOpenClawRuntimeScheduleSnapshot({
      deviceId: "fixture-mac",
      runtimeId: "fixture-mac:runtime:openclaw",
      observedAt: "2026-05-29T08:00:00.000Z",
      agentIdByExternalId: new Map([
        ["main", "fixture-mac:runtime:openclaw:agent:main"],
        ["qa", "fixture-mac:runtime:openclaw:agent:qa"],
      ]),
      cronJobs: [{
        id: "daily-report",
        name: "Daily report",
        agentId: "main",
        enabled: true,
        schedule: { expr: "0 9 * * *", tz: "Asia/Shanghai" },
        state: {
          nextRunAtMs: Date.parse("2026-05-30T01:00:00.000Z"),
          lastRunAtMs: Date.parse("2026-05-29T01:00:00.000Z"),
        },
      }, {
        jobId: "disabled-audit",
        title: "Disabled audit",
        agent: { id: "qa" },
        disabled: true,
        cron: "*/30 * * * *",
        timezone: "UTC",
      }],
    });

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.summary).toEqual({
      total: 2,
      enabledCount: 1,
      disabledCount: 1,
      agentCount: 2,
    });
    expect(snapshot.schedules).toEqual([
      {
        key: "fixture-mac:runtime:openclaw:schedule:daily-report",
        sourceId: "daily-report",
        name: "Daily report",
        agentIds: ["fixture-mac:runtime:openclaw:agent:main"],
        enabled: true,
        expression: "0 9 * * *",
        timezone: "Asia/Shanghai",
        nextRunAt: "2026-05-30T01:00:00.000Z",
        lastRunAt: "2026-05-29T01:00:00.000Z",
      },
      {
        key: "fixture-mac:runtime:openclaw:schedule:disabled-audit",
        sourceId: "disabled-audit",
        name: "Disabled audit",
        agentIds: ["fixture-mac:runtime:openclaw:agent:qa"],
        enabled: false,
        expression: "*/30 * * * *",
        timezone: "UTC",
      },
    ]);
  });

  it("builds stable schedule keys without leaking raw adapter ids into route structure", () => {
    expect(makeRuntimeScheduleKey("runtime/openclaw", "cron:daily/report")).toBe("runtime/openclaw:schedule:cron-daily-report");
  });
});
