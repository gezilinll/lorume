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
        collectedAt: "2026-05-21T08:59:30.000Z",
        receivedAt: "2026-05-21T08:59:35.000Z",
        counts: { devices: 1 },
        diagnostics: [],
      }],
    })).toMatchObject({
      status: "online",
      label: "在线",
      reason: "device_state_fresh",
    });
  });

  it("keeps a device online when the control heartbeat is missing but device-state is fresh", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: null,
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "succeeded",
        collectedAt: "2026-05-21T08:58:30.000Z",
        receivedAt: "2026-05-21T08:59:00.000Z",
        counts: { devices: 1 },
        diagnostics: [],
      }],
    })).toMatchObject({
      status: "online",
      reason: "device_state_fresh",
    });
  });

  it("keeps a device online after missed heartbeat intervals when device-state is fresh", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "online",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:59:15.000Z",
      },
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "succeeded",
        collectedAt: "2026-05-21T08:58:30.000Z",
        receivedAt: "2026-05-21T08:59:00.000Z",
        counts: { devices: 1 },
        diagnostics: [],
      }],
    })).toMatchObject({
      status: "online",
      reason: "device_state_fresh",
    });
  });

  it("returns offline, not error, after device-state freshness expires", () => {
    expect(deriveDeviceHealthStatus({
      deviceId: "device-a",
      now,
      connection: {
        deviceId: "device-a",
        status: "stale",
        connectedAt: "2026-05-21T08:50:00.000Z",
        lastHeartbeatAt: "2026-05-21T08:58:00.000Z",
      },
      deviceStateIngestions: [{
        deviceId: "device-a",
        snapshotType: "device_state",
        status: "succeeded",
        collectedAt: "2026-05-21T08:40:30.000Z",
        receivedAt: "2026-05-21T08:41:00.000Z",
        counts: { devices: 1 },
        diagnostics: [],
      }],
    })).toMatchObject({
      status: "offline",
      reason: "device_state_or_heartbeat_stale",
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
        collectedAt: "2026-05-21T08:40:00.000Z",
        receivedAt: "2026-05-21T08:40:10.000Z",
        counts: { devices: 1 },
        diagnostics: [],
      }],
    })).toMatchObject({
      status: "offline",
      label: "离线",
      reason: "device_state_or_heartbeat_stale",
    });
  });

  it("returns error for the latest failed device-state collection", () => {
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
        collectedAt: "2026-05-21T08:59:30.000Z",
        receivedAt: "2026-05-21T08:59:35.000Z",
        counts: {},
        diagnostics: [],
        error: "invalid device state snapshot",
      }],
    })).toMatchObject({
      status: "error",
      label: "异常",
      reason: "last_device_state_failed",
      message: "最近一次设备状态采集失败",
    });
  });

  it("returns error when a fresh connection exceeds the first sync window without device-state collection", () => {
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
      status: "error",
      label: "异常",
      reason: "first_sync_timeout",
    });
  });
});
