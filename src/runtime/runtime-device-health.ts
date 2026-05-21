import type { CollectionHealthIngestion } from "./runtime-collection-health";

export type DeviceHealthStatus = "syncing" | "online" | "offline" | "abnormal";

export type DeviceHealthReason =
  | "first_sync_pending"
  | "first_sync_timeout"
  | "heartbeat_and_device_state_fresh"
  | "device_state_or_heartbeat_stale"
  | "last_device_state_failed"
  | "control_error";

export interface DeviceHealthConnection {
  deviceId: string;
  status: "online" | "stale" | "offline";
  connectedAt?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
}

export interface DeviceHealthStatusInput {
  deviceId: string;
  now: Date;
  connection?: DeviceHealthConnection | null;
  deviceStateIngestions: CollectionHealthIngestion[];
  firstSyncWindowMs?: number;
  heartbeatFreshMs?: number;
  deviceStateFreshMs?: number;
}

export interface DeviceHealthStatusResult {
  deviceId: string;
  status: DeviceHealthStatus;
  label: "同步中" | "在线" | "离线" | "异常";
  reason: DeviceHealthReason;
  message: string;
  lastHeartbeatAt?: string;
  lastDeviceStateSuccessAt?: string;
  lastDeviceStateFailureAt?: string;
}

const defaultFirstSyncWindowMs = 120_000;
const defaultHeartbeatFreshMs = 90_000;
const defaultDeviceStateFreshMs = 300_000;

const labels: Record<DeviceHealthStatus, DeviceHealthStatusResult["label"]> = {
  syncing: "同步中",
  online: "在线",
  offline: "离线",
  abnormal: "异常",
};

/** Derive the user-visible Device status from connection freshness and device-state ingestion only. */
export function deriveDeviceHealthStatus(input: DeviceHealthStatusInput): DeviceHealthStatusResult {
  const firstSyncWindowMs = input.firstSyncWindowMs ?? defaultFirstSyncWindowMs;
  const heartbeatFreshMs = input.heartbeatFreshMs ?? defaultHeartbeatFreshMs;
  const deviceStateFreshMs = input.deviceStateFreshMs ?? defaultDeviceStateFreshMs;
  const latestDeviceState = latestDeviceStateIngestion(input.deviceStateIngestions);
  const latestSuccess = latestSucceededDeviceState(input.deviceStateIngestions);
  const lastHeartbeatAt = input.connection?.lastHeartbeatAt;

  if (input.connection?.lastError) {
    return result(input, "abnormal", "control_error", "设备连接出现异常", {
      lastHeartbeatAt,
      lastDeviceStateSuccessAt: receivedAt(latestSuccess),
      lastDeviceStateFailureAt: latestDeviceState?.status === "failed" ? receivedAt(latestDeviceState) : undefined,
    });
  }

  if (latestDeviceState?.status === "failed") {
    return result(input, "abnormal", "last_device_state_failed", "最近一次设备状态采集失败", {
      lastHeartbeatAt,
      lastDeviceStateSuccessAt: receivedAt(latestSuccess),
      lastDeviceStateFailureAt: receivedAt(latestDeviceState),
    });
  }

  if (!latestSuccess) {
    if (isFirstSyncTimedOut(input.connection?.connectedAt, input.now, firstSyncWindowMs)) {
      return result(input, "abnormal", "first_sync_timeout", "设备连接后仍未完成首次同步", {
        lastHeartbeatAt,
      });
    }
    return result(input, "syncing", "first_sync_pending", "等待设备完成首次同步", {
      lastHeartbeatAt,
    });
  }

  const heartbeatFresh = isFresh(lastHeartbeatAt, input.now, heartbeatFreshMs);
  const deviceStateFresh = isFresh(receivedAt(latestSuccess), input.now, deviceStateFreshMs);
  if (heartbeatFresh && deviceStateFresh) {
    return result(input, "online", "heartbeat_and_device_state_fresh", "设备在线且采集正常", {
      lastHeartbeatAt,
      lastDeviceStateSuccessAt: receivedAt(latestSuccess),
    });
  }

  return result(input, "offline", "device_state_or_heartbeat_stale", "设备最近未保持在线同步", {
    lastHeartbeatAt,
    lastDeviceStateSuccessAt: receivedAt(latestSuccess),
  });
}

function result(
  input: DeviceHealthStatusInput,
  status: DeviceHealthStatus,
  reason: DeviceHealthReason,
  message: string,
  times: Pick<DeviceHealthStatusResult, "lastHeartbeatAt" | "lastDeviceStateSuccessAt" | "lastDeviceStateFailureAt"> = {},
): DeviceHealthStatusResult {
  return {
    deviceId: input.deviceId,
    status,
    label: labels[status],
    reason,
    message,
    ...times,
  };
}

function latestDeviceStateIngestion(ingestions: CollectionHealthIngestion[]): CollectionHealthIngestion | undefined {
  return ingestions
    .filter((ingestion) => ingestion.snapshotType === "device_state")
    .sort((left, right) => Date.parse(receivedAt(right) ?? "") - Date.parse(receivedAt(left) ?? ""))[0];
}

function latestSucceededDeviceState(ingestions: CollectionHealthIngestion[]): CollectionHealthIngestion | undefined {
  return ingestions
    .filter((ingestion) => ingestion.snapshotType === "device_state" && ingestion.status === "succeeded")
    .sort((left, right) => Date.parse(receivedAt(right) ?? "") - Date.parse(receivedAt(left) ?? ""))[0];
}

function receivedAt(ingestion: CollectionHealthIngestion | undefined): string | undefined {
  if (!ingestion) return undefined;
  const value = ingestion.receivedAt;
  return value instanceof Date ? value.toISOString() : value;
}

function isFresh(value: string | undefined, now: Date, maxAgeMs: number): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp <= maxAgeMs;
}

function isFirstSyncTimedOut(
  connectedAt: string | undefined,
  now: Date,
  firstSyncWindowMs: number,
): boolean {
  if (!connectedAt) return false;
  const timestamp = Date.parse(connectedAt);
  if (!Number.isFinite(timestamp)) return false;
  return now.getTime() - timestamp > firstSyncWindowMs;
}
