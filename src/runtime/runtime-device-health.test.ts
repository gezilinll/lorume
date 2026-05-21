import { describe, expect, it } from "vitest";
import { deriveDeviceHealthStatus } from "./runtime-device-health";

const now = new Date("2026-05-21T09:00:00.000Z");

describe("deriveDeviceHealthStatus", () => {
  it("returns syncing before the first successful device-state collection when no explicit error exists", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:59:30.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
      },
      deviceStateIngestions: [],
    })).toMatchObject({
      status: "syncing",
      label: "同步中",
      reason: "first_sync_pending",
    });
  });

  it("returns online when heartbeat and device-state collection are fresh", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:45.000Z",
      },
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "succeeded",
        observedAt: "2026-05-21T08:59:30.000Z",
        receivedAt: "2026-05-21T08:59:35.000Z",
        counts: { devices: 1 },
        warnings: [],
      }],
    })).toMatchObject({
      status: "online",
      label: "在线",
      reason: "heartbeat_and_device_state_fresh",
    });
  });

  it("returns offline when previous device-state collection succeeded but freshness expired", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "stale",
        connectedAt: "2026-05-21T08:00:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:40:00.000Z",
      },
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "succeeded",
        observedAt: "2026-05-21T08:40:00.000Z",
        receivedAt: "2026-05-21T08:40:10.000Z",
        counts: { devices: 1 },
        warnings: [],
      }],
    })).toMatchObject({
      status: "offline",
      label: "离线",
      reason: "device_state_or_heartbeat_stale",
    });
  });

  it("returns abnormal for the latest failed device-state collection", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
      },
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "failed",
        observedAt: "2026-05-21T08:59:30.000Z",
        receivedAt: "2026-05-21T08:59:35.000Z",
        counts: {},
        warnings: [],
        error: "invalid device state snapshot",
      }],
    })).toMatchObject({
      status: "abnormal",
      label: "异常",
      reason: "last_device_state_failed",
      message: "最近一次设备状态采集失败",
    });
  });

  it("returns abnormal when a fresh connection exceeds the first sync window without device-state collection", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:55:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:50.000Z",
      },
      deviceStateIngestions: [],
    })).toMatchObject({
      status: "abnormal",
      label: "异常",
      reason: "first_sync_timeout",
    });
  });
});
