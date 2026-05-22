import { describe, expect, it } from "vitest";
import {
  collectionHealthStatusLabels,
  deriveDeviceCollectionHealth,
  type CollectionHealthIngestion,
} from "./runtime-collection-health";

const now = new Date("2026-05-12T10:00:00.000Z");

describe("runtime collection health", () => {
  it("marks a device healthy when device state was ingested without diagnostics", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("device_state", "succeeded", "2026-05-12T09:59:30.000Z", {
        agents: 1,
        devices: 1,
        runtimes: 1,
        tasks: 2,
      }),
    ], { now });

    expect(health.status).toBe("healthy");
    expect(health.summary).toBe("设备状态采集正常");
    expect(health.checks.map((check) => [check.id, check.status, check.label])).toEqual([
      ["device_state", "healthy", "设备状态"],
    ]);
    expect(collectionHealthStatusLabels[health.status]).toBe("正常");
  });

  it("surfaces adapter warning diagnostics without treating the whole device as failed", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("device_state", "succeeded", "2026-05-12T09:58:40.000Z", { tasks: 12 }, [{
        code: "openclaw_missing_dingtalk_inbound_context",
        count: 3,
        message: "3 条 OpenClaw DingTalk 会话任务缺少用户消息上下文，已跳过。",
        severity: "warning",
        source: "openclaw",
      }]),
    ], { now });

    expect(health.status).toBe("healthy");
    expect(health.summary).toBe("设备状态采集正常");
    expect(health.checks[0]).toMatchObject({
      id: "device_state",
      status: "healthy",
      message: "采集成功，但有 3 条数据质量提示",
      diagnostics: [{
        code: "openclaw_missing_dingtalk_inbound_context",
        count: 3,
        message: "3 条 OpenClaw DingTalk 会话任务缺少用户消息上下文，已跳过。",
        severity: "warning",
        source: "openclaw",
      }],
    });
  });

  it("does not turn debug diagnostics into warning messages", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("device_state", "succeeded", "2026-05-12T09:58:40.000Z", { tasks: 12 }, [{
        code: "openclaw_internal_heartbeat_ignored",
        count: 456,
        message: "456 条 OpenClaw 内部心跳记录已过滤。",
        severity: "debug",
        source: "openclaw",
      }]),
    ], { now });

    expect(health.status).toBe("healthy");
    expect(health.checks[0]).toMatchObject({
      id: "device_state",
      message: "采集正常",
      diagnostics: [expect.objectContaining({
        code: "openclaw_internal_heartbeat_ignored",
        count: 456,
        severity: "debug",
      })],
    });
  });

  it("uses unified device-state ingestion as the current collection health source", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("device_state", "succeeded", "2026-05-12T09:59:30.000Z", {
        agents: 1,
        devices: 1,
        runtimes: 1,
        tasks: 2,
      }),
    ], { now });

    expect(health.status).toBe("healthy");
    expect(health.summary).toBe("设备状态采集正常");
    expect(health.checks).toEqual([
      expect.objectContaining({
        counts: { agents: 1, devices: 1, runtimes: 1, tasks: 2 },
        id: "device_state",
        label: "设备状态",
        message: "采集正常",
        status: "healthy",
        diagnostics: [],
      }),
    ]);
  });

  it("keeps old successful device-state ingestions normal because recency is shown as data, not a status", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("device_state", "succeeded", "2026-05-12T09:50:00.000Z"),
    ], { now, staleAfterMs: 5 * 60 * 1000 });

    expect(health.status).toBe("healthy");
    expect(health.summary).toBe("设备状态采集正常");
    expect(health.checks[0]).toMatchObject({
      id: "device_state",
      status: "healthy",
      message: "采集正常",
      diagnostics: [],
    });
    expect(Object.values(collectionHealthStatusLabels)).not.toContain("采集过期");
    expect(Object.values(collectionHealthStatusLabels)).not.toContain("未知");
  });

  it("marks failed or missing snapshot types as collection exceptions", () => {
    const health = deriveDeviceCollectionHealth("broken-device", [
      ingestion("device_state", "failed", "2026-05-12T09:59:30.000Z", {}, [], "invalid device state snapshot"),
    ], { now });

    expect(health.status).toBe("failed");
    expect(health.summary).toBe("设备状态采集失败");
    expect(health.checks).toEqual([
      expect.objectContaining({
        id: "device_state",
        status: "failed",
        message: "采集失败",
        error: "invalid device state snapshot",
      }),
    ]);
  });
});

function ingestion(
  snapshotType: CollectionHealthIngestion["snapshotType"],
  status: CollectionHealthIngestion["status"],
  receivedAt: string,
  counts: Record<string, number> = {},
  diagnostics: CollectionHealthIngestion["diagnostics"] = [],
  error: string | null = null,
): CollectionHealthIngestion {
  return {
    counts,
    deviceId: "gezilinll-claw",
    error,
    collectedAt: receivedAt,
    receivedAt,
    snapshotType: snapshotType as CollectionHealthIngestion["snapshotType"],
    status,
    diagnostics,
  };
}
