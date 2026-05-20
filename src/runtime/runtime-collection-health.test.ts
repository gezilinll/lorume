import { describe, expect, it } from "vitest";
import {
  collectionHealthStatusLabels,
  deriveDeviceCollectionHealth,
  type CollectionHealthIngestion,
} from "./runtime-collection-health";

const now = new Date("2026-05-12T10:00:00.000Z");

describe("runtime collection health", () => {
  it("marks a device healthy when inventory and work state were recently ingested without warnings", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("inventory", "succeeded", "2026-05-12T09:59:30.000Z"),
      ingestion("work_state", "succeeded", "2026-05-12T09:58:40.000Z", { workItems: 12 }),
    ], { now });

    expect(health.status).toBe("healthy");
    expect(health.summary).toBe("设备资产与工作态采集正常");
    expect(health.checks.map((check) => [check.id, check.status, check.label])).toEqual([
      ["inventory", "healthy", "设备资产"],
      ["work_state", "healthy", "工作态"],
    ]);
    expect(collectionHealthStatusLabels[health.status]).toBe("正常");
  });

  it("surfaces adapter warnings without treating the whole device as failed", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("inventory", "succeeded", "2026-05-12T09:59:30.000Z"),
      ingestion("work_state", "succeeded", "2026-05-12T09:58:40.000Z", { workItems: 12 }, [
        "OpenClaw conversation probe unavailable",
      ]),
    ], { now });

    expect(health.status).toBe("healthy");
    expect(health.summary).toBe("设备资产与工作态采集正常");
    expect(health.checks[1]).toMatchObject({
      id: "work_state",
      status: "healthy",
      message: "采集成功，但有 1 条警告",
      warnings: ["OpenClaw conversation probe unavailable"],
    });
  });

  it("keeps old successful ingestions normal because recency is shown as data, not a status", () => {
    const health = deriveDeviceCollectionHealth("gezilinll-claw", [
      ingestion("inventory", "succeeded", "2026-05-12T09:50:00.000Z"),
      ingestion("work_state", "succeeded", "2026-05-12T09:59:00.000Z"),
    ], { now, staleAfterMs: 5 * 60 * 1000 });

    expect(health.status).toBe("healthy");
    expect(health.summary).toBe("设备资产与工作态采集正常");
    expect(health.checks[0]).toMatchObject({
      id: "inventory",
      status: "healthy",
      message: "采集正常",
    });
    expect(Object.values(collectionHealthStatusLabels)).not.toContain("采集过期");
    expect(Object.values(collectionHealthStatusLabels)).not.toContain("未知");
  });

  it("marks failed or missing snapshot types as collection exceptions", () => {
    const health = deriveDeviceCollectionHealth("broken-device", [
      ingestion("inventory", "failed", "2026-05-12T09:59:30.000Z", {}, [], "invalid runtime inventory snapshot"),
    ], { now });

    expect(health.status).toBe("failed");
    expect(health.summary).toBe("设备资产采集失败");
    expect(health.checks).toEqual([
      expect.objectContaining({
        id: "inventory",
        status: "failed",
        message: "采集失败",
        error: "invalid runtime inventory snapshot",
      }),
      expect.objectContaining({
        id: "work_state",
        status: "failed",
        message: "尚未收到采集记录",
      }),
    ]);
  });
});

function ingestion(
  snapshotType: CollectionHealthIngestion["snapshotType"],
  status: CollectionHealthIngestion["status"],
  receivedAt: string,
  counts: Record<string, number> = {},
  warnings: string[] = [],
  error: string | null = null,
): CollectionHealthIngestion {
  return {
    counts,
    deviceId: "gezilinll-claw",
    error,
    observedAt: receivedAt,
    receivedAt,
    snapshotType,
    status,
    warnings,
  };
}
